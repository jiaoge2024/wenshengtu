(function () {
  var STORAGE_KEYS = window.__APP ? window.__APP.STORAGE_KEYS : {};
  var CHANNEL_TYPES = window.__APP ? window.__APP.CHANNEL_TYPES : [];
  var CHANNEL_MODES = window.__APP ? window.__APP.CHANNEL_MODES : [];

  var elements = {
    nav: document.getElementById("channel-nav"),
    navButtons: function () {
      return Array.from((elements.nav || document).querySelectorAll("[data-channel]"));
    },
    panels: function () {
      return Array.from(document.querySelectorAll("[data-channel-panel]"));
    },
    channelList: document.getElementById("image-channel-list"),
    addChannelBtn: document.getElementById("add-image-channel-btn"),
    clearSettings: document.getElementById("clear-settings"),
    status: document.getElementById("settings-status")
  };

  var activeChannelId = "image-channels";

  // ==================== 通用工具 ====================

  function setStatus(text) {
    if (elements.status) {
      elements.status.textContent = text;
    }
  }

  function escapeHtml(text) {
    return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * 包装 fetch 网络错误，把浏览器原始的 "Failed to fetch" 转换成带上下文的可读信息
   */
  function wrapFetchError(error, context, endpoint) {
    if (error && error.name === "AbortError") return error;
    var message = error && error.message ? String(error.message) : "未知网络错误";
    if (/failed to fetch|fetch failed|networkerror|network error|无法访问|abort|timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      return new Error(context + "失败：无法连接到 " + endpoint + "。请检查网络、Base URL 拼写、跨域拦截或本地代理设置。");
    }
    return new Error(context + "失败：" + message + " (请求地址：" + endpoint + ")");
  }

  function switchChannel(channelId) {
    if (channelId === activeChannelId) return;
    activeChannelId = channelId;
    elements.navButtons().forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.channel === channelId);
    });
    elements.panels().forEach(function (panel) {
      panel.classList.toggle("is-active", panel.dataset.channelPanel === channelId);
    });
  }

  // ==================== 生图通道管理 ====================

  function getChannels() {
    return window.__APP ? window.__APP.getImageChannels() : [];
  }

  function saveChannels(channels) {
    if (window.__APP) {
      window.__APP.saveImageChannels(channels);
    }
  }

  function renderChannelList() {
    if (!elements.channelList) return;
    var channels = getChannels();
    if (channels.length === 0) {
      elements.channelList.innerHTML = '<p class="empty-hint">还没有配置生图通道，点击下方按钮新增。</p>';
      return;
    }

    elements.channelList.innerHTML = channels.map(function (ch) {
      return renderChannelCard(ch);
    }).join("");

    // 绑定每个通道卡片的事件
    channels.forEach(function (ch) {
      bindChannelCardEvents(ch.id);
    });
  }

  /**
   * 根据通道类型/名称返回 API Key 获取地址提示
   * @param {Object} ch 通道对象
   * @returns {string} 提示文本
   */
  function getChannelApiKeyHint(ch) {
    if (ch.type === "agnes") {
      return 'API Key 获取：<a href="https://agnes-ai.cn" target="_blank" rel="noopener">agnes-ai.cn</a>（国内站）/ <a href="https://agnes-ai.com" target="_blank" rel="noopener">agnes-ai.com</a>（国际站）';
    }
    if (ch.type === "openai_images") {
      var name = (ch.name || "").toLowerCase();
      if (name.indexOf("中转") !== -1) {
        return 'API Key 获取：<a href="https://apimart.ai/" target="_blank" rel="noopener">apimart.ai</a>（需魔法）';
      }
      if (name.indexOf("wawapii") !== -1) {
        return 'API Key 获取：<a href="https://wawapi.top/" target="_blank" rel="noopener">wawapi.top</a>（需魔法）';
      }
      return "API Key 获取：请到你的 API 服务商后台获取";
    }
    return "";
  }

  function renderChannelCard(ch) {
    var typeOptions = CHANNEL_TYPES.map(function (t) {
      return '<option value="' + t.value + '"' + (ch.type === t.value ? " selected" : "") + ">" + escapeHtml(t.label) + "</option>";
    }).join("");

    var modeOptions = CHANNEL_MODES.map(function (m) {
      return '<option value="' + m.value + '"' + (ch.mode === m.value ? " selected" : "") + ">" + escapeHtml(m.label) + "</option>";
    }).join("");

    var showBaseUrl = true;
    var showMode = ch.type === "openai_images";
    var statusBadge = ch.enabled
      ? '<span class="ch-badge ch-badge-on">已启用</span>'
      : '<span class="ch-badge ch-badge-off">已停用</span>';

    // 未配置完成的通道默认展开，已配置完成的默认折叠，减少视觉压力
    var isConfigured = !!(ch.apiKey && ch.model);
    var collapsedClass = isConfigured ? "is-collapsed" : "is-expanded";
    var toggleIcon = isConfigured ? "▾" : "▾";
    var toggleLabel = isConfigured ? "展开配置" : "折叠配置";

    return '<div class="image-channel-card ' + collapsedClass + '" data-channel-id="' + escapeHtml(ch.id) + '">'
      + '<div class="ch-card-header">'
      + '  <span class="ch-card-icon">◈</span>'
      + '  <span class="ch-card-name">' + escapeHtml(ch.name || "未命名通道") + '</span>'
      + '  ' + statusBadge
      + '  <button type="button" class="ch-toggle-btn" aria-label="' + toggleLabel + '" aria-expanded="' + (!isConfigured) + '" title="' + toggleLabel + '">' + toggleIcon + '</button>'
      + '</div>'
      + '<div class="ch-card-body">'
      // 通道名称
      + '  <div class="ch-field-row">'
      + '    <label class="ch-field-label">通道名称</label>'
      + '    <input class="text-input ch-name-input" type="text" value="' + escapeHtml(ch.name || "") + '" placeholder="例如：wawapi 生图" data-field="name" />'
      + '  </div>'
      // 类型 + 模式
      + '  <div class="ch-field-grid">'
      + '    <div class="ch-field-row">'
      + '      <label class="ch-field-label">接口类型</label>'
      + '      <select class="text-input ch-type-select" data-field="type">' + typeOptions + '</select>'
      + '    </div>'
      + '    <div class="ch-field-row ch-mode-field"' + (showMode ? "" : ' style="display:none;"') + '>'
      + '      <label class="ch-field-label">出图模式</label>'
      + '      <select class="text-input ch-mode-select" data-field="mode">' + modeOptions + '</select>'
      + '    </div>'
      + '  </div>'
      // Base URL
      + '  <div class="ch-field-row ch-baseurl-field"' + (showBaseUrl ? "" : ' style="display:none;"') + '>'
      + '    <label class="ch-field-label">Base URL</label>'
      + '    <input class="text-input ch-baseurl-input" type="url" value="' + escapeHtml(ch.baseUrl || "") + '" placeholder="例如：https://wawapii.com" data-field="baseUrl" />'
      + '  </div>'
      // API Key
      + '  <div class="ch-field-row">'
      + '    <label class="ch-field-label">API Key</label>'
      + '    <input class="text-input ch-apikey-input" type="password" value="' + escapeHtml(ch.apiKey || "") + '" placeholder="输入 API Key" data-field="apiKey" />'
      + '    <p class="ch-field-note">' + getChannelApiKeyHint(ch) + '</p>'
      + '  </div>'
      // 模型名
      + '  <div class="ch-field-row">'
      + '    <label class="ch-field-label">模型名</label>'
      + '    <input class="text-input ch-model-input" type="text" value="' + escapeHtml(ch.model || "") + '" placeholder="例如：gpt-image-2" data-field="model" />'
      + '  </div>'
      + '</div>'
      // 操作按钮
      + '<div class="ch-card-actions">'
      + '  <label class="ch-toggle-label">'
      + '    <input type="checkbox" class="ch-enabled-toggle"' + (ch.enabled ? " checked" : "") + ' data-field="enabled" />'
      + '    <span>启用</span>'
      + '  </label>'
      + '  <span class="ch-action-spacer"></span>'
      + '  <button type="button" class="ghost-button small-button ch-save-btn">保存</button>'
      + '  <button type="button" class="ghost-button small-button ch-test-btn">测试</button>'
      + '  <button type="button" class="ghost-button small-button danger ch-delete-btn">删除</button>'
      + '</div>'
      + '<div class="ch-test-result" data-test-result></div>'
      + '</div>';
  }

  /**
   * 切换通道卡片的展开/折叠状态
   * @param {string} channelId 通道 ID
   */
  function toggleChannelCard(channelId) {
    var card = elements.channelList.querySelector('[data-channel-id="' + channelId + '"]');
    if (!card) return;
    var isCollapsed = card.classList.contains("is-collapsed");
    if (isCollapsed) {
      card.classList.remove("is-collapsed");
      card.classList.add("is-expanded");
    } else {
      card.classList.remove("is-expanded");
      card.classList.add("is-collapsed");
    }
    var toggleBtn = card.querySelector(".ch-toggle-btn");
    if (toggleBtn) {
      var nowCollapsed = !isCollapsed;
      toggleBtn.setAttribute("aria-expanded", String(!nowCollapsed));
      toggleBtn.setAttribute("aria-label", nowCollapsed ? "展开配置" : "折叠配置");
      toggleBtn.setAttribute("title", nowCollapsed ? "展开配置" : "折叠配置");
    }
  }

  function bindChannelCardEvents(channelId) {
    var card = elements.channelList.querySelector('[data-channel-id="' + channelId + '"]');
    if (!card) return;

    // 头部点击切换展开/折叠（但点击按钮时不触发）
    var header = card.querySelector(".ch-card-header");
    if (header) {
      header.addEventListener("click", function (event) {
        if (event.target.closest(".ch-toggle-btn") || event.target.closest("button")) {
          return;
        }
        toggleChannelCard(channelId);
      });
    }

    var toggleBtn = card.querySelector(".ch-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        toggleChannelCard(channelId);
      });
    }

    // 类型变化时显示/隐藏模式字段和 Base URL 字段
    var typeSelect = card.querySelector(".ch-type-select");
    if (typeSelect) {
      typeSelect.addEventListener("change", function () {
        var isOpenai = typeSelect.value === "openai_images";
        var modeField = card.querySelector(".ch-mode-field");
        if (modeField) modeField.style.display = isOpenai ? "" : "none";
      });
    }

    // 保存按钮
    var saveBtn = card.querySelector(".ch-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        saveChannelFromCard(channelId);
      });
    }

    // 测试按钮
    var testBtn = card.querySelector(".ch-test-btn");
    if (testBtn) {
      testBtn.addEventListener("click", function () {
        testChannelFromCard(channelId);
      });
    }

    // 删除按钮
    var deleteBtn = card.querySelector(".ch-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", function () {
        deleteChannel(channelId);
      });
    }
  }

  function readChannelFromCard(channelId) {
    var card = elements.channelList.querySelector('[data-channel-id="' + channelId + '"]');
    if (!card) return null;

    return {
      id: channelId,
      name: (card.querySelector(".ch-name-input") || {}).value || "",
      type: (card.querySelector(".ch-type-select") || {}).value || "openai_images",
      mode: (card.querySelector(".ch-mode-select") || {}).value || "auto",
      baseUrl: (card.querySelector(".ch-baseurl-input") || {}).value || "",
      apiKey: (card.querySelector(".ch-apikey-input") || {}).value || "",
      model: (card.querySelector(".ch-model-input") || {}).value || "",
      enabled: (card.querySelector(".ch-enabled-toggle") || {}).checked || false
    };
  }

  function saveChannelFromCard(channelId) {
    var updated = readChannelFromCard(channelId);
    if (!updated) return;

    if (!updated.name.trim()) {
      setStatus("通道名称不能为空");
      return;
    }

    var channels = getChannels();
    var index = channels.findIndex(function (ch) { return ch.id === channelId; });
    if (index === -1) return;

    // 保留 builtin 标记
    updated.builtin = channels[index].builtin;
    channels[index] = updated;
    saveChannels(channels);
    renderChannelList();
    setStatus("通道「" + updated.name + "」已保存 — " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
  }

  function deleteChannel(channelId) {
    var channels = getChannels();
    var ch = channels.find(function (c) { return c.id === channelId; });
    if (!ch) return;

    var name = ch.name || "此通道";
    if (!window.confirm("确定删除通道「" + name + "」吗？")) return;

    var next = channels.filter(function (c) { return c.id !== channelId; });
    saveChannels(next);
    renderChannelList();
    setStatus("通道「" + name + "」已删除");
  }

  function addChannel() {
    var channels = getChannels();
    var newCh = {
      id: window.__APP.createChannelId(),
      name: "新通道 " + (channels.length + 1),
      type: "openai_images",
      mode: "auto",
      baseUrl: "",
      apiKey: "",
      model: "",
      enabled: false,
      builtin: false
    };
    channels.push(newCh);
    saveChannels(channels);
    renderChannelList();
    enhanceApiKeyInputs();
    setStatus("已新增通道「" + newCh.name + "」，请填写配置后保存");

    // 滚动到新通道
    setTimeout(function () {
      var card = elements.channelList.querySelector('[data-channel-id="' + newCh.id + '"]');
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        var nameInput = card.querySelector(".ch-name-input");
        if (nameInput) nameInput.focus();
      }
    }, 100);
  }

  async function testChannelFromCard(channelId) {
    var card = elements.channelList.querySelector('[data-channel-id="' + channelId + '"]');
    if (!card) return;
    var resultEl = card.querySelector("[data-test-result]");
    if (resultEl) {
      resultEl.innerHTML = '<span class="test-status is-testing">正在测试，请稍等...</span>';
    }

    var ch = readChannelFromCard(channelId);
    if (!ch) return;

    if (!ch.apiKey.trim()) {
      if (resultEl) resultEl.innerHTML = '<span class="test-status is-error">请先填写 API Key</span>';
      return;
    }
    if (!ch.model.trim()) {
      if (resultEl) resultEl.innerHTML = '<span class="test-status is-error">请先填写模型名</span>';
      return;
    }

    try {
      var controller = new AbortController();
      var timeoutId = window.setTimeout(function () { controller.abort(); }, 120000);

      var images = await callImageChannel(ch, "测试生图：一只可爱的小猫", "1:1", "1K", controller.signal);
      window.clearTimeout(timeoutId);

      if (images && images.length > 0) {
        if (resultEl) resultEl.innerHTML = '<span class="test-status is-success">测试成功！获得 ' + images.length + ' 张图片 ✅</span>';
        setStatus("通道「" + ch.name + "」测试成功");
      } else {
        throw new Error("API 返回但没有拿到图片数据");
      }
    } catch (error) {
      var msg = error && error.message ? error.message : "未知错误";
      if (error && (error.name === "AbortError" || /aborted|timeout/i.test(msg))) {
        msg = "测试超时（超过 120 秒），请检查配置或网络";
      }
      if (resultEl) resultEl.innerHTML = '<span class="test-status is-error">测试失败：' + escapeHtml(msg) + "</span>";
      setStatus("通道「" + ch.name + "」测试失败");
    }
  }

  /**
   * 统一的生图通道调用（同步+异步自动适配）
   */
  async function callImageChannel(ch, prompt, aspectRatio, imageQuality, signal) {
    var baseUrl = (ch.baseUrl || "").replace(/\/+$/, "");
    var apiKey = ch.apiKey.trim();
    var model = ch.model.trim();

    if (!apiKey) {
      throw new Error("请先填写 API Key");
    }
    if (!model) {
      throw new Error("请先填写模型名");
    }
    if (!baseUrl) {
      throw new Error("Base URL 不能为空，请填写完整地址（例如 https://api.apimart.ai）");
    }

    if (ch.type === "openai_images") {
      var endpoint = baseUrl;
      if (!/\/images\/generations/.test(endpoint)) {
        endpoint += /\/v1(?:[\/?#]|$)/.test(endpoint) ? "/images/generations" : "/v1/images/generations";
      }

      /**
       * 执行一次 OpenAI Images 格式请求
       * @param {string} sizeFormat "pixels" | "ratio"
       */
      async function callOnce(sizeFormat) {
        var payload = {
          model: model,
          prompt: prompt,
          n: 1,
          size: window.__APP.getGptImageSize(aspectRatio, imageQuality, sizeFormat),
          resolution: (imageQuality || "2K").toLowerCase()
        };
        var res = await window.__APP.proxyFetch(endpoint, {
          method: "POST",
          signal: signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
          },
          body: JSON.stringify(payload)
        });
        var resData = await res.json();
        return { response: res, data: resData };
      }

      var response, data;
      try {
        var firstTry = await callOnce("pixels");
        response = firstTry.response;
        data = firstTry.data;
      } catch (networkError) {
        throw wrapFetchError(networkError, "通道测试", endpoint);
      }

      // size 格式错误时自动改用比例尺寸重试
      if (!response.ok || (data && data.code >= 400)) {
        var firstErrMsg = data && data.error && data.error.message ? data.error.message : "";
        if (window.__APP.isGptImageSizeFormatError(firstErrMsg)) {
          try {
            var secondTry = await callOnce("ratio");
            response = secondTry.response;
            data = secondTry.data;
          } catch (networkError) {
            throw wrapFetchError(networkError, "通道测试（比例尺寸重试）", endpoint);
          }
        }
      }

      if (!response.ok || (data && data.code >= 400)) {
        var msg = "请求失败（HTTP " + response.status + "）";
        if (data) {
          if (data.error && data.error.message) {
            msg = data.error.message;
          } else if (data.message) {
            msg = data.message;
          } else if (data.detail) {
            msg = data.detail;
          } else if (typeof data.error === "string" && data.error) {
            msg = data.error;
          } else if (typeof data === "string") {
            msg = data;
          } else {
            try { msg = JSON.stringify(data).slice(0, 500); } catch (e) { /* keep default */ }
          }
        }
        throw new Error("通道「" + ch.name + "」请求失败（HTTP " + response.status + "）：" + msg);
      }

      // 检查是否有 task_id（异步模式）
      var firstData = data && Array.isArray(data.data) ? data.data[0] : null;
      var taskId = firstData && firstData.task_id;

      if (ch.mode === "async" || (ch.mode === "auto" && taskId)) {
        // 异步模式：轮询任务结果
        return pollTaskResult(taskId, baseUrl, apiKey, signal);
      }

      // 同步模式：直接提取图片
      return extractSyncImages(data);
    }

    if (ch.type === "agnes") {
      var agnesEndpoint = baseUrl;
      if (!/\/images\/generations/.test(agnesEndpoint)) {
        agnesEndpoint += /\/v1(?:[\/?#]|$)/.test(agnesEndpoint) ? "/images/generations" : "/v1/images/generations";
      }

      var agnesPayload = {
        model: model,
        prompt: prompt,
        size: window.__APP.normalizeImageQuality(imageQuality),
        ratio: aspectRatio || "1:1",
        extra_body: { response_format: "url" }
      };

      var agnesRes;
      try {
        agnesRes = await window.__APP.proxyFetch(agnesEndpoint, {
          method: "POST",
          signal: signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
          },
          body: JSON.stringify(agnesPayload)
        });
      } catch (networkError) {
        throw wrapFetchError(networkError, "Agnes 通道测试", agnesEndpoint);
      }

      var agnesData = await agnesRes.json();
      if (!agnesRes.ok) {
        var agnesErrDetail = "未知错误";
        if (agnesData) {
          if (agnesData.error && agnesData.error.message) {
            agnesErrDetail = agnesData.error.message;
          } else if (agnesData.message) {
            agnesErrDetail = agnesData.message;
          } else if (agnesData.detail) {
            agnesErrDetail = agnesData.detail;
          } else if (typeof agnesData.error === "string" && agnesData.error) {
            agnesErrDetail = agnesData.error;
          } else if (typeof agnesData === "string") {
            agnesErrDetail = agnesData;
          } else {
            try { agnesErrDetail = JSON.stringify(agnesData).slice(0, 500); } catch (e) { /* keep default */ }
          }
        }
        throw new Error("通道「" + ch.name + "」请求失败（HTTP " + agnesRes.status + "）：" + agnesErrDetail);
      }

      var agnesFirst = agnesData && Array.isArray(agnesData.data) && agnesData.data.length > 0 ? agnesData.data[0] : null;
      var agnesImages = [];
      if (agnesFirst) {
        if (agnesFirst.url) agnesImages.push(agnesFirst.url);
        else if (agnesFirst.b64_json) agnesImages.push("data:image/png;base64," + agnesFirst.b64_json);
      }
      return agnesImages;
    }

    throw new Error("不支持的通道类型：" + ch.type);
  }

  function extractSyncImages(data) {
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

  async function pollTaskResult(taskId, baseUrl, apiKey, signal) {
    var normalizedBaseUrl = (baseUrl || "").replace(/\/+$/, "");
    var taskEndpoint;
    if (!normalizedBaseUrl) {
      throw new Error("Base URL 为空，无法构建任务轮询地址");
    }
    if (/\/images\/generations(?:[?#].*)?$/.test(normalizedBaseUrl)) {
      taskEndpoint = normalizedBaseUrl.replace(/\/images\/generations(?:[?#].*)?$/, "/tasks/" + encodeURIComponent(taskId));
    } else if (/\/v1(?:[\/?#]|$)/.test(normalizedBaseUrl)) {
      taskEndpoint = normalizedBaseUrl + "/tasks/" + encodeURIComponent(taskId);
    } else {
      taskEndpoint = normalizedBaseUrl + "/v1/tasks/" + encodeURIComponent(taskId);
    }

    var startedAt = Date.now();
    var timeout = 10 * 60 * 1000;

    await new Promise(function (resolve) { setTimeout(resolve, 5000); });

    while (Date.now() - startedAt <= timeout) {
      var res;
      try {
        res = await window.__APP.proxyFetch(taskEndpoint, {
          method: "GET",
          signal: signal,
          headers: { "Authorization": "Bearer " + apiKey }
        });
      } catch (networkError) {
        throw wrapFetchError(networkError, "任务结果查询", taskEndpoint);
      }
      var data = await res.json();
      if (!res.ok) {
        throw new Error(data && data.error && data.error.message ? data.error.message : "任务查询失败");
      }

      var taskData = data && Array.isArray(data.data) ? data.data[0] : (data.data || data);
      var status = String(taskData && taskData.status || "").toLowerCase();

      if (["completed", "succeeded", "success", "done"].indexOf(status) !== -1) {
        var resultImages = taskData && taskData.result && Array.isArray(taskData.result.images) ? taskData.result.images : [];
        var images = resultImages.flatMap(function (item) {
          if (typeof item === "string") return [item];
          if (item && typeof item.b64_json === "string") return ["data:image/png;base64," + item.b64_json];
          if (item && typeof item.url === "string") return [item.url];
          return [];
        });
        if (images.length === 0) throw new Error("任务完成但没有返回图片");
        return images;
      }

      if (["failed", "error", "cancelled", "canceled"].indexOf(status) !== -1) {
        throw new Error(taskData && taskData.error && taskData.error.message ? taskData.error.message : "任务生成失败");
      }

      await new Promise(function (resolve) { setTimeout(resolve, 4000); });
    }

    throw new Error("任务等待超时");
  }

  // ==================== 辅助模型配置（一键优化提示词） ====================

  var PRESETS = window.__APP && window.__APP.LLM_PROVIDER_PRESETS ? window.__APP.LLM_PROVIDER_PRESETS : [];

  function getPreset(id) { return PRESETS.find(function (p) { return p.id === id; }); }
  function getPresetName(id) {
    var preset = getPreset(id);
    if (preset) return preset.name;
    return id;
  }
  function getProviders() { return window.__APP ? window.__APP.getLlmProviders() : []; }
  function saveProviders(providers) { if (window.__APP) window.__APP.saveLlmProviders(providers); }

  // 三个固定平台，每个平台独立一张卡片
  var LLM_PROVIDER_IDS = ["deepseek", "MiniMax", "custom"];

  /**
   * 确保 provider 列表始终包含三个平台，缺失时用默认模板补齐
   * @returns {Array} 规范化后的 provider 数组
   */
  function normalizeProviders() {
    var providers = getProviders();
    var defaults = window.__APP && window.__APP.getDefaultLlmProviders ? window.__APP.getDefaultLlmProviders() : [];
    var result = LLM_PROVIDER_IDS.map(function (id) {
      var existing = providers.find(function (p) { return p.id === id; });
      var def = defaults.find(function (p) { return p.id === id; });
      if (existing) {
        return {
          id: existing.id,
          name: (def && def.name) || existing.name || id,
          apiKey: existing.apiKey || "",
          baseUrl: existing.baseUrl || (def ? def.baseUrl : ""),
          format: existing.format || (def ? def.format : "openai"),
          models: Array.isArray(existing.models) && existing.models.length > 0 ? existing.models : (def ? def.models.slice() : [""])
        };
      }
      return def ? JSON.parse(JSON.stringify(def)) : { id: id, name: id, apiKey: "", baseUrl: "", format: "openai", models: [""] };
    });
    return result;
  }

  /**
   * 渲染 AI 助手模型列表（每个平台一张可展开/折叠的卡片）
   */
  function renderProviderList() {
    var listEl = document.getElementById("llm-provider-list");
    if (!listEl) return;
    var providers = normalizeProviders();
    listEl.innerHTML = providers.map(function (p) {
      return renderProviderCard(p);
    }).join("");
    providers.forEach(function (p) {
      bindProviderCardEvents(p.id);
    });
  }

  /**
   * 生成单个 provider 卡片 HTML
   * @param {Object} provider
   * @returns {string}
   */
  function renderProviderCard(provider) {
    var preset = getPreset(provider.id);
    var badgeClass = provider.id === "custom" ? "ch-badge ch-badge-off" : "ch-badge ch-badge-on";
    var badgeText = provider.id === "custom" ? "自定义" : getPresetName(provider.id);
    var model = provider.models && provider.models[0] ? provider.models[0] : "";
    var apiKeyHint = preset ? (preset.apiKeyHint || "") : "填写你的服务商提供的 API Key";
    var isConfigured = !!(provider.apiKey && model);
    var collapsedClass = isConfigured ? "is-collapsed" : "is-expanded";
    var placeholderModel = provider.id === "deepseek" ? "例如 deepseek-chat" : (provider.id === "MiniMax" ? "例如 MiniMax-Text-01" : "输入模型名称");
    var placeholderBase = preset && preset.baseUrl ? preset.baseUrl : "https://...";
    var optimizeProviderId = window.localStorage.getItem(STORAGE_KEYS.optimizeProvider) || "deepseek";
    var isActive = optimizeProviderId === provider.id;

    return '<div class="image-channel-card ' + collapsedClass + '" data-provider-id="' + escapeHtml(provider.id) + '">'
      + '<div class="ch-card-header">'
      + '  <span class="ch-card-icon">⚙</span>'
      + '  <span class="ch-card-name">' + escapeHtml(getPresetName(provider.id)) + '</span>'
      + '  <span class="' + badgeClass + '">' + escapeHtml(badgeText) + '</span>'
      + '  <button type="button" class="ch-toggle-btn" aria-label="展开配置" aria-expanded="' + (!isConfigured) + '" title="展开配置">▾</button>'
      + '</div>'
      + '<div class="ch-card-body">'
      // 接口地址
      + '  <div class="ch-field-row">'
      + '    <label class="ch-field-label">接口地址</label>'
      + '    <input class="text-input ch-provider-baseurl" type="url" value="' + escapeHtml(provider.baseUrl || "") + '" placeholder="' + escapeHtml(placeholderBase) + '" data-provider-field="baseUrl" />'
      + '  </div>'
      // API Key
      + '  <div class="ch-field-row">'
      + '    <label class="ch-field-label">API Key</label>'
      + '    <input class="text-input ch-provider-apikey" type="password" value="' + escapeHtml(provider.apiKey || "") + '" placeholder="输入 API Key" data-provider-field="apiKey" />'
      + '    <p class="ch-field-note">' + apiKeyHint + '</p>'
      + '  </div>'
      // 模型名
      + '  <div class="ch-field-row">'
      + '    <label class="ch-field-label">模型名</label>'
      + '    <input class="text-input ch-provider-model" type="text" value="' + escapeHtml(model) + '" placeholder="' + escapeHtml(placeholderModel) + '" data-provider-field="model" />'
      + '  </div>'
      + '</div>'
      // 操作按钮
      + '<div class="ch-card-actions">'
      + '  <label class="ch-toggle-label">'
      + '    <input type="radio" name="optimize-provider" value="' + escapeHtml(provider.id) + '" class="ch-provider-active-radio"' + (isActive ? " checked" : "") + ' />'
      + '    <span>设为当前使用</span>'
      + '  </label>'
      + '  <span class="ch-action-spacer"></span>'
      + '  <button type="button" class="ghost-button small-button ch-provider-save-btn">保存</button>'
      + '  <button type="button" class="ghost-button small-button ch-provider-test-btn">测试</button>'
      + '</div>'
      + '<div class="ch-test-result" data-provider-test-result></div>'
      + '</div>';
  }

  /**
   * 切换 provider 卡片展开/折叠
   * @param {string} providerId
   */
  function toggleProviderCard(providerId) {
    var card = document.querySelector('#llm-provider-list [data-provider-id="' + providerId + '"]');
    if (!card) return;
    var isCollapsed = card.classList.contains("is-collapsed");
    card.classList.toggle("is-collapsed", !isCollapsed);
    card.classList.toggle("is-expanded", isCollapsed);
    var toggleBtn = card.querySelector(".ch-toggle-btn");
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", String(!isCollapsed));
      toggleBtn.setAttribute("aria-label", isCollapsed ? "折叠配置" : "展开配置");
      toggleBtn.setAttribute("title", isCollapsed ? "折叠配置" : "展开配置");
    }
  }

  /**
   * 从卡片 DOM 读取 provider 配置
   * @param {string} providerId
   * @returns {Object|null}
   */
  function readProviderFromCard(providerId) {
    var card = document.querySelector('#llm-provider-list [data-provider-id="' + providerId + '"]');
    if (!card) return null;
    var baseUrlInput = card.querySelector('[data-provider-field="baseUrl"]');
    var apiKeyInput = card.querySelector('[data-provider-field="apiKey"]');
    var modelInput = card.querySelector('[data-provider-field="model"]');
    var preset = getPreset(providerId);
    var baseUrl = baseUrlInput ? baseUrlInput.value.trim() : "";
    var apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";
    var model = modelInput ? modelInput.value.trim() : "";
    var provider = getProviders().find(function (p) { return p.id === providerId; }) || {};
    return {
      id: providerId,
      name: getPresetName(providerId),
      apiKey: apiKey,
      baseUrl: baseUrl || (preset ? preset.baseUrl : ""),
      format: provider.format || (preset ? preset.format : "openai"),
      models: model ? [model] : []
    };
  }

  /**
   * 保存单个 provider 卡片配置
   * @param {string} providerId
   */
  function saveProviderFromCard(providerId) {
    var provider = readProviderFromCard(providerId);
    if (!provider) return;
    var providers = normalizeProviders();
    var idx = providers.findIndex(function (p) { return p.id === providerId; });
    if (idx !== -1) {
      providers[idx] = provider;
    } else {
      providers.push(provider);
    }
    saveProviders(providers);
    // 若该平台已勾选「设为当前使用」，则同步记录其优化模型
    var card = document.querySelector('#llm-provider-list [data-provider-id="' + providerId + '"]');
    var activeRadio = card ? card.querySelector(".ch-provider-active-radio") : null;
    if (activeRadio && activeRadio.checked && provider.models && provider.models[0]) {
      window.localStorage.setItem(STORAGE_KEYS.optimizeProvider, providerId);
      window.localStorage.setItem(STORAGE_KEYS.optimizeModel, provider.models[0]);
    }
    updateAuxStatusSummary();
    setStatus("已保存 — " + provider.name + "，配置已生效。");
  }

  function bindProviderCardEvents(providerId) {
    var card = document.querySelector('#llm-provider-list [data-provider-id="' + providerId + '"]');
    if (!card) return;

    // 头部点击展开/折叠（点击按钮时不触发）
    var header = card.querySelector(".ch-card-header");
    if (header) {
      header.addEventListener("click", function (event) {
        if (event.target.closest(".ch-toggle-btn") || event.target.closest("button")) return;
        toggleProviderCard(providerId);
      });
    }
    var toggleBtn = card.querySelector(".ch-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        toggleProviderCard(providerId);
      });
    }
    // 设为当前使用（radio 切换，立即生效）
    var activeRadio = card.querySelector(".ch-provider-active-radio");
    if (activeRadio) {
      activeRadio.addEventListener("change", function () {
        if (activeRadio.checked) activateProvider(providerId);
      });
    }
    // 保存
    var saveBtn = card.querySelector(".ch-provider-save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () { saveProviderFromCard(providerId); });
    }
    // 测试
    var testBtn = card.querySelector(".ch-provider-test-btn");
    if (testBtn) {
      testBtn.addEventListener("click", function () { testProviderConnection(providerId); });
    }
  }

  /**
   * 将指定平台设为「一键优化」当前使用的平台
   * @param {string} providerId
   */
  function activateProvider(providerId) {
    var providers = normalizeProviders();
    var provider = providers.find(function (p) { return p.id === providerId; });
    if (!provider) return;
    window.localStorage.setItem(STORAGE_KEYS.optimizeProvider, providerId);
    var model = provider.models && provider.models[0] ? provider.models[0] : "";
    if (model) window.localStorage.setItem(STORAGE_KEYS.optimizeModel, model);
    updateAuxStatusSummary();
    setStatus("已切换一键优化平台为：" + getPresetName(providerId));
  }

  function updateAuxStatusSummary() {
    var summaryEl = document.getElementById("aux-status-summary");
    if (!summaryEl) return;
    var optimizeProviderId = window.localStorage.getItem(STORAGE_KEYS.optimizeProvider) || "";
    var providers = normalizeProviders();
    var active = providers.find(function (p) { return p.id === optimizeProviderId; }) || providers.find(function (p) { return p.apiKey && p.models && p.models[0]; }) || providers[0];
    var modelValue = active && active.models && active.models[0] ? active.models[0] : "";
    var ok = !!(active && String(active.apiKey || "").trim() && modelValue);
    var text = ok ? (getPresetName(active.id) + " · " + modelValue) : "暂无可用配置，请展开下列卡片填写 API Key 与模型名后保存";
    var pillClass = ok ? "is-ok" : "is-missing";
    summaryEl.innerHTML = '<span class="status-icon">' + (ok ? "✅" : "⚠️") + '</span><div class="status-pills"><span class="status-pill ' + pillClass + '">一键优化：' + text + "</span></div>";
  }

  async function testProviderConnection(providerId) {
    var card = document.querySelector('#llm-provider-list [data-provider-id="' + providerId + '"]');
    var statusEl = card ? card.querySelector("[data-provider-test-result]") : null;
    if (statusEl) { statusEl.innerHTML = '<span class="test-status is-testing">正在检测，请稍等...</span>'; }
    try {
      var provider = readProviderFromCard(providerId);
      if (!provider) throw new Error("配置信息读取失败");
      if (!String(provider.apiKey || "").trim()) throw new Error("请先填写 API Key");
      var model = provider.models && provider.models[0];
      if (!model) throw new Error("请先填写模型名");
      var controller = new AbortController();
      var timeoutId = window.setTimeout(function () { controller.abort(); }, 20000);
      await __APP.callLlmApi(provider, model, [{ role: "user", content: "你好，请只回复一个 ok。" }], controller.signal);
      window.clearTimeout(timeoutId);
      if (statusEl) { statusEl.innerHTML = '<span class="test-status is-success">连接成功，可以正常使用 ✅</span>'; }
      setStatus("连接检测成功");
    } catch (error) {
      var message = error && error.message ? error.message : "未知错误";
      if (error && (error.name === "AbortError" || /aborted|timeout/i.test(message))) message = "检测超时，请检查网络、API Key 或接口地址是否正确";
      if (statusEl) { statusEl.innerHTML = '<span class="test-status is-error">连接失败：' + escapeHtml(message) + "</span>"; }
      setStatus("连接检测失败");
    }
  }

  function initAuxConfig() {
    var providers = normalizeProviders();
    saveProviders(providers);
    renderProviderList();
    updateAuxStatusSummary();
  }

  // ==================== 清空设置 ====================

  function clearSettings() {
    if (!window.confirm("确定清空所有设置吗？包括生图通道、辅助模型配置。")) return;
    Object.values(STORAGE_KEYS).forEach(function (key) { window.localStorage.removeItem(key); });
    // 重置通道列表
    if (window.__APP && window.__APP.getDefaultImageChannels) {
      window.__APP.saveImageChannels(window.__APP.getDefaultImageChannels());
    }
    renderChannelList();
    // 重置辅助模型配置
    var defaultProviders = window.__APP ? window.__APP.getDefaultLlmProviders() : [];
    if (window.__APP) window.__APP.saveLlmProviders(defaultProviders);
    window.localStorage.removeItem(STORAGE_KEYS.optimizeProvider);
    window.localStorage.removeItem(STORAGE_KEYS.optimizeModel);
    initAuxConfig();
    setStatus("已清空所有设置");
  }

  // ==================== 初始化 ====================

  // 给所有 API Key 密码框添加常驻的显示/隐藏眼睛按钮
  function enhanceApiKeyInputs() {
    document.querySelectorAll('input[type="password"]').forEach(function (input) {
      if (input.parentNode && input.parentNode.classList.contains("api-key-wrap")) return;
      var wrap = document.createElement("div");
      wrap.className = "api-key-wrap";
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      var eye = document.createElement("button");
      eye.type = "button";
      eye.className = "api-key-eye";
      eye.setAttribute("aria-label", "显示密钥");
      eye.title = "点击显示/隐藏密钥";
      eye.innerHTML = "👁";
      eye.addEventListener("click", function () {
        var isVisible = input.type === "text";
        input.type = isVisible ? "password" : "text";
        eye.classList.toggle("is-visible", !isVisible);
        eye.innerHTML = isVisible ? "👁" : "🙈";
        eye.setAttribute("aria-label", isVisible ? "显示密钥" : "隐藏密钥");
      });
      wrap.appendChild(eye);
    });
  }

  function init() {
    // 初始化生图通道
    renderChannelList();
    if (elements.addChannelBtn) {
      elements.addChannelBtn.addEventListener("click", addChannel);
    }

    // 初始化辅助模型配置
    initAuxConfig();

    // 给所有 API Key 密码框添加常驻眼睛按钮（provider 卡片已渲染）
    enhanceApiKeyInputs();

    // 绑定导航切换
    elements.navButtons().forEach(function (btn) {
      btn.addEventListener("click", function () { switchChannel(btn.dataset.channel); });
    });

    // 绑定清空按钮
    if (elements.clearSettings) {
      elements.clearSettings.addEventListener("click", clearSettings);
    }

    activeChannelId = "image-channels";
    switchChannel("image-channels");
  }

  init();
})();
