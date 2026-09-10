const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const { exec } = require("child_process");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const LIBRARY_DIR = path.join(ROOT_DIR, "generated-images");
const INDEX_PATH = path.join(LIBRARY_DIR, "index.json");
const DEFAULT_PORT = Number(process.env.IMAGE_STUDIO_PORT || 3211);
const MAX_BODY_SIZE = 60 * 1024 * 1024;
const MAX_RECORDS = 200;
const PROXY_TIMEOUT_MS = 5 * 60 * 1000; // 代理请求超时 5 分钟

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4"
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function ensureLibrary() {
  await fsp.mkdir(LIBRARY_DIR, { recursive: true });
  try {
    await fsp.access(INDEX_PATH);
  } catch (error) {
    await fsp.writeFile(INDEX_PATH, "[]", "utf8");
  }
}

async function readIndex() {
  await ensureLibrary();
  try {
    const raw = await fsp.readFile(INDEX_PATH, "utf8");
    const records = JSON.parse(raw);
    return Array.isArray(records) ? records : [];
  } catch (error) {
    return [];
  }
}

async function writeIndex(records) {
  await ensureLibrary();
  const snapshot = Array.isArray(records) ? records.slice(0, MAX_RECORDS) : [];
  await fsp.writeFile(INDEX_PATH, JSON.stringify(snapshot, null, 2), "utf8");
}

function getDateFolder(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getImageExtension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("mp4")) {
    return ".mp4";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return ".jpg";
  }
  if (normalized.includes("webp")) {
    return ".webp";
  }
  if (normalized.includes("gif")) {
    return ".gif";
  }
  return ".png";
}

function normalizeRecordId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function normalizeImageSource(source) {
  return String(source || "").trim();
}

