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
    // 文件系统非法字符与换行统一替换为空格；# 必须过滤，否则进入文件名后
    // 浏览器会把 URL 中的 # 当作锚点截断路径，导致图片 404 无法显示
    .replace(/[\\/:*?"<>|#\r\n]+/g, " ")
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

/**
 * 更新一条图库记录的 AI 标签（写入 index.json 持久化）
 * 标签清洗规则与前端 requestImageTags 保持一致：去引号/#/空白，最多 8 个
 * 调用方已将本任务纳入串行队列，不会与其他 index.json 写操作竞态
 * @param {string} recordId 记录 ID
 * @param {string[]} tags 标签数组
 */
async function updateRecordTags(recordId, tags) {
  const id = normalizeRecordId(recordId);
  if (!id) {
    return { ok: false, error: "缺少记录 ID" };
  }
  const cleanTags = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag).replace(/["#\s]+/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const records = await readIndex();
  const record = records.find((item) => normalizeRecordId(item && item.id) === id);
  if (!record) {
    return { ok: false, error: "记录不存在" };
  }
  record.tags = cleanTags;
  await writeIndex(records);
  return { ok: true, id, tags: cleanTags };
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

// ==================== 后台生图任务管理器 ====================
// 目标：生图任务的执行生命周期由本地服务持有，而不是绑定在某个浏览器页面上。
// 用户跳转到其他页面、刷新甚至关闭标签页，服务都会继续执行直到成功或失败，
// 页面回到创作台后通过任务 API 轮询恢复进度与结果。
//
// 额度保护策略（无内部额度系统时的最大努力约束）：
// 1. 已拿到供应商 task_id 的任务只轮询原任务，绝不重新提交，避免重复扣费；
// 2. 仅「未创建供应商任务且错误为瞬时网络/限流/5xx」时自动重试，每张图最多 3 次提交；
// 3. 认证失败、地址/模型错误、提示词违规、额度不足等确定性错误立即失败，不重试。

const JOB_DELAY_MS = 3000;              // 串行任务之间的间隔，防止频繁请求
const SUBMIT_MAX_ATTEMPTS = 3;          // 单张图最大提交次数（1 次原始 + 2 次瞬时重试）
const SUBMIT_RETRY_BASE_MS = 10000;     // 瞬时错误重试基础退避：10s、20s
const PROVIDER_POLL_INITIAL_DELAY = 5000;  // 异步任务首次轮询前等待
const PROVIDER_POLL_INTERVAL = 10000;      // 异步任务轮询间隔
const PROVIDER_POLL_TIMEOUT = 10 * 60 * 1000; // 异步任务最长等待 10 分钟
const MAX_JOBS_PER_REQUEST = 100;       // 单次批量提交的任务数上限

/** 内存任务表：taskId → task。不落盘（含 API Key，避免敏感信息写入磁盘） */
const generationTasks = new Map();
/** 串行执行队列：待执行 taskId 列表 */
const taskQueue = [];
let taskRunnerRunning = false;
let taskCounter = 0;

/** 与前端 getGptImageSize 等价的尺寸映射（像素格式） */
const SIZE_BY_QUALITY = {
  "1K": { "1:1": "1024x1024", "3:4": "768x1024", "4:3": "1024x768", "9:16": "576x1024", "16:9": "1024x576", "21:9": "1344x576" },
  "2K": { "1:1": "2048x2048", "3:4": "1536x2048", "4:3": "2048x1536", "9:16": "1152x2048", "16:9": "2048x1152", "21:9": "2688x1152" },
  "4K": { "1:1": "4096x4096", "3:4": "3072x4096", "4:3": "4096x3072", "9:16": "2304x4096", "16:9": "4096x2304", "21:9": "5376x2304" }
};

function normalizeQuality(quality) {
  const value = String(quality || "").toUpperCase();
  return ["1K", "2K", "4K"].includes(value) ? value : "2K";
}

function getPixelSize(aspectRatio, quality) {
  const table = SIZE_BY_QUALITY[normalizeQuality(quality)];
  return table[aspectRatio] || table["1:1"];
}

/**
 * 根据通道 Base URL 构建生图 endpoint（与前端 buildChannelEndpoint 规则一致）
 * @param {string} baseUrl 通道 Base URL
 * @returns {string} 完整生图接口地址
 */
function buildGenerationEndpoint(baseUrl) {
  let endpoint = String(baseUrl || "").replace(/\/+$/, "");
  if (!endpoint) return "";
  if (!/\/images\/generations/.test(endpoint)) {
    endpoint += /\/v1(?:[\/?#]|$)/.test(endpoint) ? "/images/generations" : "/v1/images/generations";
  }
  return endpoint;
}

/**
 * 根据通道 Base URL 构建异步任务查询 endpoint（与前端 buildTaskEndpointForModel 规则一致）
 * @param {string} baseUrl 通道 Base URL
 * @param {string} taskId 供应商任务 ID
 * @returns {string} 任务查询地址
 */
function buildProviderTaskEndpoint(baseUrl, taskId) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/images\/generations(?:[?#].*)?$/.test(normalized)) {
    return normalized.replace(/\/images\/generations(?:[?#].*)?$/, "/tasks/" + encodeURIComponent(taskId));
  }
  if (/\/v1(?:[\/?#]|$)/.test(normalized)) {
    return normalized + "/tasks/" + encodeURIComponent(taskId);
  }
  return normalized + "/v1/tasks/" + encodeURIComponent(taskId);
}

/** 归一化供应商任务状态（与前端 normalizeTaskStatus 覆盖面一致） */
function normalizeProviderTaskStatus(status) {
  return String(status || "").toLowerCase().replace(/[\s_-]+/g, "");
}

function isProviderTaskCompleted(status) {
  return ["completed", "succeeded", "success", "done"].includes(normalizeProviderTaskStatus(status));
}

function isProviderTaskFailed(status) {
  return ["failed", "error", "cancelled", "canceled"].includes(normalizeProviderTaskStatus(status));
}

/** 从同步响应中提取图片（与前端 extractSyncImageUrls 规则一致） */
function extractSyncImageUrlsSrv(data) {
  const images = [];
  if (data && Array.isArray(data.data)) {
    data.data.forEach((item) => {
      if (item && typeof item.b64_json === "string" && item.b64_json.trim()) {
        images.push("data:image/png;base64," + item.b64_json);
      } else if (item && typeof item.url === "string" && item.url.trim()) {
        images.push(item.url);
      }
    });
  }
  return images;
}

/** 从异步任务结果中提取图片（与前端 extractGptImageUrls 规则一致） */
function extractGptImageUrlsSrv(taskData) {
  const resultImages = taskData && taskData.result && Array.isArray(taskData.result.images)
    ? taskData.result.images
    : [];
  const out = [];
  const pushValue = (item) => {
    if (typeof item === "string" && item.trim()) {
      out.push(item);
    } else if (item && Array.isArray(item.b64_json)) {
      item.b64_json.forEach((d) => { if (typeof d === "string" && d.trim()) out.push("data:image/png;base64," + d); });
    } else if (item && typeof item.b64_json === "string" && item.b64_json.trim()) {
      out.push("data:image/png;base64," + item.b64_json);
    } else if (item && typeof item.url === "string" && item.url.trim()) {
      out.push(item.url);
    }
  };
  if (resultImages.length > 0) {
    resultImages.forEach(pushValue);
    return out;
  }
  // 兼容直接把 data 数组放在任务结果里的中转站
  if (taskData && Array.isArray(taskData.data)) {
    taskData.data.forEach(pushValue);
  }
  return out;
}

/**
 * 判断一次提交失败是否属于「可自动重试的瞬时错误」
 * 仅限：网络连接失败、HTTP 429 / 5xx。认证、地址、提示词、额度等确定性错误一律不重试
 * @param {number} httpStatus HTTP 状态码（0 表示网络层失败）
 * @param {string} message 错误信息
 * @returns {boolean}
 */
function isTransientSubmitFailure(httpStatus, message) {
  if (httpStatus === 429 || httpStatus >= 500) return true;
  if (httpStatus === 0) {
    return /failed to fetch|fetch failed|network|econnrefused|enotfound|eai_again|etimedout|timeout|socket|连接|超时/i.test(String(message || ""));
  }
  return false;
}

/** 从供应商错误响应中提取可读错误信息（与前端提取规则一致） */
function extractProviderErrorMessage(data, httpStatus) {
  let message = "请求失败（HTTP " + httpStatus + "）";
  if (data) {
    if (data.error && data.error.message) message = data.error.message;
    else if (typeof data.error === "string" && data.error) message = data.error;
    else if (data.message) message = data.message;
    else if (data.detail) message = data.detail;
    else if (typeof data === "string" && data) message = data;
    else {
      try { message = JSON.stringify(data).slice(0, 500); } catch (e) { /* keep default */ }
    }
  }
  return message;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 提交一张图的生图请求（不含重试），返回 { images, providerTaskId }
 * 失败时抛出带 .httpStatus / .transient / .providerTaskId 标记的错误
 * @param {Object} ch 通道配置 { type, name, baseUrl, apiKey, model, mode }
 * @param {string} finalPrompt 已组装风格模板的完整提示词
 * @param {Object} task 任务对象（用于读取 aspectRatio/imageQuality 与取消信号）
 */
async function submitSingleImageRequest(ch, finalPrompt, task) {
  const endpoint = buildGenerationEndpoint(ch.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + ch.apiKey
  };
  const signal = task.controller ? task.controller.signal : undefined;

  if (ch.type === "openai_images") {
    const callOnce = async (sizeFormat) => {
      const body = {
        model: ch.model,
        prompt: finalPrompt,
        n: 1,
        size: sizeFormat === "ratio" ? task.aspectRatio : getPixelSize(task.aspectRatio, task.imageQuality),
        resolution: normalizeQuality(task.imageQuality).toLowerCase()
      };
      return fetchViaProxy(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal });
    };

    let response, data;
    try {
      const first = await callOnce("pixels");
      response = first;
      data = JSON.parse(await first.text());
    } catch (networkError) {
      if (task.cancelRequested) { const e = new Error("任务已取消"); e.cancelled = true; throw e; }
      const e = new Error("通道「" + ch.name + "」连接失败：" + (networkError && networkError.message ? networkError.message : "未知网络错误"));
      e.httpStatus = 0;
      e.transient = true;
      throw e;
    }

    // 像素尺寸不被接受时，自动改用比例尺寸重试一次
    if (!response.ok || (data && data.code >= 400)) {
      const firstMsg = extractProviderErrorMessage(data, response.status);
      if (/invalid\s+size|expected\s+widthxheight|width\s*x\s*height|unsupported\s+size|size.*(?:format|格式)/i.test(firstMsg)) {
        try {
          const second = await callOnce("ratio");
          response = second;
          data = JSON.parse(await second.text());
        } catch (networkError) {
          if (task.cancelRequested) { const e = new Error("任务已取消"); e.cancelled = true; throw e; }
          const e = new Error("通道「" + ch.name + "」比例尺寸重试失败：" + (networkError && networkError.message ? networkError.message : "未知网络错误"));
          e.httpStatus = 0;
          e.transient = true;
          throw e;
        }
      }
    }

    if (!response.ok || (data && data.code >= 400)) {
      const e = new Error("通道「" + ch.name + "」" + extractProviderErrorMessage(data, response.status));
      e.httpStatus = response.status;
      e.transient = isTransientSubmitFailure(response.status, e.message);
      throw e;
    }

    // 异步模式：返回 task_id，由服务端继续轮询（记录 providerTaskId 后绝不再提交）
    const firstData = data && Array.isArray(data.data) ? data.data[0] : null;
    const providerTaskId = firstData && firstData.task_id;
    if (ch.mode === "async" || (ch.mode === "auto" && providerTaskId)) {
      const images = await pollProviderTask(ch, task, providerTaskId);
      return { images, providerTaskId };
    }

    const syncImages = extractSyncImageUrlsSrv(data);
    if (syncImages.length === 0) {
      const e = new Error("通道「" + ch.name + "」已返回，但没有拿到图片数据。");
      e.httpStatus = response.status;
      e.transient = false;
      throw e;
    }
    return { images: syncImages, providerTaskId: "" };
  }

  if (ch.type === "agnes") {
    const agnesEndpoint = buildGenerationEndpoint(ch.baseUrl);
    const payload = {
      model: ch.model,
      prompt: finalPrompt,
      size: normalizeQuality(task.imageQuality),
      ratio: task.aspectRatio || "1:1",
      extra_body: { response_format: "url" }
    };
    let response, data;
    try {
      response = await fetchViaProxy(agnesEndpoint, { method: "POST", headers, body: JSON.stringify(payload), signal });
      data = JSON.parse(await response.text());
    } catch (networkError) {
      if (task.cancelRequested) { const e = new Error("任务已取消"); e.cancelled = true; throw e; }
      const e = new Error("通道「" + ch.name + "」连接失败：" + (networkError && networkError.message ? networkError.message : "未知网络错误"));
      e.httpStatus = 0;
      e.transient = true;
      throw e;
    }
    if (!response.ok) {
      const e = new Error("通道「" + ch.name + "」" + extractProviderErrorMessage(data, response.status));
      e.httpStatus = response.status;
      e.transient = isTransientSubmitFailure(response.status, e.message);
      throw e;
    }
    const first = data && Array.isArray(data.data) && data.data.length > 0 ? data.data[0] : null;
    const images = [];
    if (first) {
      if (first.url) images.push(first.url);
      else if (first.b64_json) images.push("data:image/png;base64," + first.b64_json);
    }
    if (images.length === 0) {
      const e = new Error("通道「" + ch.name + "」已返回，但没有拿到图片数据。");
      e.httpStatus = response.status;
      e.transient = false;
      throw e;
    }
    return { images, providerTaskId: "" };
  }

  const e = new Error("不支持的通道类型：" + ch.type);
  e.transient = false;
  throw e;
}

/**
 * 服务端轮询供应商异步任务（拿到 providerTaskId 后唯一允许的路径：只查不重提）
 * @returns {Promise<string[]>} 图片数组
 */
async function pollProviderTask(ch, task, providerTaskId) {
  const startedAt = Date.now();
  const endpoint = buildProviderTaskEndpoint(ch.baseUrl, providerTaskId);
  const headers = { "Authorization": "Bearer " + ch.apiKey };
  const signal = task.controller ? task.controller.signal : undefined;
  await sleepMs(PROVIDER_POLL_INITIAL_DELAY);

  while (Date.now() - startedAt <= PROVIDER_POLL_TIMEOUT) {
    if (task.cancelRequested) {
      const e = new Error("任务已取消");
      e.cancelled = true;
      throw e;
    }
    let response, data;
    try {
      response = await fetchViaProxy(endpoint, { method: "GET", headers, signal });
      data = JSON.parse(await response.text());
    } catch (pollError) {
      if (task.cancelRequested) {
        const e = new Error("任务已取消");
        e.cancelled = true;
        throw e;
      }
      // 轮询网络抖动不终止任务：原任务仍在供应商后台执行，重新提交反而可能重复扣费
      console.error("[generation-task] 轮询网络错误，将继续重试", pollError && pollError.message);
      await sleepMs(PROVIDER_POLL_INTERVAL);
      continue;
    }

    const taskData = data && data.data && !Array.isArray(data.data) ? data.data : (data || {});
    if (!response.ok || (data && data.code >= 400)) {
      const e = new Error("通道「" + ch.name + "」任务查询失败：" + extractProviderErrorMessage(data, response.status));
      e.transient = false;
      throw e;
    }
    if (isProviderTaskCompleted(taskData.status)) {
      const images = extractGptImageUrlsSrv(taskData);
      if (images.length === 0) {
        const e = new Error("通道「" + ch.name + "」任务已完成，但没有返回可用图片。");
        e.transient = false;
        throw e;
      }
      return images;
    }
    if (isProviderTaskFailed(taskData.status)) {
      const e = new Error("通道「" + ch.name + "」任务生成失败：" + (taskData.error && taskData.error.message ? taskData.error.message : "供应商返回失败状态"));
      e.transient = false;
      throw e;
    }
    await sleepMs(PROVIDER_POLL_INTERVAL);
  }

  const e = new Error("通道「" + ch.name + "」任务等待超过 10 分钟，请稍后到供应商后台查看任务结果。");
  e.transient = false;
  throw e;
}

/**
 * 执行单张图的提交 + 有界瞬时重试
 * 已拿到 providerTaskId 后发生的错误不做重新提交（防重复扣费）
 */
async function submitSingleImageWithRetry(ch, finalPrompt, task) {
  let lastError = null;
  for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    if (task.cancelRequested) {
      const e = new Error("任务已取消");
      e.cancelled = true;
      throw e;
    }
    try {
      task.status = "running";
      return await submitSingleImageRequest(ch, finalPrompt, task);
    } catch (error) {
      if (error && error.cancelled) throw error;
      lastError = error;
      const canRetry = attempt < SUBMIT_MAX_ATTEMPTS && error && error.transient && !error.providerTaskId;
      console.error("[generation-task] 第 " + attempt + " 次提交失败" + (canRetry ? "（将自动重试）" : "（停止重试）"), error && error.message);
      if (!canRetry) break;
      await sleepMs(SUBMIT_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError || new Error("生图提交失败");
}

/**
 * 执行一个生图任务（含多张并行），成功后写入本地图库
 * @param {Object} task 任务对象
 */
async function runGenerationJob(task) {
  task.status = "running";
  task.startedAt = Date.now();
  task.controller = new AbortController();
  const startedAt = Date.now();

  try {
    const imageCount = Math.max(1, Math.min(Number(task.imageCount) || 1, 6));
    const results = await Promise.allSettled(
      Array.from({ length: imageCount }, () => submitSingleImageWithRetry(task.channel, task.finalPrompt, task))
    );

    const images = [];
    const failures = [];
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        images.push.apply(images, result.value.images);
      } else {
        failures.push(result.reason && result.reason.message ? result.reason.message : "未知错误");
      }
    });

    if (task.cancelRequested) {
      task.status = "cancelled";
      task.error = { message: "任务已取消" };
      return;
    }
    if (images.length === 0) {
      task.status = "failed";
      task.error = { message: failures[0] || "生成失败：没有拿到图片。" };
      task.failures = failures;
      return;
    }

    // 成功即写入本地图库；保存失败不影响生图结果本身（回退为原始 URL/dataURL）
    const record = {
      id: task.id,
      prompt: task.finalPrompt,
      rawPrompt: task.rawPrompt,
      topic: task.topic,
      images: images,
      aspectRatio: task.aspectRatio,
      imageQuality: task.imageQuality,
      imageQualityLabel: task.imageQualityLabel,
      styleTemplateId: task.styleTemplateId,
      styleTemplateLabel: task.styleTemplateLabel,
      model: task.model,
      mode: task.mode,
      modeLabel: task.modeLabel,
      imageCount: imageCount,
      mediaType: task.mediaType || "",
      time: Date.now(),
      generationDurationSeconds: Math.round((Date.now() - startedAt) / 1000)
    };
    let savedRecord = null;
    let saveWarning = "";
    try {
      savedRecord = await enqueueSave(() => saveRecordToDisk(record));
    } catch (saveError) {
      console.error("[generation-task] 图库保存失败，回退为原始图片地址", saveError && saveError.message);
      savedRecord = record;
      saveWarning = "（本地目录写入失败，图片为远程地址或浏览器缓存）";
    }

    task.status = "succeeded";
    task.images = savedRecord.images;
    task.record = savedRecord;
    task.partialFailures = images.length < imageCount ? failures : [];
    task.saveWarning = saveWarning;
    task.generationDurationSeconds = Math.round((Date.now() - startedAt) / 1000);
  } finally {
    task.finishedAt = Date.now();
    task.controller = null;
  }
}

/** 串行任务执行器：按提交顺序逐个执行，任务之间留间隔 */
async function processTaskQueue() {
  if (taskRunnerRunning) return;
  taskRunnerRunning = true;
  try {
    while (taskQueue.length > 0) {
      const taskId = taskQueue.shift();
      const task = generationTasks.get(taskId);
      if (!task || task.status === "cancelled") continue;
      try {
        await runGenerationJob(task);
      } catch (error) {
        if (error && error.cancelled || task.cancelRequested) {
          task.status = "cancelled";
          task.error = { message: "任务已取消" };
        } else {
          task.status = "failed";
          task.error = { message: error && error.message ? error.message : "生成失败" };
        }
        task.finishedAt = Date.now();
      }
      if (taskQueue.length > 0) {
        await sleepMs(JOB_DELAY_MS);
      }
    }
  } finally {
    taskRunnerRunning = false;
  }
}

/**
 * 创建并登记生图任务
 * @param {Object} payload 前端提交的任务描述
 * @returns {{ok:boolean, task?:Object, error?:string}}
 */
function createGenerationTask(payload) {
  const raw = payload || {};
  const finalPrompt = String(raw.finalPrompt || raw.prompt || "").trim();
  const ch = raw.channel || {};
  if (!finalPrompt) return { ok: false, error: "缺少提示词" };
  if (!ch.baseUrl || !ch.apiKey || !ch.model) return { ok: false, error: "通道配置不完整（需要 Base URL、API Key、模型名）" };
  if (!["openai_images", "agnes"].includes(ch.type)) return { ok: false, error: "不支持的通道类型：" + ch.type };

  taskCounter += 1;
  const id = normalizeRecordId(raw.id) || ("task-" + Date.now() + "-" + taskCounter);
  if (generationTasks.has(id)) return { ok: false, error: "任务 ID 已存在：" + id };

  const task = {
    id,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    rawPrompt: String(raw.rawPrompt || raw.prompt || finalPrompt),
    finalPrompt,
    topic: String(raw.topic || ""),
    channel: {
      type: ch.type,
      name: String(ch.name || "生图通道"),
      baseUrl: String(ch.baseUrl),
      apiKey: String(ch.apiKey),
      model: String(ch.model),
      mode: String(ch.mode || "auto")
    },
    channelLabel: String(ch.name || "生图通道") + " · " + String(ch.model || ""),
    model: String(raw.model || ch.model || ""),
    aspectRatio: String(raw.aspectRatio || "1:1"),
    imageQuality: normalizeQuality(raw.imageQuality),
    imageQualityLabel: String(raw.imageQualityLabel || ""),
    styleTemplateId: String(raw.styleTemplateId || "none"),
    styleTemplateLabel: String(raw.styleTemplateLabel || ""),
    mode: String(raw.mode || "text"),
    modeLabel: String(raw.modeLabel || ""),
    imageCount: Math.max(1, Math.min(Number(raw.imageCount) || 1, 6)),
    mediaType: String(raw.mediaType || ""),
    images: [],
    record: null,
    error: null,
    cancelRequested: false,
    controller: null
  };
  generationTasks.set(id, task);
  taskQueue.push(id);
  processTaskQueue();
  return { ok: true, task: sanitizeTask(task) };
}

/**
 * 取消任务：排队中的直接标记取消，执行中的通过 AbortController 中断外部请求
 * @param {string[]} ids 任务 ID 列表
 * @returns {string[]} 实际发出取消指令的任务 ID
 */
function cancelGenerationTasks(ids) {
  const cancelled = [];
  (Array.isArray(ids) ? ids : [ids]).forEach((rawId) => {
    const id = normalizeRecordId(rawId);
    const task = generationTasks.get(id);
    if (!task || ["succeeded", "failed", "cancelled"].includes(task.status)) return;
    task.cancelRequested = true;
    if (task.controller) {
      task.controller.abort();
    } else {
      task.status = "cancelled";
      task.error = { message: "任务已取消" };
      task.finishedAt = Date.now();
      const queueIndex = taskQueue.indexOf(id);
      if (queueIndex !== -1) taskQueue.splice(queueIndex, 1);
    }
    cancelled.push(id);
  });
  return cancelled;
}

/**
 * 生成对外返回的任务快照：剥离 channel（含 API Key），只保留展示所需字段
 * @param {Object} task 任务对象
 */
function sanitizeTask(task) {
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    rawPrompt: task.rawPrompt,
    finalPrompt: task.finalPrompt,
    topic: task.topic,
    channelLabel: task.channelLabel,
    model: task.model,
    aspectRatio: task.aspectRatio,
    imageQuality: task.imageQuality,
    imageQualityLabel: task.imageQualityLabel,
    styleTemplateId: task.styleTemplateId,
    styleTemplateLabel: task.styleTemplateLabel,
    mode: task.mode,
    modeLabel: task.modeLabel,
    imageCount: task.imageCount,
    mediaType: task.mediaType,
    images: task.images,
    record: task.record,
    error: task.error,
    partialFailures: task.partialFailures,
    saveWarning: task.saveWarning,
    generationDurationSeconds: task.generationDurationSeconds
  };
}

/** 按创建顺序返回全部任务的对外快照 */
function listGenerationTasks() {
  return Array.from(generationTasks.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(sanitizeTask);
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

      if (req.method === "POST" && pathname === "/api/image-studio/update-tags") {
        const body = await readBody(req);
        // 标签写入 index.json，纳入同一串行队列避免与保存/删除竞态
        const result = await enqueueSave(() => updateRecordTags(body.id || body.recordId, body.tags));
        sendJson(res, 200, result);
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

      // ======== 后台生图任务 API ========
      // 创建任务（支持批量一次提交多个，服务端按顺序串行执行）
      if (req.method === "POST" && pathname === "/api/image-studio/generation-tasks") {
        const body = await readBody(req);
        const jobs = Array.isArray(body.jobs) ? body.jobs : [body];
        if (jobs.length === 0) {
          sendJson(res, 200, { ok: false, error: "缺少任务内容" });
          return;
        }
        if (jobs.length > MAX_JOBS_PER_REQUEST) {
          sendJson(res, 200, { ok: false, error: "单次最多提交 " + MAX_JOBS_PER_REQUEST + " 个任务" });
          return;
        }
        const created = [];
        const errors = [];
        jobs.forEach((job) => {
          const result = createGenerationTask(job);
          if (result.ok) {
            created.push(result.task);
          } else {
            errors.push(result.error);
          }
        });
        if (created.length === 0) {
          sendJson(res, 200, { ok: false, error: errors[0] || "任务创建失败" });
          return;
        }
        sendJson(res, 200, { ok: true, tasks: created, errors });
        return;
      }

      // 查询全部任务状态（前端轮询 + 回到创作台时恢复）
      if (req.method === "GET" && pathname === "/api/image-studio/generation-tasks") {
        sendJson(res, 200, { ok: true, tasks: listGenerationTasks() });
        return;
      }

      // 取消任务（排队中的直接取消，执行中的中断外部请求）
      if (req.method === "POST" && pathname === "/api/image-studio/generation-tasks/cancel") {
        const body = await readBody(req);
        const cancelledIds = cancelGenerationTasks(body.ids || body.id);
        sendJson(res, 200, { ok: true, cancelledIds });
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
  deleteImageRecords,
  updateRecordTags,
  // 后台生图任务：导出纯函数便于单元测试
  buildGenerationEndpoint,
  buildProviderTaskEndpoint,
  normalizeProviderTaskStatus,
  isProviderTaskCompleted,
  isProviderTaskFailed,
  extractSyncImageUrlsSrv,
  extractGptImageUrlsSrv,
  isTransientSubmitFailure,
  sanitizeTask,
  createGenerationTask,
  cancelGenerationTasks,
  listGenerationTasks
};
