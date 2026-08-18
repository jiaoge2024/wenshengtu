const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
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

  const savedPaths = [];
  for (let index = 0; index < images.length; index += 1) {
    const source = images[index];
    try {
      const image = await imageSourceToBuffer(source);
      const extension = getImageExtension(image.mimeType);
      const filename = `${recordId}-${String(index + 1).padStart(2, "0")}${extension}`;
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
        const record = await saveRecordToDisk(body.record || body);
        sendJson(res, 200, { ok: true, record });
        return;
      }

      if (req.method === "POST" && pathname === "/api/image-studio/delete") {
        const body = await readBody(req);
        const recordIds = Array.isArray(body.ids) && body.ids.length > 0
          ? body.ids
          : [body.id || body.recordId];
        const result = await deleteImageRecords(recordIds);
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