async function imageSourceToBuffer(source) {
  const normalized = normalizeImageSource(source);
  const dataUrlMatch = normalized.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      buffer: Buffer.from(dataUrlMatch[2], "base64"),
      mimeType: dataUrlMatch[1]
    };
  }

  if (/^https?:\/\//i.test(normalized)) {
    const response = await fetch(normalized);
    if (!response.ok) {
      throw new Error(`下载远程图片失败：${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: response.headers.get("content-type") || "image/png"
    };
  }

  return {
    buffer: Buffer.from(normalized, "base64"),
    mimeType: "image/png"
  };
}

/**
 * 清洗上下文提供的主题（如小红书页标题、批量生图的变量组合），使其可安全用作文件名
 * @param {string} raw 原始主题文本
 * @returns {string} 清洗后的主题片段，最多 16 个字符；无有效内容时返回空串
 */
function sanitizeTopic(raw) {
  const text = String(raw || "")
    // 文件系统非法字符与换行统一替换为空格
    .replace(/[\\/:*?"<>|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.slice(0, 16).trim();
}

/**
 * 从生图提示词中启发式提取主题：
 * 1. 去掉常见指令前缀（画一张 / 生成 / 帮我画 等）
 * 2. 按中文标点（逗号、句号、顿号、分号、感叹号、问号、换行）切分，取第一个语义段作为主题
 *    例：「一只小猫在客厅里玩耍，油画风格，高清细节」→「一只小猫在客厅里玩耍」
 * @param {string} prompt 图片提示词
 * @returns {string} 清洗后的主题片段，最多 12 个字符；无有效内容时返回空串
 */
function extractTopicSlug(prompt) {
  let text = String(prompt || "").trim();
  if (!text) return "";
  // 去掉提示词开头的指令性前缀，让主题更聚焦于内容本身
  // 注意先剥离「画风要求/风格要求」结构前缀，否则指令前缀正则会单独吃掉「画」字
  text = text
    .replace(/^\s*(画风要求|风格要求)[：:，,]?\s*/, "")
    .replace(/^\s*(请|帮我|麻烦)?(画|生成|绘制|创作)(一张|一幅|一个|张|幅)?(图片|图像|插画|照片)?[：:，,]?\s*/, "");
  // 取第一个语义段（遇到逗号/句号等即认为主题结束，后续多为风格、画质等修饰）
  const firstSegment = text.split(/[，。；！？、,;!\n]+/)[0] || text;
  return sanitizeTopic(firstSegment).slice(0, 12);
}

// 保存请求串行化队列：并行生成多张图时会同时触发保存，
// index.json 的读-改-写必须排队执行，否则并发写入会互相覆盖导致索引丢记录
let saveQueue = Promise.resolve();

/**
 * 将保存任务加入串行队列，保证同一时刻只有一个保存流程在写磁盘
 * @param {Function} task 返回 Promise 的保存任务
 * @returns {Promise} 该任务的执行结果
 */
function enqueueSave(task) {
  const run = saveQueue.then(task, task); // 前一个任务失败也不阻塞后续保存
  // 队列尾部捕获错误，避免 unhandled rejection 影响后续任务排队
  saveQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function saveRecordToDisk(record) {
  const now = Date.now();
  const recordId = normalizeRecordId(record && record.id) || `record-${now}`;
  const images = Array.isArray(record && record.images) ? record.images : [];
  if (images.length === 0) {
    throw new Error("没有可保存的图片");
  }

  const folderName = getDateFolder(record.time || now);
  const folderPath = path.join(LIBRARY_DIR, folderName);
  await fsp.mkdir(folderPath, { recursive: true });

  // 文件名命名规则：主题 + 时间戳 + 序号
  // 主题来源优先级：record.topic（上下文显式主题，如小红书页标题/批量生图变量组合）
  //              > 提示词启发式提取（第一语义段）
  const topic = sanitizeTopic(record && record.topic) || extractTopicSlug((record && (record.rawPrompt || record.prompt)) || "");
  const timestamp = new Date(record.time || now)
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\..+$/, "")
    .slice(0, 14); // 形如 20260901143025
  const topicPart = topic ? `${topic}-` : "";

  const savedPaths = [];
  for (let index = 0; index < images.length; index += 1) {
    const source = images[index];
    try {
      const image = await imageSourceToBuffer(source);
      const extension = getImageExtension(image.mimeType);
      // 同一记录有多张图时追加序号区分
      const suffix = images.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
      const filename = `${topicPart}${timestamp}${suffix}${extension}`;
      await fsp.writeFile(path.join(folderPath, filename), image.buffer);
      savedPaths.push(`/generated-images/${folderName}/${filename}`);
    } catch (error) {
      savedPaths.push(source);
    }
  }

  const savedRecord = {
    id: recordId,
    prompt: record.prompt || "",
    rawPrompt: record.rawPrompt || record.prompt || "",
    images: savedPaths,
    aspectRatio: record.aspectRatio || "",
    imageQuality: record.imageQuality || "",
    imageQualityLabel: record.imageQualityLabel || "",
    styleTemplateId: record.styleTemplateId || "",
    styleTemplateLabel: record.styleTemplateLabel || "",
    model: record.model || "",
    mode: record.mode || "text",
    modeLabel: record.modeLabel || "",
    mediaType: record.mediaType || "",
    time: Number(record.time) || now,
    generationDurationSeconds: Number.isFinite(Number(record.generationDurationSeconds)) ? Number(record.generationDurationSeconds) : null
  };

  const records = await readIndex();
  const nextRecords = [savedRecord].concat(records.filter((item) => item && item.id !== recordId));
  await writeIndex(nextRecords);
  return savedRecord;
}

async function deleteImageRecords(recordIds) {
  const ids = Array.from(new Set((Array.isArray(recordIds) ? recordIds : [recordIds]).map(normalizeRecordId).filter(Boolean)));
  const records = await readIndex();
  const nextRecords = records.filter((item) => !ids.includes(normalizeRecordId(item && item.id)));
  await writeIndex(nextRecords);
  const removedIds = records.map((item) => normalizeRecordId(item && item.id)).filter((id) => ids.includes(id));
  return {
    ok: true,
    removedIds,
    removedId: removedIds[0] || "",
    remaining: nextRecords.length
  };
}

/**
 * 用系统文件管理器打开本地图库文件夹
 * Windows: explorer / macOS: open / Linux: xdg-open
 */
function openLibraryFolder() {
  return ensureLibrary().then(() => new Promise((resolve, reject) => {
    let command;
    if (process.platform === "win32") {
      command = `explorer "${LIBRARY_DIR}"`;
    } else if (process.platform === "darwin") {
      command = `open "${LIBRARY_DIR}"`;
    } else {
      command = `xdg-open "${LIBRARY_DIR}"`;
    }
    exec(command, (error) => {
      // Windows 的 explorer 打开文件夹时即使成功也可能返回非 0 退出码，视为成功
      if (error && process.platform !== "win32") {
        reject(error);
        return;
      }
      resolve();
    });
  }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      throw new Error("请求内容过大");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/**
 * 读取系统代理设置（Windows 注册表 / 环境变量）
 * @returns {string|null} 如 "127.0.0.1:7897" 或 null
 */
function getSystemProxy() {
  // 1) 环境变量优先
  var envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
    process.env.https_proxy || process.env.http_proxy || "";
  if (envProxy) {
    // 去掉 http:// 或 https:// 前缀
    return envProxy.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }
  // 2) Windows 注册表（Clash 系统代理模式）
  try {
    var { execSync } = require("child_process");
    var enableOut = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: "utf8", timeout: 2000 }
    );
    if (!/0x1/i.test(enableOut)) return null; // 代理未启用
    var serverOut = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: "utf8", timeout: 2000 }
    );
    var match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (!match) return null;
    var raw = match[1].trim();
    // ProxyServer 可能是 "127.0.0.1:7897" 或 "http=...;https=..." 格式
    if (raw.indexOf(";") !== -1) {
      var parts = raw.split(";");
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split("=");
        if (kv[0].toLowerCase() === "https" && kv[1]) {
          return kv[1];
        }
      }
    }
    return raw || null;
  } catch (e) {
    return null;
  }
}

/**
 * 通过 HTTP CONNECT 代理隧道发起 HTTPS 请求
 * 返回与 fetch 兼容的 { ok, status, text() } 接口
 * @param {string} targetUrl
 * @param {Object} options { method, headers, body, signal }
 */
function fetchViaProxy(targetUrl, options) {
  options = options || {};
  var proxyStr = getSystemProxy();
  // 没有代理时回退到内置 fetch
  if (!proxyStr) {
    return fetch(targetUrl, options);
  }

  var parsedUrl = new URL(targetUrl);
  var proxyHost = proxyStr.split(":")[0];
  var proxyPort = parseInt(proxyStr.split(":")[1], 10) || 8080;
  var targetHost = parsedUrl.hostname;
  var targetPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;
  var targetPath = parsedUrl.pathname + parsedUrl.search;

  return new Promise(function (resolve, reject) {
    // 第一步：向代理发送 CONNECT 请求建立隧道
    var connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: targetHost + ":" + targetPort,
      headers: { Host: targetHost + ":" + targetPort },
      timeout: 15000
    });

    var settled = false;

    function onError(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    connectReq.on("connect", function (connectRes, socket) {
      if (connectRes.statusCode !== 200) {
        onError(new Error("代理 CONNECT 失败：HTTP " + connectRes.statusCode));
        return;
      }

      // 底层隧道 socket 的错误必须被监听，否则 TLS 握手失败时会产生未捕获异常导致进程崩溃
      socket.on("error", function (err) {
        onError(err instanceof Error ? err : new Error("代理隧道 socket 错误"));
      });
      socket.on("close", function () {
        if (!settled) onError(new Error("代理隧道连接已关闭"));
      });

      // 第二步：通过隧道发起 HTTPS 请求
      var reqHeaders = Object.assign({}, options.headers || {});
      if (!reqHeaders["Host"]) reqHeaders["Host"] = targetHost;

      var httpsReq = https.request({
        hostname: targetHost,
        port: targetPort,
        path: targetPath,
        method: options.method || "GET",
        headers: reqHeaders,
        socket: socket,
        servername: targetHost,
        timeout: PROXY_TIMEOUT_MS
      }, function (httpsRes) {
        var chunks = [];
        httpsRes.on("data", function (chunk) { chunks.push(chunk); });
        httpsRes.on("end", function () {
          if (settled) return;
          settled = true;
          var body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: httpsRes.statusCode >= 200 && httpsRes.statusCode < 300,
            status: httpsRes.statusCode,
            text: function () { return Promise.resolve(body); }
          });
        });
      });

      httpsReq.on("error", onError);
      httpsReq.on("timeout", function () {
        httpsReq.destroy(new Error("请求超时"));
      });

      // 如果有请求体，写入
      if (options.body && (options.method || "POST") !== "GET") {
        httpsReq.write(options.body);
      }
      httpsReq.end();

      // 外部中止信号
      if (options.signal) {
        options.signal.addEventListener("abort", function () {
          httpsReq.destroy(new Error("AbortError"));
        });
      }
    });

    connectReq.on("error", onError);
    connectReq.on("timeout", function () {
      connectReq.destroy(new Error("代理连接超时"));
    });
    connectReq.end();
  });
}

/**
 * 服务端代理处理器
 * 浏览器将外部 API 请求发到本地服务器，由服务器转发，绕过浏览器 CORS 限制
 * 自动检测系统代理（Clash/V2Ray 等）并通过 CONNECT 隧道转发
 * 请求体格式: { url, method, headers, body }
 * 响应格式: { ok, status, data }
 */
async function handleProxy(req, res) {
  const body = await readBody(req);
  const targetUrl = String(body.url || "").trim();
  const targetMethod = String(body.method || "POST").toUpperCase();
  const targetHeaders = body.headers && typeof body.headers === "object" ? body.headers : {};
  const targetBody = body.body != null ? String(body.body) : null;

  // 临时诊断日志：记录目标地址与鉴权令牌（脱敏）
  try {
    const auth = String(targetHeaders["Authorization"] || targetHeaders["authorization"] || "");
    const maskedAuth = auth ? auth.slice(0, 7) + "..." + auth.slice(-6) : "(无)";
    console.log("[proxy-diag] " + targetMethod + " " + targetUrl + " | auth=" + maskedAuth);
  } catch (e) {}

  if (!targetUrl) {
    sendJson(res, 200, { ok: false, status: 0, error: "缺少 url 参数" });
    return;
  }

  // 安全限制：仅允许 HTTPS 地址
  if (!/^https:\/\//i.test(targetUrl)) {
    sendJson(res, 200, { ok: false, status: 0, error: "仅支持 HTTPS 地址" });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  // 浏览器端中止时也中止服务端请求
  const onAbort = () => controller.abort();
  req.on("close", onAbort);

  try {
    const fetchOptions = {
      method: targetMethod,
      headers: targetHeaders,
      signal: controller.signal
    };
    if (targetBody && targetMethod !== "GET") {
      fetchOptions.body = targetBody;
    }
    // multipart：客户端传来的 base64 图片重建为 FormData（图片编辑接口上传用）
    if (body.multipart && typeof body.multipart === "object" && targetMethod !== "GET") {
      const formData = new FormData();
      const fields = body.multipart.fields && typeof body.multipart.fields === "object" ? body.multipart.fields : {};
      Object.keys(fields).forEach((key) => formData.append(key, String(fields[key])));
      const files = Array.isArray(body.multipart.files) ? body.multipart.files : [];
      files.forEach((file) => {
        const buffer = Buffer.from(String(file.base64 || ""), "base64");
        formData.append(
          String(file.field || "image"),
          new Blob([buffer], { type: String(file.contentType || "image/png") }),
          String(file.filename || "image.png")
        );
      });
      delete fetchOptions.headers["Content-Type"];
      delete fetchOptions.headers["content-type"];
      fetchOptions.body = formData;
    }

    const proxyRes = await fetchViaProxy(targetUrl, fetchOptions);
    const proxyText = await proxyRes.text();

    let proxyData;
    try {
      proxyData = JSON.parse(proxyText);
    } catch (e) {
      proxyData = { raw: proxyText };
    }

    sendJson(res, 200, {
      ok: proxyRes.ok,
      status: proxyRes.status,
      data: proxyData
    });
  } catch (proxyError) {
    const msg = proxyError && proxyError.name === "AbortError"
      ? "请求超时或已取消"
      : (proxyError && proxyError.message ? proxyError.message : "代理请求失败");
    // Node.js fetch 失败时真实原因在 cause 里（如 Connect Timeout Error、ECONNREFUSED 等）
    const cause = proxyError && proxyError.cause && proxyError.cause.message
      ? proxyError.cause.message
      : "";
    sendJson(res, 200, {
      ok: false,
      status: 0,
      error: cause ? msg + "（" + cause + "）" : msg
    });
  } finally {
    clearTimeout(timeoutId);
    req.removeListener("close", onAbort);
  }
}

function getSafeStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, normalizedPath);
  const relative = path.relative(ROOT_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return filePath;
}

async function serveStatic(req, res, pathname) {
  const filePath = getSafeStaticPath(pathname);
  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendText(res, 404, "Not Found");
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/api/image-studio/gallery") {
        const records = await readIndex();
        sendJson(res, 200, { records });
        return;
      }

      if (req.method === "POST" && pathname === "/api/image-studio/save") {
        const body = await readBody(req);
        // 串行队列执行：避免并行生成时多个保存同时读改写 index.json 互相覆盖
        const record = await enqueueSave(() => saveRecordToDisk(body.record || body));
        sendJson(res, 200, { ok: true, record });
        return;
      }

      if (req.method === "POST" && pathname === "/api/image-studio/open-folder") {
        openLibraryFolder()
          .then(() => sendJson(res, 200, { ok: true, path: LIBRARY_DIR }))
          .catch((error) => {
            console.error("[server] 打开图库文件夹失败", error);
            sendJson(res, 500, { error: "打开文件夹失败：" + (error && error.message ? error.message : "未知错误") });
          });
        return;
      }

      if (req.method === "POST" && pathname === "/api/image-studio/delete") {
        const body = await readBody(req);
        const recordIds = Array.isArray(body.ids) && body.ids.length > 0
          ? body.ids
          : [body.id || body.recordId];
        // 删除同样会写 index.json，纳入同一串行队列避免与保存竞态
        const result = await enqueueSave(() => deleteImageRecords(recordIds));
        sendJson(res, 200, result);
        return;
      }

      // 服务端代理：浏览器通过本地服务器转发请求，绕过 CORS 限制
      if (req.method === "POST" && pathname === "/api/proxy") {
        await handleProxy(req, res);
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method Not Allowed");
        return;
      }

      await serveStatic(req, res, pathname);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error && error.message ? error.message : "Server error"
      });
    }
  });
}

async function startServer(port = DEFAULT_PORT) {
  await ensureLibrary();
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (require.main === module) {
  // 全局崩溃保护：任何未被捕获的异常都不应让服务进程退出
  process.on("uncaughtException", (error) => {
    console.error("[uncaughtException]", error && error.message ? error.message : error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason && reason.message ? reason.message : reason);
  });
  startServer().then(() => {
    console.log(`Image Studio standalone running at http://127.0.0.1:${DEFAULT_PORT}`);
    console.log(`Generated images will be saved in: ${LIBRARY_DIR}`);
  }).catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  startServer,
  saveRecordToDisk,
  deleteImageRecords
};
