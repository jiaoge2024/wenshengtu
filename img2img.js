/**
 * 图生图工作台（v2.1 三模式 + 断点续跑）
 *
 * 功能模式：
 *   1. 提取提示词 — 上传一张图，视觉模型一键输出中文 + 英文提示词
 *   2. 修改图片 — 上传一张图 + 修改要求，视觉模型理解原图与要求后改写提示词，再调用生图通道出图
 *   3. 多图合成 — 上传最多 9 张图 + 合成要求，视觉模型理解后生成合成提示词，再调用生图通道出图
 *
 * 断点续跑：停止时自动暂存进度，点击「继续」从断点恢复，支持页面刷新后恢复。
 * 依赖：app-config.js（常量）、app-utils.js（proxyFetch / callLlmApi / buildVisionMessages / 通道管理）
 */
(function () {
  "use strict";

  window.__APP = window.__APP || {};

  // ==================== 内部状态 ====================

  var state = {
    modeValue: "extract",        // 当前功能模式
    images: [],                  // 已上传图片 [{ file, fileUrl, dataUrl, width, height }]
    running: false,              // 是否正在执行主流程
    runKind: "",                 // 当前执行类型："extract" | "generate"
    abortController: null,       // 中断控制器
    stopRequested: false,        // 停止标志：即使 abort 事件丢失，循环里也能感知到停止请求
    extract: null,               // 提取结果 { summary, promptZh, promptEn }
    imageCount: 1,               // 生成张数 1-4
    results: [],                 // 生成结果 [{ status, imageUrls, error, progress, prompt }]
    checkpoint: null             // 断点 { modeValue, step, completedIndex, results, imageCount, extraReq }
  };

  var elements = {};
  var cardRefs = [];

  function $(id) { return document.getElementById(id); }

  // ==================== 断点持久化 ====================

  /** 保存断点到 localStorage：停止或完成时调用 */
  function saveCheckpoint() {
    try {
      if (!state.checkpoint) {
        window.localStorage.removeItem(__APP.STORAGE_KEYS.img2imgCheckpoint);
        return;
      }
      window.localStorage.setItem(__APP.STORAGE_KEYS.img2imgCheckpoint, JSON.stringify(state.checkpoint));
    } catch (e) { /* ignore */ }
  }

  /** 读取断点 */
  function loadCheckpoint() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.img2imgCheckpoint);
      if (!raw) return null;
      var cp = JSON.parse(raw);
      if (!cp || typeof cp !== "object") return null;
      if (!cp.modeValue || !findMode(cp.modeValue)) return null;
      return cp;
    } catch (e) { return null; }
  }

  function clearCheckpoint() {
    state.checkpoint = null;
    try { window.localStorage.removeItem(__APP.STORAGE_KEYS.img2imgCheckpoint); } catch (e) { /* ignore */ }
  }

  // ==================== 草稿持久化（仅保存模式与模型配置，不存图片） ====================

  function persistDraft() {
    try {
      var draft = {
        modeValue: state.modeValue,
        extraReq: elements.extraReq.value,
        visionModel: elements.visionModel.value.trim(),
        imageModel: elements.imageModel.value || "",
        imageQuality: elements.imageQuality ? elements.imageQuality.value : "2K",
        aspect: elements.aspect ? elements.aspect.value : "1:1",
        imageCount: state.imageCount
      };
      window.localStorage.setItem(__APP.STORAGE_KEYS.img2imgDraft, JSON.stringify(draft));
    } catch (e) { /* ignore */ }
  }

  function restoreDraft() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.img2imgDraft);
      if (!raw) return;
      var draft = JSON.parse(raw);
      if (!draft || typeof draft !== "object") return;
      if (draft.modeValue && findMode(draft.modeValue)) {
        state.modeValue = draft.modeValue;
      }
      if (typeof draft.extraReq === "string") elements.extraReq.value = draft.extraReq;
      if (typeof draft.visionModel === "string") elements.visionModel.value = draft.visionModel;
      if (draft.imageModel) elements.imageModel.value = draft.imageModel;
      if (draft.imageQuality && elements.imageQuality) elements.imageQuality.value = draft.imageQuality;
      if (draft.aspect && elements.aspect) elements.aspect.value = draft.aspect;
      if (draft.imageCount >= 1 && draft.imageCount <= 4) {
        state.imageCount = draft.imageCount;
      }
    } catch (e) { /* ignore */ }
  }

  // ==================== 模式查找 ====================

  function findMode(value) {
    return (__APP.IMG2IMG_MODES || []).find(function (m) { return m.value === value; }) || null;
  }

  function currentMode() {
    return findMode(state.modeValue);
  }

  // ==================== 模式卡片渲染 ====================

  function renderModeCards() {
    var wrap = elements.modeCards;
    wrap.innerHTML = "";
    (__APP.IMG2IMG_MODES || []).forEach(function (mode) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "i2i-mode-card" + (mode.value === state.modeValue ? " is-active" : "");
      card.dataset.mode = mode.value;
      card.innerHTML = '<span class="i2i-mode-card-name"></span><span class="i2i-mode-card-desc"></span>';
      card.querySelector(".i2i-mode-card-name").textContent = mode.label;
      card.querySelector(".i2i-mode-card-desc").textContent = mode.desc;
      card.addEventListener("click", function () {
        state.modeValue = mode.value;
        renderModeCards();
        clearCheckpoint();
        syncModeUI();
        persistDraft();
      });
      wrap.appendChild(card);
    });
  }

  function syncModeUI() {
    var mode = currentMode();
    if (!mode) return;
    elements.reqPanel.hidden = (mode.value === "extract");
    // 生图尺寸仅修改/合成模式使用，提取模式隐藏（含下方说明文字）
    var isGenerateMode = mode.value !== "extract";
    if (elements.aspectBlock) elements.aspectBlock.hidden = !isGenerateMode;
    var aspectNote = document.getElementById("i2i-aspect-note");
    if (aspectNote) aspectNote.hidden = !isGenerateMode;
    if (mode.value === "edit") {
      elements.reqLabel.textContent = "修改要求";
      elements.extraReq.placeholder = "例：把小女孩手里的猫换成一只小狗，其余保持不变。";
    } else if (mode.value === "compose") {
      elements.reqLabel.textContent = "合成要求";
      elements.extraReq.placeholder = "例：把图A放进图B的天空中，图C放在前景左侧。";
    }
    elements.runButton.textContent = mode.runLabel || "开始";
    var maxImages = mode.maxImages || 1;
    while (state.images.length > maxImages) {
      removeImage(state.images.length - 1);
    }
    if (maxImages > 1) {
      elements.dropzoneNote.textContent = "支持 JPG / PNG / WebP 等格式；最多上传 " + maxImages + " 张图片。";
    } else {
      elements.dropzoneNote.textContent = "支持 JPG / PNG / WebP 等格式；图片仅在本地压缩后发送给你配置的模型服务。";
    }
    syncControls();
  }

  // ==================== 图片上传与压缩 ====================

  function compressImage(img) {
    var maxEdge = __APP.IMG2IMG_MAX_UPLOAD_EDGE || 1280;
    var naturalW = img.naturalWidth || img.width || 1;
    var naturalH = img.naturalHeight || img.height || 1;
    var scale = Math.min(1, maxEdge / Math.max(naturalW, naturalH));
    var w = Math.max(1, Math.round(naturalW * scale));
    var h = Math.max(1, Math.round(naturalH * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    var dataUrl = canvas.toDataURL("image/jpeg", __APP.IMG2IMG_JPEG_QUALITY || 0.85);
    return { dataUrl: dataUrl, width: w, height: h };
  }

  function addImage(file) {
    if (!file) return;
    var mode = currentMode();
    var maxImages = mode ? mode.maxImages : 1;
    if (state.images.length >= maxImages) {
      showStatus("最多上传 " + maxImages + " 张图片，请先移除已有图片。", true);
      return;
    }
    if (!file.type || file.type.indexOf("image/") !== 0) {
      showStatus("请选择图片文件（支持 JPG / PNG / WebP 等格式）。", true);
      return;
    }
    var objectUrl = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var compressed;
      try { compressed = compressImage(img); } catch (error) {
        URL.revokeObjectURL(objectUrl);
        showStatus("图片处理失败：" + (error && error.message ? error.message : "未知错误"), true);
        return;
      }
      state.images.push({
        file: file, fileUrl: objectUrl,
        dataUrl: compressed.dataUrl, width: compressed.width, height: compressed.height
      });
      renderMultiPreview();
      showDoneStatus("" + state.images.length + " / " + maxImages + " 张图片。", false);
      syncControls();
    };
    img.onerror = function () {
      URL.revokeObjectURL(objectUrl);
      showStatus("浏览器无法解码该图片，请换用 JPG / PNG / WebP 等常见格式。", true);
    };
    img.src = objectUrl;
  }

  function removeImage(index) {
    if (index < 0 || index >= state.images.length) return;
    var img = state.images[index];
    if (img.fileUrl) URL.revokeObjectURL(img.fileUrl);
    state.images.splice(index, 1);
    renderMultiPreview();
    clearCheckpoint();
    syncControls();
    if (state.images.length === 0) {
      showStatus("图片已清空，可重新上传。", false);
    }
  }

  function clearAllImages() {
    state.images.forEach(function (img) {
      if (img.fileUrl) URL.revokeObjectURL(img.fileUrl);
    });
    state.images = [];
    elements.fileInput.value = "";
    renderMultiPreview();
    syncControls();
  }

  function renderMultiPreview() {
    var wrap = elements.multiPreview;
    wrap.innerHTML = "";
    if (state.images.length === 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    state.images.forEach(function (img, index) {
      var card = document.createElement("div");
      card.className = "i2i-multi-card";
      var visual = document.createElement("div");
      visual.className = "i2i-multi-visual";
      var imgEl = document.createElement("img");
      imgEl.src = img.fileUrl;
      imgEl.alt = (img.file && img.file.name) || "图片 " + (index + 1);
      visual.appendChild(imgEl);
      var label = document.createElement("span");
      label.className = "i2i-multi-label";
      label.textContent = "图" + String.fromCharCode(65 + index);
      visual.appendChild(label);
      var meta = document.createElement("div");
      meta.className = "i2i-multi-meta";
      meta.textContent = (img.width || "?") + "×" + (img.height || "?");
      var removeBtn = document.createElement("button");
      removeBtn.className = "i2i-multi-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "✕";
      removeBtn.title = "移除";
      removeBtn.addEventListener("click", function () { removeImage(index); });
      card.appendChild(visual);
      card.appendChild(meta);
      card.appendChild(removeBtn);
      wrap.appendChild(card);
    });
  }

  // ==================== 视觉模型配置 ====================

  function getVisionLlmConfig() {
    var providerId = __APP.getOptimizeProvider();
    var provider = __APP.getLlmProviderById(providerId);
    if (!provider) throw new Error("未找到文本模型配置，请到设置页「AI 助手模型」完成配置。");
    if (!provider.apiKey) throw new Error("模型商「" + provider.name + "」的 API Key 为空，请到设置页填写。");
    var model = elements.visionModel.value.trim() || __APP.getOptimizeModel();
    if (!model) throw new Error("未指定视觉模型名：请在「视觉模型名」中填写支持图片理解的模型（如 qwen-vl、glm-4v、gpt-4o）。");
    return { provider: provider, model: model };
  }

  function renderLlmInfo() {
    var info = elements.llmInfo;
    try {
      var providerId = __APP.getOptimizeProvider();
      var provider = __APP.getLlmProviderById(providerId);
      var override = elements.visionModel.value.trim();
      var model = override || __APP.getOptimizeModel();
      if (provider && provider.apiKey && model) {
        info.textContent = provider.name + " · " + model + (override ? "（页面覆盖）" : "（已就绪）");
        info.classList.remove("is-empty");
      } else {
        info.textContent = "未就绪：请先配置 AI 助手模型";
        info.classList.add("is-empty");
      }
    } catch (e) {
      info.textContent = "未就绪：请先配置 AI 助手模型";
      info.classList.add("is-empty");
    }
  }

  // ==================== JSON 容错解析 ====================

  function stripTrailingFragments(candidate) {
    var text = candidate, prev;
    do { prev = text; text = text.replace(/,(\s*[}\]])/g, "$1"); } while (text !== prev);
    text = text.replace(/,\s*$/, "");
    text = text.replace(/,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, ",");
    return text.replace(/,\s*$/, "");
  }

  function tryRepairTruncatedJson(value, start) {
    var candidates = [];
    for (var i = value.length - 1; i > start && candidates.length < 120; i--) {
      var c = value.charAt(i);
      if (c === "}" || c === "]") candidates.push(i);
    }
    for (var k = 0; k < candidates.length; k++) {
      var cut = candidates[k];
      var candidate = value.slice(start, cut + 1);
      var stack = [], inString = false, escaped = false;
      for (var j = 0; j < candidate.length; j++) {
        var ch = candidate.charAt(j);
        if (inString) {
          if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
      }
      var repaired = candidate + (inString ? '"' : "");
      repaired = stripTrailingFragments(repaired);
      for (var t = stack.length - 1; t >= 0; t--) repaired += stack[t] === "{" ? "}" : "]";
      try { return JSON.parse(repaired); } catch (e) { /* continue */ }
    }
    return null;
  }

  function extractJson(text) {
    var value = String(text || "").trim();
    value = value.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(value); } catch (e) { /* continue */ }
    var start = value.search(/[{[]/);
    if (start === -1) throw new Error("模型返回内容中没有找到 JSON 数据，请重试。");
    var depth = 0, inString = false, escaped = false;
    for (var i = start; i < value.length; i++) {
      var ch = value.charAt(i);
      if (inString) {
        if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          var candidate = value.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch (parseError) {
            try { return JSON.parse(stripTrailingFragments(candidate)); } catch (cleanError) {
              throw new Error("模型返回的 JSON 格式有误，请重试。");
            }
          }
        }
      }
    }
    var repaired = tryRepairTruncatedJson(value, start);
    if (repaired) return repaired;
    throw new Error("模型返回的 JSON 不完整且无法自动修复，请重试。");
  }

  // ==================== 视觉模型调用 ====================

  function buildVisionUserText(mode) {
    var text = "";
    if (mode.value === "compose" && state.images.length > 1) {
      text = "以下图片分别是：\n";
      for (var i = 0; i < state.images.length; i++) {
        text += "图" + String.fromCharCode(65 + i) + "：第 " + (i + 1) + " 张图片\n";
      }
    }
    var extra = elements.extraReq.value.trim();
    if (extra) text += "\n用户要求：" + extra;
    return text || extra;
  }

  function buildMultiVisionMessages(systemInstruction, userText) {
    var messages = [{ role: "system", content: systemInstruction }];
    var content = [];
    if (userText) content.push({ type: "text", text: userText });
    state.images.forEach(function (img) {
      content.push({ type: "image_url", image_url: { url: img.dataUrl } });
    });
    messages.push({ role: "user", content: content });
    return messages;
  }

  async function runVisionExtract(signal) {
    var config = getVisionLlmConfig();
    var messages = buildMultiVisionMessages(__APP.IMG2IMG_EXTRACT_INSTRUCTION, "");
    var text = await __APP.callLlmApi(config.provider.id || config.provider, config.model, messages, signal);
    var parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object" || !parsed.promptZh || !parsed.promptEn) {
      throw new Error("提取结果缺少中文或英文提示词字段，请重试。");
    }
    return parsed;
  }

  async function runVisionEdit(mode, signal) {
    var config = getVisionLlmConfig();
    var userText = buildVisionUserText(mode);
    var messages = buildMultiVisionMessages(__APP.IMG2IMG_EDIT_INSTRUCTION, userText);
    var text = await __APP.callLlmApi(config.provider.id || config.provider, config.model, messages, signal);
    var parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object" || !parsed.promptZh) {
      throw new Error("模型返回缺少 promptZh 字段，请重试。");
    }
    return parsed;
  }

  // ==================== 生图引擎 ====================

  function buildChannelEndpoint(baseUrl) {
    var endpoint = (baseUrl || "").replace(/\/+$/, "");
    if (!endpoint) return "";
    if (!/\/images\/generations/.test(endpoint)) {
      endpoint += /\/v1(?:[\/?#]|$)/.test(endpoint) ? "/images/generations" : "/v1/images/generations";
    }
    return endpoint;
  }

  function buildTaskEndpoint(baseUrl, taskId) {
    var normalized = (baseUrl || "").replace(/\/+$/, "").replace(/\/images\/generations(?:[?#].*)?$/, "");
    if (/\/v1(?:[\/?#]|$)/.test(normalized)) return normalized + "/tasks/" + encodeURIComponent(taskId);
    return normalized + "/v1/tasks/" + encodeURIComponent(taskId);
  }

  function abortableSleep(ms, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new DOMException("已停止", "AbortError"));
    }
    return new Promise(function (resolve, reject) {
      var timeoutId = window.setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener("abort", function () {
        window.clearTimeout(timeoutId);
        reject(new DOMException("已停止", "AbortError"));
      }, { once: true });
    });
  }

  /** 检查是否已请求停止或信号已中止，是则立即抛出 AbortError */
  function checkAborted(signal) {
    if (state.stopRequested) {
      throw new DOMException("已停止", "AbortError");
    }
    if (signal && signal.aborted) {
      throw new DOMException("已停止", "AbortError");
    }
  }

  /**
   * 为单次网络请求创建「外部停止信号 + 客户端硬超时」合并的信号。
   * 背景：部分中转站接口会挂起连接且不响应中止，
   * 导致请求永久 pending、停止按钮看起来无效。这里超时由客户端强制断开。
   * 配合 onTimeout 回调使用 Promise.race，即使底层 fetch 不响应信号也能按时超时。
   * @param {AbortSignal} signal - 外部停止信号（来自主 AbortController）
   * @param {number} timeoutMs - 硬超时毫秒数
   * @returns {{ signal: AbortSignal, cancel: Function, timedOut: Function, onTimeout: Function }}
   */
  function beginRequestSignal(signal, timeoutMs) {
    var inner = new AbortController();
    var timedOut = false;
    function onOuterAbort() { inner.abort(); }
    if (signal) {
      if (signal.aborted) inner.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    var api = {
      signal: inner.signal,
      /** 请求结束后清理定时器与监听 */
      cancel: function () {
        window.clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
      },
      /** 是否因超时而中止 */
      timedOut: function () { return timedOut; },
      /** 超时回调：调用方设置后，超时时会被调用一次（用于 Promise.race 拒绝） */
      onTimeout: null
    };
    var timer = window.setTimeout(function () {
      timedOut = true;
      inner.abort();
      // 通知外层 Promise.race 立即以超时错误拒绝（不依赖底层请求响应信号）
      if (api.onTimeout) api.onTimeout();
    }, timeoutMs);
    return api;
  }

  function extractSyncImageUrls(data) {
    var images = [];
    if (data && Array.isArray(data.data)) {
      data.data.forEach(function (item) {
        if (item && typeof item.b64_json === "string" && item.b64_json.trim()) {
          images.push("data:image/png;base64," + item.b64_json);
        } else if (item && typeof item.url === "string" && item.url.trim()) {
          images.push(item.url);
        }
      });
    }
    return images;
  }

  function extractTaskImageUrls(taskData) {
    var resultImages = taskData && taskData.result && Array.isArray(taskData.result.images) ? taskData.result.images : [];
    var images = [];
    resultImages.forEach(function (item) {
      if (typeof item === "string" && item.trim()) images.push(item);
      else if (item && typeof item.b64_json === "string" && item.b64_json.trim()) images.push("data:image/png;base64," + item.b64_json);
      else if (item && typeof item.url === "string" && item.url.trim()) images.push(item.url);
    });
    return images;
  }

  async function pollImageTask(taskId, apiKey, signal, taskEndpoint) {
    var startedAt = Date.now();
    await abortableSleep(__APP.GPT_IMAGE_TASK_INITIAL_DELAY, signal);
    while (Date.now() - startedAt <= __APP.GPT_IMAGE_TASK_TIMEOUT) {
      checkAborted(signal);
      var response = await __APP.proxyFetch(taskEndpoint, {
        method: "GET", signal: signal, headers: { Authorization: "Bearer " + apiKey }
      });
      var data = await response.json();
      var taskData = data && Array.isArray(data.data) ? data.data[0] : (data && data.data ? data.data : data);
      if (!response.ok || (data && data.code >= 400)) {
        throw new Error((data && data.error && data.error.message) || "任务查询失败（HTTP " + response.status + "）");
      }
      var status = String(taskData && taskData.status || "").trim().toLowerCase();
      if (["completed", "succeeded", "success", "done"].indexOf(status) !== -1) {
        var images = extractTaskImageUrls(taskData);
        if (images.length === 0) throw new Error("任务已完成，但没有返回可用图片。");
        return images;
      }
      if (["failed", "error", "cancelled", "canceled"].indexOf(status) !== -1) {
        throw new Error((taskData && taskData.error && taskData.error.message) || "任务生成失败。");
      }
      await abortableSleep(__APP.GPT_IMAGE_TASK_POLL_INTERVAL, signal);
    }
    throw new Error("任务等待超过 10 分钟，已停止轮询。");
  }

  /** 生图入口：套一层客户端硬超时，防止中转站挂起连接导致永久等待 */
  async function generateImage(channel, finalPrompt, aspectRatio, quality, signal, onProgress) {
    var req = beginRequestSignal(signal, __APP.IMG2IMG_GENERATE_TIMEOUT_MS || 720000);
    try {
      // Promise.race：即使底层请求挂死不响应信号，超时也能强制结束
      var innerPromise = generateImageInner(channel, finalPrompt, aspectRatio, quality, req.signal, onProgress);
      // 挂起请求稍后的失败已被超时/停止取代，静默接管避免 unhandled rejection
      innerPromise.catch(function () {});
      return await Promise.race([
        innerPromise,
        new Promise(function (_, reject) {
          req.onTimeout = function () { reject(new Error("生成超时（超过 12 分钟无响应），已终止本次请求。")); };
        })
      ]);
    } finally {
      req.cancel();
    }
  }

  async function generateImageInner(channel, finalPrompt, aspectRatio, quality, signal, onProgress) {
    var apiKey = (channel.apiKey || "").trim();
    var model = channel.model;
    var baseUrl = (channel.baseUrl || "").replace(/\/+$/, "");
    if (!apiKey) throw new Error("通道「" + channel.name + "」的 API Key 为空。");
    if (!model) throw new Error("通道「" + channel.name + "」的模型名为空。");
    if (!baseUrl) throw new Error("通道「" + channel.name + "」的 Base URL 为空。");

    if (channel.type === "agnes") {
      onProgress("正在通过「" + channel.name + "」生成...");
      var agnesRes = await __APP.proxyFetch(buildChannelEndpoint(baseUrl), {
        method: "POST", signal: signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({ model: model, prompt: finalPrompt, size: quality, ratio: aspectRatio, extra_body: { response_format: "url" } })
      });
      var agnesData = await agnesRes.json();
      if (!agnesRes.ok) throw new Error((agnesData && agnesData.error && agnesData.error.message) || "Agnes 请求失败（HTTP " + agnesRes.status + "）");
      var agnesFirst = agnesData && Array.isArray(agnesData.data) && agnesData.data[0];
      if (!agnesFirst || (!agnesFirst.url && !agnesFirst.b64_json)) throw new Error("Agnes 已返回，但没有拿到图片数据。");
      return [agnesFirst.url || "data:image/png;base64," + agnesFirst.b64_json];
    }

    var endpoint = buildChannelEndpoint(baseUrl);
    async function callOnce(sizeFormat) {
      var res = await __APP.proxyFetch(endpoint, {
        method: "POST", signal: signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({ model: model, prompt: finalPrompt, n: 1, size: __APP.getGptImageSize(aspectRatio, quality, sizeFormat), resolution: quality })
      });
      var resData = await res.json();
      return { response: res, data: resData };
    }

    onProgress("正在通过「" + channel.name + "」生成...");
    var result = await callOnce("pixels");

    if (!result.response.ok || (result.data && result.data.code >= 400)) {
      var firstErrMsg = result.data && result.data.error && result.data.error.message ? result.data.error.message : "";
      if (/invalid\s+size|expected\s+widthxheight|width\s*x\s*height|unsupported\s+size/i.test(firstErrMsg)) {
        onProgress("尺寸格式不被支持，正在自动重试...");
        result = await callOnce("ratio");
      }
    }

    if (!result.response.ok || (result.data && result.data.code >= 400)) {
      var errMsg = (result.data && result.data.error && result.data.error.message)
        || (result.data && result.data.message) || "请求失败（HTTP " + result.response.status + "）";
      throw new Error(errMsg);
    }

    var firstData = result.data && Array.isArray(result.data.data) ? result.data.data[0] : null;
    if (firstData && firstData.task_id && (channel.mode === "async" || channel.mode === "auto")) {
      onProgress("任务已提交，等待出图...");
      return pollImageTask(firstData.task_id, apiKey, signal, buildTaskEndpoint(baseUrl, firstData.task_id));
    }

    var syncImages = extractSyncImageUrls(result.data);
    if (syncImages.length === 0) throw new Error("通道已返回，但没有拿到图片数据。");
    return syncImages;
  }

  // ==================== 自动重试 ====================

  var RETRYABLE_PATTERN = /concurrency|并发|rate\s*limit|too\s*many\s+requests|\b429\b|频率|超限|quota/i;

  function isRetryableError(message) {
    return RETRYABLE_PATTERN.test(String(message || ""));
  }

  async function generateWithRetry(channel, prompt, aspectRatio, quality, signal, onProgress, label) {
    var maxRetries = 3;
    var attempt = 0;
    while (true) {
      checkAborted(signal);
      try {
        return await generateImage(channel, prompt, aspectRatio, quality, signal, onProgress);
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        var message = error && error.message ? error.message : "未知错误";
        if (!isRetryableError(message) || attempt >= maxRetries) throw error;
        attempt++;
        var waitSeconds = attempt * 10;
        var deadline = Date.now() + waitSeconds * 1000;
        while (Date.now() < deadline) {
          checkAborted(signal);
          var left = Math.ceil((deadline - Date.now()) / 1000);
          onProgress("并发超限，" + left + " 秒后自动重试（第 " + attempt + "/" + maxRetries + " 次）...");
          await abortableSleep(1000, signal);
        }
        onProgress("自动重试中（第 " + attempt + "/" + maxRetries + " 次）...");
      }
    }
  }

  // ==================== 入库与下载 ====================

  function buildRecordTopic() {
    var name = state.images[0] && state.images[0].file && state.images[0].file.name
      ? String(state.images[0].file.name).replace(/\.[^.]+$/, "") : "";
    name = name.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return "图生图";
    return ("图生图-" + name).slice(0, 20);
  }

  async function saveResultToGallery(result, index, channel, aspectRatio) {
    try {
      var qualityValue = elements.imageQuality && elements.imageQuality.value ? elements.imageQuality.value : "2K";
      var qualityMeta = (__APP.IMAGE_QUALITIES || []).find(function (q) { return q.value === qualityValue; });
      var response = await fetch(__APP.API_ENDPOINTS.save, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record: {
            id: "img2img-" + Date.now() + "-" + index,
            prompt: result.prompt || "", rawPrompt: "",
            topic: buildRecordTopic(), images: result.imageUrls,
            aspectRatio: aspectRatio, imageQuality: qualityValue,
            imageQualityLabel: qualityMeta ? qualityMeta.label : qualityValue,
            styleTemplateId: "none", styleTemplateLabel: "图生图",
            model: channel ? channel.model : "", mode: "text", modeLabel: "图生图", time: Date.now()
          }
        })
      });
      var data = await response.json();
      return !!(data && data.ok);
    } catch (error) {
      console.error("[img2img] 自动入库失败（第 " + (index + 1) + " 张）", error);
      return false;
    }
  }

  async function downloadResult(index, button) {
    var result = state.results[index];
    var url = result && result.imageUrls && result.imageUrls[0];
    if (!url) return;
    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = "下载中...";
    try {
      var topic = buildRecordTopic().replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      var timestamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+$/, "").slice(0, 14);
      var filename = (topic ? topic + "-" : "img2img-") + timestamp + ".png";
      if (url.indexOf("data:") === 0) {
        triggerDownload(url, filename);
      } else {
        var blob = await fetch(url).then(function (res) { return res.blob(); });
        var objectUrl = URL.createObjectURL(blob);
        triggerDownload(objectUrl, filename);
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 2000);
      }
    } catch (error) {
      console.error("[img2img] 下载失败", error);
      window.open(url, "_blank", "noopener");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function triggerDownload(href, filename) {
    var link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * 「继续编辑」：把已生成的新图取回，替换当前原图，
   * 用户只需输入新的修改要求即可再次改图（迭代式编辑）。
   * @param {number} index - 结果卡索引
   * @param {HTMLButtonElement} button - 触发按钮（用于显示加载状态）
   */
  async function useResultAsSource(index, button) {
    var result = state.results[index];
    var url = result && result.imageUrls && result.imageUrls[0];
    if (!url) return;
    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = "处理中...";
    try {
      // 取回图片二进制数据（dataURL 直接解码，远程地址走 fetch）
      var blob;
      if (url.indexOf("data:") === 0) {
        blob = await (await fetch(url)).blob();
      } else {
        blob = await fetch(url).then(function (res) { return res.blob(); });
      }
      if (!blob || blob.size === 0) throw new Error("图片数据为空");
      var file = new File([blob], "新图-" + (index + 1) + "-" + Date.now() + ".png", { type: blob.type || "image/png" });
      // 清空现有原图（修改模式仅支持一张原图），再把新图设为原图
      while (state.images.length > 0) {
        removeImage(state.images.length - 1);
      }
      addImage(file);
      // 回到顶部并聚焦修改要求输入框（高亮闪烁提示输入位置），减少迭代时的寻找成本
      window.scrollTo({ top: 0, behavior: "smooth" });
      var reqPanel = document.getElementById("i2i-req-panel");
      var focusReq = function () {
        if (!elements.extraReq) return;
        elements.extraReq.focus({ preventScroll: true });
        if (reqPanel) {
          reqPanel.classList.add("i2i-flash");
          setTimeout(function () { reqPanel.classList.remove("i2i-flash"); }, 1600);
        }
      };
      setTimeout(focusReq, 350);
      showDoneStatus("已把「新图 " + (index + 1) + "」设为原图，请输入新的修改要求后点「开始修改」。", false);
    } catch (error) {
      console.error("[img2img] 继续编辑失败", error);
      showStatus("继续编辑失败：" + (error && error.message ? error.message : "无法获取图片，可下载后手动上传。"), true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  // ==================== 结果渲染 ====================

  /** 把毫秒时长格式化为「X 秒」或「X 分 Y 秒」的友好文本 */
  function formatDuration(ms) {
    var totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) return totalSeconds + " 秒";
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + " 分 " + (seconds < 10 ? "0" : "") + seconds + " 秒";
  }

  /** 单张结果开始计时（状态置为 running 时调用） */
  function beginResultTiming(result) {
    result.startedAt = Date.now();
    result.elapsedMs = null;
  }

  /** 单张结果结束计时（状态变为 done / error / stopped 时调用，幂等） */
  function endResultTiming(result) {
    if (result.startedAt && result.elapsedMs == null) {
      result.elapsedMs = Date.now() - result.startedAt;
    }
  }

  function clearResults() {
    state.results = [];
    cardRefs = [];
    elements.resultsGrid.innerHTML = "";
  }

  function renderSourceCard() {
    if (state.images.length === 0) return;
    state.images.forEach(function (img, idx) {
      var card = document.createElement("article");
      card.className = "i2i-result-card panel";
      var head = document.createElement("div");
      head.className = "i2i-result-head";
      var tag = document.createElement("span");
      tag.className = "i2i-result-tag is-source";
      tag.textContent = "原图" + String.fromCharCode(65 + idx);
      var title = document.createElement("h3");
      title.className = "i2i-result-title";
      title.textContent = (img.file && img.file.name) || "图片 " + (idx + 1);
      head.appendChild(tag);
      head.appendChild(title);
      var visual = document.createElement("div");
      visual.className = "i2i-result-visual";
      visual.style.aspectRatio = img.width > 0 ? img.width + " / " + img.height : "1 / 1";
      var imgEl = document.createElement("img");
      imgEl.className = "i2i-result-img";
      imgEl.alt = "原图";
      imgEl.src = img.fileUrl;
      visual.appendChild(imgEl);
      card.appendChild(head);
      card.appendChild(visual);
      elements.resultsGrid.appendChild(card);
    });
  }

  function renderResultCards() {
    elements.resultsGrid.innerHTML = "";
    cardRefs = [];
    var template = elements.resultCardTemplate;
    state.results.forEach(function (result, index) {
      var node = template.content.cloneNode(true);
      var tag = node.querySelector(".i2i-result-tag");
      var title = node.querySelector(".i2i-result-title");
      var img = node.querySelector(".i2i-result-img");
      var spinner = node.querySelector(".i2i-result-spinner");
      var statusText = node.querySelector(".i2i-result-status-text");
      var placeholder = node.querySelector(".i2i-result-placeholder");
      var elapsed = node.querySelector(".i2i-result-elapsed");
      var regenButton = node.querySelector(".js-regen");
      var downloadButton = node.querySelector(".js-download");
      var editAgainButton = node.querySelector(".js-edit-again");
      var promptToggle = node.querySelector(".js-prompt-toggle");
      var promptInput = node.querySelector(".js-prompt");

      tag.textContent = "新图 " + (index + 1);
      title.textContent = buildRecordTopic();
      regenButton.addEventListener("click", function () { regenerateResult(index); });
      downloadButton.addEventListener("click", function () { downloadResult(index, downloadButton); });
      editAgainButton.addEventListener("click", function () { useResultAsSource(index, editAgainButton); });
      // 提示词折叠：点击展开/收起编辑框
      promptToggle.addEventListener("click", function () {
        var willShow = promptInput.hidden;
        promptInput.hidden = !willShow;
        promptToggle.textContent = willShow ? "提示词 ▴" : "提示词 ▾";
        promptToggle.setAttribute("aria-expanded", String(willShow));
      });

      // 源图静态模糊底图（LQIP）：有已上传源图时作为占位底，
      // 断点恢复后 state.images 为空则保持隐藏，降级为占位卡自带渐变
      var lqip = node.querySelector(".gen-lqip");
      var firstSource = state.images && state.images[0];
      if (lqip && firstSource && firstSource.fileUrl) {
        lqip.style.backgroundImage = 'url("' + firstSource.fileUrl + '")';
        lqip.hidden = false;
      }

      elements.resultsGrid.appendChild(node);
      cardRefs.push({
        card: node.querySelector(".i2i-result-card"), img: img, spinner: spinner,
        statusText: statusText, placeholder: placeholder, elapsed: elapsed,
        regenButton: regenButton, downloadButton: downloadButton,
        editAgainButton: editAgainButton, promptInput: promptInput
      });
      syncResultCard(index);
    });
  }

  function syncResultCard(index) {
    var refs = cardRefs[index];
    var result = state.results[index];
    if (!refs || !result) return;
    if (result.status === "done" && result.imageUrls && result.imageUrls[0]) {
      var wasHidden = refs.img.hidden;
      refs.img.src = result.imageUrls[0];
      refs.img.hidden = false;
      // 由占位切换为真图时播放「模糊→清晰」淡入；已是完成态的重渲染不重播
      refs.img.classList.toggle("gen-blur-reveal-img", wasHidden);
      refs.placeholder.style.display = "none";
      refs.regenButton.disabled = false;
      refs.downloadButton.disabled = false;
      refs.editAgainButton.hidden = false;
      // 填充生成所用提示词（仅在编辑框为空时填充，避免覆盖用户正在编辑的内容）
      if (!refs.promptInput.value && result.prompt) {
        refs.promptInput.value = result.prompt;
      }
      refs.elapsed.textContent = result.elapsedMs != null ? "用时 " + formatDuration(result.elapsedMs) : "";
      return;
    }
    refs.img.hidden = true;
    refs.img.removeAttribute("src");
    // 移除旧动画类，保证下次完成时「模糊→清晰」动画能重新触发
    refs.img.classList.remove("gen-blur-reveal-img");
    refs.placeholder.style.display = "";
    refs.editAgainButton.hidden = true;
    refs.elapsed.textContent = (result.startedAt && result.elapsedMs != null)
      ? "用时 " + formatDuration(result.elapsedMs) : "";
    var isError = result.status === "error" || result.status === "stopped";
    refs.placeholder.classList.toggle("is-error", isError);
    refs.placeholder.classList.toggle("is-running", result.status === "running" || result.status === "pending");
    refs.spinner.hidden = result.status !== "running";
    if (result.status === "running") {
      // 生成中：进度文本后实时拼接已用时（由秒级定时器驱动刷新）
      var elapsedText = result.startedAt ? " · 已用时 " + formatDuration(Date.now() - result.startedAt) : "";
      refs.statusText.textContent = (result.progress || "正在生成...") + elapsedText;
    } else {
      refs.statusText.textContent = result.status === "pending"
        ? "等待生成"
        : (result.error || "已停止");
    }
    refs.regenButton.disabled = state.running || result.status === "running";
    refs.downloadButton.disabled = result.status !== "done";
  }

  async function regenerateResult(index) {
    if (state.running) return;
    state.stopRequested = false;
    var mode = currentMode();
    if (!mode || !mode.needGeneration) return;
    var modelValue = elements.imageModel.value;
    var resolvedChannel = __APP.resolveImageChannel(modelValue);
    var channel = resolvedChannel ? resolvedChannel.channel : null;
    if (!channel) { showStatus("当前生图模型不可用，请先到设置页配置。", true); return; }
    state.running = true;
    state.abortController = new AbortController();
    var signal = state.abortController.signal;
    syncControls();
    var result = state.results[index];
    result.status = "running";
    result.error = "";
    result.progress = "";
    beginResultTiming(result);
    syncResultCard(index);
    try {
      // 优先使用卡片上用户编辑后的提示词（编辑框为空则回退到原提示词）
      var refs = cardRefs[index];
      var editedPrompt = refs && refs.promptInput && refs.promptInput.value.trim();
      if (editedPrompt) result.prompt = editedPrompt;
      // 统一走生图链路（与多图合成一致）
      // 重新生成使用当前「生图尺寸」选择（可改尺寸后重出）
      var regenAspect = getAspect();
      var urls = await generateWithRetry(channel, result.prompt || "", regenAspect, "2K", signal, function (text) {
        result.progress = text; syncResultCard(index);
      }, "新图 " + (index + 1));
      result.imageUrls = urls;
      result.status = "done";
      endResultTiming(result);
      syncResultCard(index);
      saveResultToGallery(result, index, channel, regenAspect);
      showDoneStatus("" + formatDuration(result.elapsedMs) + "。", false);
    } catch (error) {
      if ((error && error.name === "AbortError") || state.stopRequested) {
        result.status = "stopped";
        result.error = "已停止";
        endResultTiming(result);
        syncResultCard(index);
      } else {
        result.status = "error";
        result.error = error && error.message ? error.message : "生成失败";
        endResultTiming(result);
        syncResultCard(index);
        showStatus("新图 " + (index + 1) + " 生成失败：" + result.error, true);
      }
    } finally {
      state.running = false;
      state.abortController = null;
      syncControls();
    }
  }

  // ==================== 提取结果渲染 ====================

  function renderExtractResult(parsed) {
    elements.extractResult.hidden = false;
    // 每次出新结果时恢复为展开状态，方便直接查看
    elements.extractBody.hidden = false;
    elements.extractToggle.textContent = "收起 ▴";
    elements.extractToggle.setAttribute("aria-expanded", "true");
    elements.extractSummary.textContent = parsed.summary || "";
    elements.promptZh.value = parsed.promptZh || "";
    elements.promptEn.value = parsed.promptEn || "";
  }

  // ==================== 主流程 ====================

  function validateRun(mode) {
    if (!mode) return "请选择功能模式。";
    if (state.images.length === 0) return "请先上传图片。";
    try { getVisionLlmConfig(); } catch (error) { return error.message; }
    if (mode.needGeneration && !elements.extraReq.value.trim()) {
      return mode.value === "edit" ? "请输入修改要求。" : "请输入合成要求。";
    }
    if (mode.needGeneration) {
      var modelValue = elements.imageModel.value;
      var channel = __APP.resolveImageChannel(modelValue);
      if (!channel) return "当前生图模型不可用，请先到设置页配置生图通道。";
    }
    return null;
  }

  async function startRun() {
    if (state.running) return;
    state.stopRequested = false;

    // 如果有断点，继续执行
    if (state.checkpoint) {
      await resumeFromCheckpoint();
      return;
    }

    var mode = currentMode();
    if (!mode) return;
    var error = validateRun(mode);
    if (error) { showStatus(error, true); return; }

    state.running = true;
    state.runKind = mode.needGeneration ? "generate" : "extract";
    state.abortController = new AbortController();
    var signal = state.abortController.signal;
    syncControls();

    if (mode.value === "extract") {
      showRunStatus("调用视觉模型提取提示词...", false);
      var extractStartedAt = Date.now();
      try {
        var parsed = await runVisionExtract(signal);
        if (!parsed || typeof parsed !== "object" || !parsed.promptZh || !parsed.promptEn) {
          throw new Error("提取结果缺少中文或英文提示词字段，请重试。");
        }
        state.extract = parsed;
        renderExtractResult(parsed);
        showDoneStatus("提取完成：中文与英文提示词均已生成，可分别复制使用。（用时 " + formatDuration(Date.now() - extractStartedAt) + "）", false);
      } catch (err) {
        if (err && err.name === "AbortError") {
          showStatus("已停止。", false);
        } else {
          console.error("[img2img] 提取失败", err);
          showStatus("提取失败：" + (err && err.message ? err.message : "未知错误"), true);
        }
      } finally {
        state.running = false;
        state.abortController = null;
        syncControls();
      }
      return;
    }

    // 编辑/合成模式：初始化结果
    var modelValue = elements.imageModel.value;
    var channel = __APP.resolveImageChannel(modelValue).channel;
    var quality = elements.imageQuality && elements.imageQuality.value ? elements.imageQuality.value : "2K";
    var aspect = getAspect();
    var request = elements.extraReq.value.trim();
    var count = state.imageCount || 1;

    clearResults();
    state.results = [];
    for (var i = 0; i < count; i++) {
      state.results.push({ status: "pending", imageUrls: [], error: "" });
    }
    renderResultCards();
    renderSourceCard();

    // 初始化断点
    state.checkpoint = {
      modeValue: state.modeValue,
      step: mode.value === "edit" ? "editing" : "composing",
      completedIndex: 0,
      results: state.results.map(function (r) { return { status: r.status, imageUrls: r.imageUrls, error: r.error, prompt: r.prompt || "" }; }),
      imageCount: count,
      extraReq: request,
      aspect: aspect
    };

    try {
      if (mode.value === "edit") {
        await runEditFlow(channel, request, quality, aspect, signal, count);
      } else if (mode.value === "compose") {
        await runComposeFlow(channel, quality, aspect, signal, count);
      }
    } catch (err) {
      // 停止路径：显式 abort 或已请求停止（含看门狗强制收尾后后台请求才超时的情况）
      if ((err && err.name === "AbortError") || state.stopRequested) {
        // 停止：标记未完成的任务，保存断点
        state.results.forEach(function (item) {
          if (item.status === "pending" || item.status === "running") {
            item.status = "stopped";
            item.error = "已停止";
            endResultTiming(item);
          }
        });
        state.results.forEach(function (_, i) { syncResultCard(i); });
        // 更新断点中的 results
        state.checkpoint.results = state.results.map(function (r) {
          return { status: r.status, imageUrls: r.imageUrls, error: r.error, prompt: r.prompt || "" };
        });
        saveCheckpoint();
        showStatus("已停止。已完成的图片不受影响，点击「继续」可接着生成。", false);
      } else {
        console.error("[img2img] 执行失败", err);
        showStatus("执行失败：" + (err && err.message ? err.message : "未知错误"), true);
        clearCheckpoint();
      }
    } finally {
      state.running = false;
      state.abortController = null;
      syncControls();
    }
  }

  /** 编辑模式执行流程：直接走「视觉模型改写提示词 → 生图」链路（与多图合成一致） */
  async function runEditFlow(channel, request, quality, aspect, signal, count) {
    await runFallbackEdit(channel, quality, aspect, signal, count);
  }

  /** 编辑模式：视觉模型根据原图与修改要求改写提示词 → 逐张生成 */
  async function runFallbackEdit(channel, quality, aspect, signal, count) {
    var flowStartedAt = Date.now();
    showRunStatus("通过视觉模型理解图片与修改要求...", false);
    state.checkpoint.step = "editing-fallback";
    saveCheckpoint();

    var editResult = await runVisionEdit(currentMode(), signal);
    var prompt = editResult.promptZh;

    for (var j = 0; j < count; j++) {
      checkAborted(signal);
      var r = state.results[j];
      if (r.status === "error" || r.status === "stopped" || r.status === "pending") {
        // 状态栏实时更新：提示词就绪 + 当前进度
        showRunStatus("" + (j + 1) + " / " + count + "...", false);
        r.status = "running";
        r.error = "";
        r.prompt = prompt;
        beginResultTiming(r);
        syncResultCard(j);
        try {
          var fallbackUrls = await generateWithRetry(channel, prompt, aspect, quality, signal, function (text) {
            r.progress = text; syncResultCard(j);
            // 状态栏同步实时进度（含已用时）
            showRunStatus("" + text, false);
          }, "新图 " + (j + 1) + "/" + count);
          r.imageUrls = fallbackUrls;
          r.status = "done";
          endResultTiming(r);
          syncResultCard(j);
          saveResultToGallery(r, j, channel, aspect);
          showDoneStatus("" + formatDuration(r.elapsedMs) + "。", false);

          state.checkpoint.completedIndex = j + 1;
          state.checkpoint.results = state.results.map(function (rr) {
            return { status: rr.status, imageUrls: rr.imageUrls, error: rr.error, prompt: rr.prompt || "" };
          });
          saveCheckpoint();
        } catch (genError) {
          if (genError && genError.name === "AbortError") throw genError;
          r.status = "error";
          r.error = genError && genError.message ? genError.message : "生成失败";
          endResultTiming(r);
          syncResultCard(j);
          showStatus("新图 " + (j + 1) + " / " + count + " 生成失败：" + r.error, true);
        }
        if (j < count - 1) await abortableSleep(1000, signal);
      }
    }
    clearCheckpoint();
    showDoneStatus("全部完成：成功 " + count + " 张，总用时 " + formatDuration(Date.now() - flowStartedAt) + "。可编辑新图下方提示词后「重新生成」，或点「继续编辑」再次改图。", false);
  }

  /** 合成模式执行流程 */
  async function runComposeFlow(channel, quality, aspect, signal, count) {
    showRunStatus("调用视觉模型理解图片与合成要求...", false);
    var composeResult = await runVisionEdit(currentMode(), signal);
    var composePrompt = composeResult.promptZh;

    state.checkpoint.step = "composing-generating";
    saveCheckpoint();

    showRunStatus("开始生成合成新图...");
    for (var m = 0; m < count; m++) {
      checkAborted(signal);
      var cr = state.results[m];
      cr.status = "running";
      cr.prompt = composePrompt;
      beginResultTiming(cr);
      syncResultCard(m);
      var clabel = "新图 " + (m + 1) + "/" + count;
      try {
        var cUrls = await generateWithRetry(channel, composePrompt, aspect, quality, signal, function (text) {
          cr.progress = text; syncResultCard(m);
        }, clabel);
        cr.imageUrls = cUrls;
        cr.status = "done";
        endResultTiming(cr);
        syncResultCard(m);
        saveResultToGallery(cr, m, channel, aspect);
        showDoneStatus(clabel + " 完成，用时 " + formatDuration(cr.elapsedMs) + "。", false);

        state.checkpoint.completedIndex = m + 1;
        state.checkpoint.results = state.results.map(function (rr) {
          return { status: rr.status, imageUrls: rr.imageUrls, error: rr.error, prompt: rr.prompt || "" };
        });
        saveCheckpoint();
      } catch (genError) {
        if (genError && genError.name === "AbortError") throw genError;
        cr.status = "error";
        cr.error = genError && genError.message ? genError.message : "生成失败";
        endResultTiming(cr);
        syncResultCard(m);
        showStatus(clabel + " 生成失败：" + cr.error, true);
      }
      if (m < count - 1) await abortableSleep(1000, signal);
    }
    clearCheckpoint();
    showDoneStatus("全部完成：成功生成 " + count + " 张合成新图。可编辑新图下方提示词后「重新生成」，或点「继续编辑」再次调整。", false);
  }

  /** 从断点恢复执行 */
  async function resumeFromCheckpoint() {
    var cp = state.checkpoint;
    if (!cp) return;
    var mode = findMode(cp.modeValue);
    if (!mode) { clearCheckpoint(); syncControls(); return; }

    // 恢复要求文本
    if (cp.extraReq) elements.extraReq.value = cp.extraReq;
    if (cp.imageCount) state.imageCount = cp.imageCount;

    // 恢复结果
    state.results = cp.results.map(function (r) {
      return { status: r.status, imageUrls: r.imageUrls || [], error: r.error || "", prompt: r.prompt || "", progress: "" };
    });
    renderResultCards();
    renderSourceCard();

    var modelValue = elements.imageModel.value;
    var channel = __APP.resolveImageChannel(modelValue).channel;
    var quality = elements.imageQuality && elements.imageQuality.value ? elements.imageQuality.value : "2K";
    var aspect = cp.aspect && (__APP.ASPECT_RATIOS || []).some(function (item) { return item.value === cp.aspect; }) ? cp.aspect : getAspect();
    var count = cp.imageCount || 1;
    var request = cp.extraReq || elements.extraReq.value.trim();

    state.running = true;
    state.runKind = "generate";
    state.abortController = new AbortController();
    var signal = state.abortController.signal;
    syncControls();
    showRunStatus("已完成 " + cp.completedIndex + " / " + count + " 张...", false);

    try {
      for (var idx = cp.completedIndex; idx < count; idx++) {
        checkAborted(signal);
        var result = state.results[idx];
        if (result.status === "done") continue; // 跳过已完成
        result.status = "running";
        result.error = "";
        beginResultTiming(result);
        syncResultCard(idx);
        var label = "新图 " + (idx + 1) + "/" + count;

        try {
          // 统一走生图链路；旧版断点的 "editing" 步骤也按生图处理
          if (cp.step === "editing" || cp.step === "editing-fallback" || cp.step === "composing" || cp.step === "composing-generating") {
            showStatus(label + "：正在生成...");
            urls = await generateWithRetry(channel, result.prompt || request, aspect, quality, signal, function (text) {
              result.progress = text; syncResultCard(idx);
            }, label);
          } else {
            throw new Error("未知断点步骤：" + cp.step);
          }

          result.imageUrls = urls;
          result.status = "done";
          endResultTiming(result);
          syncResultCard(idx);
          saveResultToGallery(result, idx, channel, aspect);
          showDoneStatus(label + " 完成，用时 " + formatDuration(result.elapsedMs) + "。", false);
          // 温馨小提示：每张生成成功后底部轻提示
          if (typeof __APP.showToast === "function") {
            __APP.showToast("✨ " + label + " 已生成（用时 " + formatDuration(result.elapsedMs) + "）");
          }

          state.checkpoint.completedIndex = idx + 1;
          state.checkpoint.results = state.results.map(function (r) {
            return { status: r.status, imageUrls: r.imageUrls, error: r.error, prompt: r.prompt || "" };
          });
          saveCheckpoint();
        } catch (genError) {
          if (genError && genError.name === "AbortError") throw genError;
          result.status = "error";
          result.error = genError && genError.message ? genError.message : "生成失败";
          endResultTiming(result);
          syncResultCard(idx);
          showStatus(label + " 生成失败：" + result.error, true);
        }
        if (idx < count - 1) await abortableSleep(1000, signal);
      }
      clearCheckpoint();
      showDoneStatus("断点恢复完成：成功生成 " + count + " 张图。可编辑新图下方提示词后「重新生成」，或点「继续编辑」再次调整。", false);
    } catch (err) {
      if ((err && err.name === "AbortError") || state.stopRequested) {
        state.results.forEach(function (item) {
          if (item.status === "pending" || item.status === "running") {
            item.status = "stopped";
            item.error = "已停止";
            endResultTiming(item);
          }
        });
        state.results.forEach(function (_, i) { syncResultCard(i); });
        state.checkpoint.results = state.results.map(function (r) {
          return { status: r.status, imageUrls: r.imageUrls, error: r.error, prompt: r.prompt || "" };
        });
        saveCheckpoint();
        showStatus("已停止。已完成的图片不受影响，点击「继续」可接着生成。", false);
      } else {
        console.error("[img2img] 续跑失败", err);
        showStatus("续跑失败：" + (err && err.message ? err.message : "未知错误"), true);
      }
    } finally {
      state.running = false;
      state.abortController = null;
      syncControls();
    }
  }

  /** 「清空重来」的两步确认状态：第一次点击进入待确认，3 秒内再点才真正清空 */
  var resetArmTimer = null;

  function resetAll() {
    // 有内容（图片/结果/断点/要求）时需要两步确认，避免手滑丢失跑了几分钟的任务
    var hasContent = state.images.length > 0
      || state.results.length > 0
      || !!state.checkpoint
      || (elements.extraReq.value || "").trim().length > 0;
    if (hasContent && !elements.resetButton.dataset.armed) {
      elements.resetButton.dataset.armed = "1";
      elements.resetButton.textContent = "确认清空？";
      elements.resetButton.classList.add("is-armed");
      clearTimeout(resetArmTimer);
      resetArmTimer = setTimeout(function () {
        delete elements.resetButton.dataset.armed;
        elements.resetButton.textContent = "清空重来";
        elements.resetButton.classList.remove("is-armed");
      }, 3000);
      showStatus("再点一次「确认清空？」才会清空全部内容（3 秒内有效）。", false);
      return;
    }
    // 两步确认通过：还原按钮状态并执行清空
    clearTimeout(resetArmTimer);
    delete elements.resetButton.dataset.armed;
    elements.resetButton.textContent = "清空重来";
    elements.resetButton.classList.remove("is-armed");
    // 先中止正在进行的操作
    state.stopRequested = true;
    if (state.abortController) {
      state.abortController.abort();
    }
    state.stopRequested = false;
    clearAllImages();
    state.extract = null;
    elements.extraReq.value = "";
    elements.extractResult.hidden = true;
    elements.promptZh.value = "";
    elements.promptEn.value = "";
    elements.extractSummary.textContent = "";
    clearResults();
    clearCheckpoint();
    try { window.localStorage.removeItem(__APP.STORAGE_KEYS.img2imgDraft); } catch (e) { /* ignore */ }
    showStatus("已清空，可重新开始。", false);
    syncControls();
  }

  // ==================== 界面同步 ====================

  /**
   * 状态栏语义显示：成功绿 / 失败红 / 进行中琥珀（带旋转图标），并支持内嵌跳转按钮
   * @param {string} text 状态文本
   * @param {boolean} isError 是否为错误
   * @param {Object} [opts] 可选 { running: 进行中, success: 成功, actionLabel/actionHref: 内嵌引导按钮 }
   */
  function showStatus(text, isError, opts) {
    var options = opts || {};
    elements.status.hidden = false;
    elements.status.classList.toggle("is-error", Boolean(isError));
    elements.status.classList.toggle("is-success", !isError && Boolean(options.success));
    elements.status.classList.toggle("is-running", Boolean(options.running));
    // 组装内容：进行中带旋转图标；错误提示中提到「设置页」时自动附带「去配置」跳转按钮
    elements.status.textContent = "";
    if (options.running) {
      var spinner = document.createElement("span");
      spinner.className = "status-spinner";
      elements.status.appendChild(spinner);
    }
    elements.status.appendChild(document.createTextNode(text));
    var needsConfigLink = Boolean(isError) && /设置页|请先配置|未配置/.test(text);
    if (needsConfigLink || options.actionHref) {
      var link = document.createElement("a");
      link.className = "status-action-link";
      link.href = options.actionHref || "settings.html";
      link.textContent = options.actionLabel || "去配置 →";
      elements.status.appendChild(link);
    }
  }

  /** 进行中状态的快捷封装（琥珀色 + 旋转图标） */
  function showRunStatus(text) {
    showStatus(text, false, { running: true });
  }

  /** 成功状态的快捷封装（绿色） */
  function showDoneStatus(text) {
    showStatus(text, false, { success: true });
  }

  /**
   * 停止看门狗：点击停止后 3 秒若流程仍未退出（请求挂死未响应 abort），
   * 强制结束运行状态并把未完成的结果标记为「已停止」，保证界面永远可恢复。
   */
  function forceStopIfNeeded() {
    if (!state.running) return;
    if (state.abortController) {
      try { state.abortController.abort(); } catch (e) { /* ignore */ }
    }
    state.running = false;
    state.abortController = null;
    state.results.forEach(function (item) {
      if (item.status === "pending" || item.status === "running") {
        item.status = "stopped";
        item.error = "已停止";
        endResultTiming(item);
      }
    });
    state.results.forEach(function (_, i) { syncResultCard(i); });
    if (state.checkpoint) {
      state.checkpoint.results = state.results.map(function (r) {
        return { status: r.status, imageUrls: r.imageUrls, error: r.error, prompt: r.prompt || "" };
      });
      saveCheckpoint();
      showStatus("已强制停止挂起的请求。已完成的图片不受影响，点击「继续」可接着生成。", false);
    } else {
      showStatus("已强制停止挂起的请求。", false);
    }
    syncControls();
  }

  function syncControls() {
    var mode = currentMode();
    var hasImages = state.images.length > 0;
    var hasCheckpoint = !!state.checkpoint;
    var canRun = hasImages && !state.running && !hasCheckpoint;

    if (mode && mode.needGeneration && !elements.extraReq.value.trim()) canRun = false;

    // 主按钮：有断点时隐藏，改用继续按钮
    elements.runButton.disabled = !canRun;
    elements.runButton.hidden = state.running || hasCheckpoint;

    // 继续按钮：有断点且未在运行时显示
    elements.continueButton.hidden = !hasCheckpoint || state.running;

    elements.stopButton.hidden = !state.running;
    elements.resetButton.hidden = state.running;
  }

  // ==================== 事件绑定 ====================

  /**
   * 初始化卡片折叠开关：点击标题条任意位置即可展开/收起，右侧的展开/收起按钮同样可用。
   * 标题条内的其他功能按钮（如「复制全部」）不受影响，点击它们不会触发折叠。
   * @param {string} toggleId 折叠按钮元素 ID
   * @param {string} bodyId 折叠内容区元素 ID
   */
  function initCollapseToggle(toggleId, bodyId) {
    var toggle = $(toggleId);
    var body = $(bodyId);
    if (!toggle || !body) return;
    // 标题条 = 按钮所在的头部容器（包含标题文字 + 右侧按钮组）
    var head = toggle.closest(".i2i-panel-head") || toggle.parentElement;

    function applyToggle() {
      var willExpand = body.hidden;
      body.hidden = !willExpand;
      toggle.textContent = willExpand ? "收起 ▴" : "展开 ▾";
      toggle.setAttribute("aria-expanded", willExpand ? "true" : "false");
    }

    // 整个标题条都可点击：命中其他按钮（复制全部等）时保持其原功能，不触发折叠
    head.addEventListener("click", function (event) {
      var clickedButton = event.target.closest("button");
      if (clickedButton && clickedButton !== toggle) return;
      applyToggle();
    });
  }

  function bindEvents() {
    // 上传
    elements.dropzone.addEventListener("click", function () { elements.fileInput.click(); });
    elements.dropzone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        elements.fileInput.click();
      }
    });
    elements.fileInput.addEventListener("change", function () {
      if (elements.fileInput.files) {
        for (var i = 0; i < elements.fileInput.files.length; i++) {
          addImage(elements.fileInput.files[i]);
        }
        elements.fileInput.value = "";
      }
    });
    ["dragenter", "dragover"].forEach(function (type) {
      elements.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        event.stopPropagation();
        elements.dropzone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      elements.dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        event.stopPropagation();
        elements.dropzone.classList.remove("is-dragover");
      });
    });
    elements.dropzone.addEventListener("drop", function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files) {
        for (var i = 0; i < files.length; i++) {
          addImage(files[i]);
        }
      }
    });
    document.addEventListener("paste", function (event) {
      var items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          var file = items[i].getAsFile();
          if (file) { event.preventDefault(); addImage(file); }
          return;
        }
      }
    });

    // 主按钮
    elements.runButton.addEventListener("click", startRun);
    elements.continueButton.addEventListener("click", startRun);
    // 快捷键：Ctrl+Enter 开始/继续，Esc 停止（输入框内同样生效）
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (!state.running && !elements.runButton.disabled) {
          event.preventDefault();
          startRun();
        }
        return;
      }
      if (event.key === "Escape" && state.running) {
        event.preventDefault();
        state.stopRequested = true;
        if (state.abortController) state.abortController.abort();
      }
    });
    elements.stopButton.addEventListener("click", function () {
      // 双保险：设置停止标志（循环内 checkAborted 可感知）+ 触发 abort 中断所有等待
      state.stopRequested = true;
      if (state.abortController) {
        try { state.abortController.abort(); } catch (e) { /* ignore */ }
      }
      // 看门狗：3 秒后若仍在运行（如请求挂死且未响应 abort），强制收尾界面
      window.setTimeout(forceStopIfNeeded, 3000);
    });
    elements.resetButton.addEventListener("click", resetAll);

    // 复制按钮
    elements.copyZh.addEventListener("click", function () {
      copyToClipboard(elements.promptZh.value, elements.copyZh);
    });
    elements.copyEn.addEventListener("click", function () {
      copyToClipboard(elements.promptEn.value, elements.copyEn);
    });
    elements.copyAll.addEventListener("click", function () {
      var text = "【中文提示词】\n" + elements.promptZh.value + "\n\n【English Prompt】\n" + elements.promptEn.value;
      copyToClipboard(text, elements.copyAll);
    });

    // 配置变更
    elements.extraReq.addEventListener("input", function () { syncControls(); persistDraft(); });
    elements.visionModel.addEventListener("input", function () { renderLlmInfo(); persistDraft(); });
    elements.imageModel.addEventListener("change", persistDraft);
    if (elements.imageQuality) elements.imageQuality.addEventListener("change", persistDraft);

    initCollapseToggle("i2i-config-toggle", "i2i-config-body");
    initCollapseToggle("i2i-extract-toggle", "i2i-extract-body");
  }

  function copyToClipboard(text, button) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      var original = button.textContent;
      button.textContent = "已复制";
      setTimeout(function () { button.textContent = original; }, 1200);
    }).catch(function (error) {
      console.error("[img2img] 复制失败", error);
    });
  }

  function initImageQualitySelect() {
    var select = elements.imageQuality;
    if (!select) return;
    var qualities = Array.isArray(__APP.IMAGE_QUALITIES) ? __APP.IMAGE_QUALITIES : [];
    select.innerHTML = qualities.map(function (item) {
      return '<option value="' + item.value + '">' + item.label + "</option>";
    }).join("");
    select.value = "2K";
    if (!select.value && qualities.length > 0) select.value = qualities[0].value;
    select.addEventListener("change", persistDraft);
  }

  /** 初始化「生图尺寸」下拉：选项与文生图完全一致（__APP.ASPECT_RATIOS），默认 1:1 */
  function initAspectSelect() {
    var select = elements.aspect;
    if (!select) return;
    var ratios = Array.isArray(__APP.ASPECT_RATIOS) ? __APP.ASPECT_RATIOS : [];
    select.innerHTML = ratios.map(function (item) {
      return '<option value="' + item.value + '">' + item.label + "</option>";
    }).join("");
    select.value = "1:1";
    select.addEventListener("change", persistDraft);
  }

  /** 读取当前生图尺寸（仅修改/合成模式使用；异常时回退 1:1） */
  function getAspect() {
    var value = elements.aspect && elements.aspect.value ? elements.aspect.value : "1:1";
    var valid = (__APP.ASPECT_RATIOS || []).some(function (item) { return item.value === value; });
    return valid ? value : "1:1";
  }

  function initImageModelSelect() {
    var select = elements.imageModel;
    // 按通道分组的二级下拉（一级通道，二级模型）
    var options = __APP.renderModelSelectOptions(select, "暂无可用生图通道，请先到设置页启用");
    if (!select.value) select.value = options.length > 0 ? options[0].value : "";
  }

  // ==================== 页面入口 ====================

  function init() {
    elements = {
      dropzone: $("i2i-dropzone"),
      fileInput: $("i2i-file-input"),
      multiPreview: $("i2i-multi-preview"),
      modeCards: $("i2i-mode-cards"),
      extraReq: $("i2i-extra-req"),
      reqPanel: $("i2i-req-panel"),
      reqLabel: $("i2i-req-label"),
      clearReq: $("i2i-clear-req"),
      visionModel: $("i2i-vision-model"),
      imageModel: $("i2i-image-model"),
      imageQuality: $("i2i-image-quality"),
      aspectBlock: $("i2i-aspect-block"),
      aspect: $("i2i-aspect"),
      dropzoneNote: $("i2i-dropzone-note"),
      llmInfo: $("i2i-llm-info"),
      runButton: $("i2i-run"),
      continueButton: $("i2i-continue"),
      stopButton: $("i2i-stop"),
      resetButton: $("i2i-reset"),
      status: $("i2i-status"),
      extractResult: $("i2i-extract-result"),
      extractBody: $("i2i-extract-body"),
      extractToggle: $("i2i-extract-toggle"),
      extractSummary: $("i2i-extract-summary"),
      promptZh: $("i2i-prompt-zh"),
      promptEn: $("i2i-prompt-en"),
      copyZh: $("i2i-copy-zh"),
      copyEn: $("i2i-copy-en"),
      copyAll: $("i2i-copy-all"),
      resultsGrid: $("i2i-results-grid"),
      resultCardTemplate: $("i2i-result-card-template")
    };
    if (!elements.dropzone) return;

    renderModeCards();
    initImageQualitySelect();
    initAspectSelect();
    initImageModelSelect();
    renderLlmInfo();
    restoreDraft();
    syncModeUI();

    // 描述要求：一键清空
    if (elements.clearReq) {
      elements.clearReq.addEventListener("click", function () {
        elements.extraReq.value = "";
      });
    }

    // 恢复断点
    var savedCp = loadCheckpoint();
    if (savedCp) {
      state.checkpoint = savedCp;
      // 恢复之前的模式
      if (savedCp.modeValue && savedCp.modeValue !== state.modeValue) {
        state.modeValue = savedCp.modeValue;
        renderModeCards();
        syncModeUI();
      }
      // 恢复结果到界面
      if (savedCp.results && savedCp.results.length > 0) {
        state.results = savedCp.results.map(function (r) {
          return { status: r.status, imageUrls: r.imageUrls || [], error: r.error || "", prompt: r.prompt || "", progress: "" };
        });
        renderResultCards();
        renderSourceCard();
      }
      showStatus("检测到未完成的断点，已完成 " + savedCp.completedIndex + " / " + (savedCp.imageCount || savedCp.results.length) + " 张，点击「继续」可接着生成。", false);
    }

    bindEvents();
    syncControls();

    // 秒级定时器：生成中的结果卡每秒刷新一次实时耗时显示
    window.setInterval(function () {
      for (var i = 0; i < state.results.length; i++) {
        if (state.results[i].status === "running") syncResultCard(i);
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();