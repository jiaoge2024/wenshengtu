(function () {
  window.__APP = window.__APP || {};

  __APP.createId = function () {
    return "msg-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  };

  __APP.getElapsedSeconds = function (startedAt, endedAt) {
    var duration = Math.max(0, (Number(endedAt) || Date.now()) - (Number(startedAt) || Date.now()));
    return Number((duration / 1000).toFixed(1));
  };

  __APP.formatDurationSeconds = function (seconds) {
    var value = Number(seconds);
    if (!Number.isFinite(value)) {
      return "";
    }
    return value.toFixed(1).replace(/\.0$/, "") + " 秒";
  };

  __APP.normalizeModelValue = function (value) {
    if (value === "gpt-image-2-official") {
      return __APP.GPT_IMAGE_MODEL;
    }
    return value;
  };

  // ==================== 生图通道管理 ====================

  /**
   * 从 localStorage 读取生图通道列表（含自动迁移）
   * @returns {Array} 通道数组
   */
  __APP.getImageChannels = function () {
    if (__APP.migrateImageChannels) {
      return __APP.migrateImageChannels();
    }
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.imageChannels);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (e) {
      // ignore
    }
    return __APP.getDefaultImageChannels ? __APP.getDefaultImageChannels() : [];
  };

  /**
   * 保存生图通道列表到 localStorage
   * @param {Array} channels
   */
  __APP.saveImageChannels = function (channels) {
    var data = Array.isArray(channels) ? channels : [];
    try {
      window.localStorage.setItem(__APP.STORAGE_KEYS.imageChannels, JSON.stringify(data));
    } catch (e) {
      console.error("[saveImageChannels] 保存失败", e);
      throw new Error("生图通道保存失败：" + (e && e.message ? e.message : "未知错误"));
    }
  };

  /**
   * 根据 ID 查找通道
   * @param {string} channelId
   * @returns {Object|null}
   */
  __APP.getImageChannelById = function (channelId) {
    return __APP.getImageChannels().find(function (ch) { return ch.id === channelId; }) || null;
  };

  /**
   * 根据模型名查找所属通道
   * 先精确匹配通道的 model 字段
   * @param {string} modelValue
   * @returns {Object|null}
   */
  __APP.getImageChannelByModel = function (modelValue) {
    var channels = __APP.getImageChannels();
    // 新版格式：model|channelId，按 channelId 精确匹配
    if (modelValue && modelValue.indexOf("|") !== -1) {
      var channelId = modelValue.split("|").pop();
      var matchById = channels.find(function (ch) { return ch.enabled && ch.id === channelId; });
      if (matchById) {
        return matchById;
      }
    }
    // 兼容旧版按模型名查找
    var match = channels.find(function (ch) { return ch.enabled && ch.model === modelValue; });
    if (match) {
      return match;
    }
    return null;
  };

  /**
   * 生成通道的唯一 ID
   * @returns {string}
   */
  __APP.createChannelId = function () {
    return "ch-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  };

  /**
   * 获取当前完整的模型选项列表（从动态通道生成）
   * @returns {Array} 模型选项数组
   */
  __APP.getModelOptions = function () {
    var options = [];
    var channels = __APP.getImageChannels();
    var seenKeys = {};

    // 添加已启用通道的模型
    channels.forEach(function (ch) {
      if (!ch.enabled) {
        return;
      }

      if (ch.model) {
        // 使用 "model|channelId" 作为 value，避免多个通道使用相同模型名时被去重
        var optionValue = ch.model + "|" + ch.id;
        if (!seenKeys[optionValue]) {
          seenKeys[optionValue] = true;
          options.push({
            value: optionValue,
            label: ch.name + " · " + ch.model,
            note: ch.type === "openai_images" ? "OpenAI Images 兼容接口，模式：" + (ch.mode || "auto") : ch.type === "agnes" ? "Agnes Image 生图" : "",
            channel: "image-channel",
            channelId: ch.id,
            model: ch.model
          });
        }
      }
    });

    return options;
  };

  __APP.getModelMeta = function (value) {
    var normalized = __APP.normalizeModelValue(value);
    var meta = __APP.getModelOptions().find(function (item) {
      return item.value === normalized;
    });
    if (meta) {
      return meta;
    }
    // 兜底：返回第一个选项
    var options = __APP.getModelOptions();
    return options[0] || { value: normalized, label: normalized, note: "", channel: "" };
  };

  __APP.normalizeImageQuality = function (value) {
    return __APP.IMAGE_QUALITIES.some(function (item) { return item.value === value; }) ? value : "2K";
  };

/**
 * 获取模型所属的生图通道（优先匹配启用的动态通道）
 * @param {string} value 模型 value
 * @returns {Object|null} 通道对象
 */
__APP.getChannelByModelValue = function (value) {
  if (typeof __APP.getImageChannelByModel === "function") {
    return __APP.getImageChannelByModel(value);
  }
  return null;
};

__APP.isCustomImageModel = function (value) {
  var ch = __APP.getChannelByModelValue(value);
  return ch && ch.type === "openai_images" && ch.builtin === false;
};

  __APP.getStyleTemplate = function (templateId) {
    return __APP.STYLE_TEMPLATES.find(function (item) { return item.id === templateId; }) || __APP.STYLE_TEMPLATES[0];
  };

  __APP.buildPrompt = function (rawPrompt, styleTemplateId) {
    var styleTemplate = __APP.getStyleTemplate(styleTemplateId);
    return styleTemplate.instruction ? rawPrompt + "\n\n" + styleTemplate.instruction : rawPrompt;
  };

  __APP.parseBatchPrompts = function (text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n+/)
      .map(function (item) { return item.trim(); })
      .filter(Boolean);
  };

  __APP.createBatchQueueEntries = function (prompts) {
    return prompts.map(function (prompt, index) {
      return {
        id: "batch-" + Date.now() + "-" + index + "-" + Math.random().toString(16).slice(2, 6),
        prompt: prompt,
        status: "pending",
        note: ""
      };
    });
  };

  __APP.expandTemplateVars = function (template, valuesText) {
    var lines = valuesText.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
    if (lines.length === 0) {
      return [];
    }

    var varNames = [];
    var re = /\{([^}]+)\}/g;
    var match;
    while ((match = re.exec(template)) !== null) {
      var name = match[1].trim();
      if (varNames.indexOf(name) === -1) {
        varNames.push(name);
      }
    }

    if (varNames.length === 0) {
      return lines;
    }

    return lines.map(function (line) {
      var parts = line.split(",").map(function (p) { return p.trim(); });
      while (parts.length < varNames.length) {
        parts.push("");
      }
      var result = template;
      varNames.forEach(function (name, idx) {
        var reLocal = new RegExp("\\{" + name + "\\}", "g");
        result = result.replace(reLocal, parts[idx] || "");
      });
      return result;
    });
  };

  __APP.normalizeTaskStatus = function (status) {
    return String(status || "").trim().toLowerCase();
  };

  __APP.isGptTaskCompleted = function (status) {
    return ["completed", "succeeded", "success", "done"].indexOf(__APP.normalizeTaskStatus(status)) !== -1;
  };

  __APP.isGptTaskFailed = function (status) {
    return ["failed", "error", "cancelled", "canceled"].indexOf(__APP.normalizeTaskStatus(status)) !== -1;
  };

  __APP.isGptImageSizeFormatError = function (message) {
    return /invalid\s+size|expected\s+widthxheight|width\s*x\s*height|unsupported\s+size|size.*(?:format|格式)/i.test(String(message || ""));
  };

  __APP.getGptImageResolution = function (imageQuality) {
    return __APP.normalizeImageQuality(imageQuality).toLowerCase();
  };

  __APP.copyTextToClipboard = function (text) {
    if (!text) {
      return Promise.resolve(false);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return false; });
    }
    try {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return Promise.resolve(ok);
    } catch (error) {
      return Promise.resolve(false);
    }
  };

  /**
   * 从 localStorage 读取用户自定义的 LLM Provider 列表
   * @returns {Array} Provider 数组
   */
  __APP.getLlmProviders = function () {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.llmProviders);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.error("[getLlmProviders] 读取失败，使用默认配置", e);
    }
    return __APP.getDefaultLlmProviders();
  };

  /**
   * 保存 LLM Provider 列表到 localStorage
   * @param {Array} providers Provider 数组
   */
  __APP.saveLlmProviders = function (providers) {
    try {
      window.localStorage.setItem(__APP.STORAGE_KEYS.llmProviders, JSON.stringify(providers));
    } catch (e) {
      console.error("[saveLlmProviders] 保存失败", e);
      throw new Error("模型商配置保存失败：" + (e && e.message ? e.message : "未知错误"));
    }
  };

  /**
   * 根据 ID 查找 Provider
   * @param {string} providerId
   * @returns {Object|undefined}
   */
  __APP.getLlmProviderById = function (providerId) {
    var providers = __APP.getLlmProviders();
    return providers.find(function (p) { return p.id === providerId; });
  };

  /**
   * 构建 OpenAI 兼容的请求 endpoint
   * @param {Object} provider
   * @returns {string}
   */
  __APP.buildOpenAiEndpoint = function (provider) {
    var baseUrl = String(provider.baseUrl || "").trim() || "https://api.openai.com/v1";
    var normalized = baseUrl.replace(/\/+$/, "");
    if (/\/chat\/completions(?:[?#].*)?$/.test(normalized)) {
      return normalized;
    }
    if (/\/v1(?:[/?#]|$)/.test(normalized)) {
      return normalized + "/chat/completions";
    }
    return normalized + "/v1/chat/completions";
  };

  /**
   * 统一的 LLM API 调用入口，支持 OpenAI 兼容格式
   * @param {string|Object} providerId Provider ID，或直接传入 Provider 对象
   * @param {string} model 模型名
   * @param {Array} messages OpenAI 风格消息数组，content 支持 string 或 [{type:'text'}]
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>} 返回模型生成的文本
   */
  __APP.callLlmApi = async function (providerId, model, messages, signal) {
    var provider = (typeof providerId === "string")
      ? (__APP.getLlmProviders().find(function (p) { return p.id === providerId; }))
      : providerId;
    if (!provider) {
      throw new Error("未找到模型商配置：" + (typeof providerId === "string" ? providerId : ""));
    }

    var apiKey = String(provider.apiKey || "").trim();
    if (!apiKey) {
      throw new Error("模型商「" + provider.name + "」的 API Key 为空，请先在设置页填写。");
    }

    var openAiEndpoint = __APP.buildOpenAiEndpoint(provider);
    var response = await __APP.proxyFetch(openAiEndpoint, {
      method: "POST",
      signal: signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: model,
        messages: messages
      })
    });
    var data = await response.json();
    if (!response.ok) {
      var openAiError = data && data.error && data.error.message ? data.error.message : "OpenAI 格式请求失败（" + response.status + "）";
      throw new Error(openAiError);
    }
    var choice = data && Array.isArray(data.choices) && data.choices[0];
    var message = choice && choice.message;
    // 优先取正式回答（content）；若为空，再回退到推理模型的思考过程（reasoning_content）
    var content = "";
    if (message) {
      if (typeof message.content === "string" && message.content.trim()) {
        content = message.content;
      } else if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        content = message.reasoning_content;
      }
    }
    if (!content) {
      throw new Error("OpenAI 格式接口已返回，但没有拿到可用文本。");
    }
    // 推理模型可能把思考过程与正式回答混在一起，尝试剥离前置思考段
    return __APP.cleanLlmOutput(content);
  };

  /**
   * 清理大模型返回文本，剥离推理模型常见的思考过程前缀，仅保留正式回答
   * 支持 OpenAI 兼容格式（reasoning 模型）与 MiniMax 等推理模型的典型思考标记
   * @param {string} text 原始返回文本
   * @returns {string} 清理后的文本
   */
  __APP.cleanLlmOutput = function (text) {
    var value = String(text || "").trim();
    if (!value) return value;
    // 常见思考标记：要么用 <think>...</think> 包裹，要么以“思考过程/思考/分析”等开头
    var markers = ["思考过程", "分析", "推理"];
    var cleaned = value;
    for (var i = 0; i < markers.length; i++) {
      var marker = markers[i];
      var idx = cleaned.indexOf(marker);
      if (idx !== 0) continue;
      var after = cleaned.slice(marker.length);
      var cut = after.indexOf("\n");
      if (cut === -1) cut = after.length;
      var rest = after.slice(cut).trim();
      if (rest) {
        cleaned = rest;
        break;
      }
    }
    return cleaned;
  };

  /**
   * 规范化分类输入：接受字符串或字符串数组，输出不含空值与重复的数组
   * @param {string|string[]|undefined|null} input
   * @returns {string[]}
   */
  __APP.normalizeCategories = function (input) {
    var arr;
    if (Array.isArray(input)) {
      arr = input;
    } else if (input == null) {
      arr = [];
    } else {
      // 字符串：支持中文/英文逗号、分号、换行分隔，便于兼容旧数据与直接粘贴
      arr = String(input).split(/[,，;；\n\r]+/);
    }
    var seen = {};
    var result = [];
    for (var i = 0; i < arr.length; i++) {
      var value = String(arr[i] || "").trim();
      if (!value) continue;
      if (seen[value]) continue;
      seen[value] = true;
      result.push(value);
    }
    return result;
  };

  /**
   * 从一条记录中读取分类列表（兼容旧 category 字段）
   * @param {Object} item
   * @returns {string[]}
   */
  __APP.getItemCategories = function (item) {
    if (!item || typeof item !== "object") return [];
    if (Array.isArray(item.categories)) {
      return __APP.normalizeCategories(item.categories);
    }
    if (typeof item.category === "string" && item.category.trim()) {
      return [item.category.trim()];
    }
    return [];
  };

  /**
   * 从 localStorage 读取提示词库数据（自动迁移旧单分类字段为 categories 数组）
   * @returns {Array} 提示词对象数组
   */
  __APP.getPromptLibrary = function () {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.promptLibrary);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // 统一把旧 category 字段合并/迁移到 categories
          return parsed.map(function (item) {
            if (!item || typeof item !== "object") return item;
            var cats = __APP.getItemCategories(item);
            var clone = {};
            for (var k in item) {
              if (Object.prototype.hasOwnProperty.call(item, k)) clone[k] = item[k];
            }
            clone.categories = cats.length ? cats : ["未分类"];
            // 保留旧字段以兼容外部读取（不再用于过滤），但 UI 不再展示
            clone.category = clone.categories[0];
            return clone;
          });
        }
      }
    } catch (e) {
      console.error("[getPromptLibrary] 读取提示词库失败", e);
    }
    return [];
  };

  /**
   * 保存提示词库数据到 localStorage
   * @param {Array} items 提示词对象数组
   */
  __APP.savePromptLibrary = function (items) {
    try {
      window.localStorage.setItem(__APP.STORAGE_KEYS.promptLibrary, JSON.stringify(items));
    } catch (e) {
      console.error("[savePromptLibrary] 保存提示词库失败", e);
      throw new Error("提示词库保存失败：" + (e && e.message ? e.message : "未知错误"));
    }
  };

  /**
   * 生成唯一提示词 ID
   * @returns {string}
   */
  __APP.createPromptId = function () {
    return "prompt-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  };

  /**
   * 获取提示词库中所有分类（去重排序，聚合多分类标签）
   * @param {Array} [items]
   * @returns {Array<string>}
   */
  __APP.getPromptLibraryCategories = function (items) {
    var library = Array.isArray(items) ? items : __APP.getPromptLibrary();
    var set = {};
    library.forEach(function (item) {
      var cats = __APP.getItemCategories(item);
      cats.forEach(function (c) {
        if (c) set[c] = true;
      });
      if (cats.length === 0) {
        set["未分类"] = true;
      }
    });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
  };

  /**
   * 向提示词库新增一条提示词
   * @param {Object} promptData
   * @param {string} promptData.name 短名称
   * @param {string} promptData.content 提示词内容
   * @param {string[]|string} [promptData.categories] 分类标签（数组或逗号分隔字符串）
   * @param {string} [promptData.category] 兼容旧字段，等价于 categories 单元素
   * @param {boolean} [promptData.isFavorite] 是否收藏
   * @returns {Object} 新增的提示词对象
   */
  __APP.addPromptToLibrary = function (promptData) {
    var name = String(promptData && promptData.name || "").trim();
    var content = String(promptData && promptData.content || "").trim();
    if (!name) {
      throw new Error("提示词短名称不能为空");
    }
    if (!content) {
      throw new Error("提示词内容不能为空");
    }

    var cats = __APP.normalizeCategories(
      promptData && (promptData.categories != null ? promptData.categories : promptData.category)
    );
    if (cats.length === 0) {
      cats = ["未分类"];
    }

    var now = Date.now();
    var item = {
      id: __APP.createPromptId(),
      name: name,
      content: content,
      categories: cats,
      category: cats[0], // 兼容旧字段
      isFavorite: Boolean(promptData && promptData.isFavorite),
      createdAt: now,
      updatedAt: now
    };

    var library = __APP.getPromptLibrary();
    library.unshift(item);
    __APP.savePromptLibrary(library);
    return item;
  };

  /**
   * 更新提示词库中指定 ID 的提示词
   * @param {string} id
   * @param {Object} updates
   * @param {string} [updates.name]
   * @param {string} [updates.content]
   * @param {string[]|string} [updates.categories] 分类标签；传 [] 表示清空后回退到 ["未分类"]
   * @param {string} [updates.category] 兼容旧字段（与 categories 二选一，categories 优先）
   * @param {boolean} [updates.isFavorite]
   * @returns {Object|null} 更新后的对象，找不到则返回 null
   */
  __APP.updatePromptInLibrary = function (id, updates) {
    var library = __APP.getPromptLibrary();
    var index = library.findIndex(function (item) { return item && item.id === id; });
    if (index === -1) {
      return null;
    }

    var item = library[index];
    if (updates) {
      if (updates.name != null) item.name = String(updates.name).trim() || item.name;
      if (updates.content != null) item.content = String(updates.content).trim();
      if (updates.categories != null || updates.category != null) {
        var raw = updates.categories != null ? updates.categories : updates.category;
        var cats = __APP.normalizeCategories(raw);
        item.categories = cats.length ? cats : ["未分类"];
        item.category = item.categories[0];
      }
      if (updates.isFavorite != null) item.isFavorite = Boolean(updates.isFavorite);
    }
    item.updatedAt = Date.now();
    __APP.savePromptLibrary(library);
    return item;
  };

  /**
   * 从提示词库删除指定 ID 的提示词
   * @param {string} id
   * @returns {boolean} 是否删除成功
   */
  __APP.deletePromptFromLibrary = function (id) {
    var library = __APP.getPromptLibrary();
    var next = library.filter(function (item) { return !(item && item.id === id); });
    if (next.length === library.length) {
      return false;
    }
    __APP.savePromptLibrary(next);
    return true;
  };

  /**
   * 切换指定提示词的收藏状态
   * @param {string} id
   * @returns {Object|null}
   */
  __APP.togglePromptFavorite = function (id) {
    var library = __APP.getPromptLibrary();
    var item = library.find(function (item) { return item && item.id === id; });
    if (!item) {
      return null;
    }
    item.isFavorite = !item.isFavorite;
    item.updatedAt = Date.now();
    __APP.savePromptLibrary(library);
    return item;
  };

  /**
   * 搜索并筛选提示词
   * @param {Object} options
   * @param {string} [options.query] 搜索关键词
   * @param {string} [options.category] 分类过滤，"全部" 表示不过滤，"收藏" 表示仅收藏
   * @returns {Array}
   */
  /**
   * 构造用于导出的 JSON 对象（带元数据，便于跨设备识别）
   * @returns {{version:number, exportedAt:number, count:number, items:Array}}
   */
  __APP.buildPromptLibraryExport = function () {
    var library = __APP.getPromptLibrary();
    return {
      version: 1,
      exportedAt: Date.now(),
      count: library.length,
      items: library
    };
  };

  /**
   * 将导出数据序列化为 JSON 字符串
   * @returns {string}
   */
  __APP.serializePromptLibrary = function () {
    return JSON.stringify(__APP.buildPromptLibraryExport(), null, 2);
  };

  /**
   * 解析导入文件文本，校验结构
   * @param {string} text
   * @returns {Array} 校验通过后的提示词数组
   */
  __APP.parsePromptLibraryImport = function (text) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("文件内容为空");
    }
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("JSON 解析失败：" + (e && e.message ? e.message : "未知错误"));
    }

    // 兼容两种结构：直接数组 / 带 items 字段的对象
    var rawItems;
    if (Array.isArray(data)) {
      rawItems = data;
    } else if (data && Array.isArray(data.items)) {
      rawItems = data.items;
    } else {
      throw new Error("文件结构不正确，缺少 items 数组");
    }

    // 过滤并规范化每条记录
    var cleaned = rawItems
      .filter(function (item) { return item && typeof item === "object"; })
      .map(function (item) {
        var name = String(item.name || "").trim();
        var content = String(item.content || "").trim();
        if (!name || !content) {
          return null; // 缺少必填字段的记录直接丢弃
        }
        // 分类：优先 categories（数组/字符串），否则回退到旧 category 字段
        var rawCats = item.categories != null ? item.categories : item.category;
        var cats = __APP.normalizeCategories(rawCats);
        if (cats.length === 0) {
          cats = ["未分类"];
        }
        return {
          id: String(item.id || __APP.createPromptId()),
          name: name,
          content: content,
          categories: cats,
          category: cats[0], // 兼容旧字段
          isFavorite: Boolean(item.isFavorite),
          createdAt: Number(item.createdAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now()
        };
      })
      .filter(Boolean);

    if (cleaned.length === 0) {
      throw new Error("文件中没有可用的提示词记录");
    }
    return cleaned;
  };

  /**
   * 合并导入项到当前提示词库
   * @param {Array} incomingItems 已校验过的提示词数组
   * @param {Object} [options]
   * @param {"merge"|"replace"} [options.mode] 合并或替换，默认 merge
   * @returns {{added:number, updated:number, total:number}}
   */
  __APP.mergePromptLibrary = function (incomingItems, options) {
    if (!Array.isArray(incomingItems) || incomingItems.length === 0) {
      throw new Error("没有可导入的提示词");
    }
    var mode = (options && options.mode) === "replace" ? "replace" : "merge";
    var library = mode === "replace" ? [] : __APP.getPromptLibrary();
    var existingById = {};
    library.forEach(function (item) { existingById[item.id] = item; });

    var added = 0;
    var updated = 0;
    incomingItems.forEach(function (item) {
      if (existingById[item.id]) {
        // 已有同 id：覆盖更新（导入优先，保证内容一致）
        var target = existingById[item.id];
        target.name = item.name;
        target.content = item.content;
        target.category = item.category;
        target.isFavorite = item.isFavorite;
        target.updatedAt = Date.now();
        updated += 1;
      } else {
        // 没有同 id：作为新增插入到列表头部
        library.unshift(item);
        existingById[item.id] = item;
        added += 1;
      }
    });

    __APP.savePromptLibrary(library);
    return { added: added, updated: updated, total: library.length };
  };

  /**
   * 触发浏览器下载导出文件
   * @param {string} [filename]
   */
  __APP.downloadPromptLibrary = function (filename) {
    var json = __APP.serializePromptLibrary();
    var blob = new Blob([json], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    var date = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    var defaultName = "prompt-library-" + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes()) + ".json";
    link.href = url;
    link.download = filename || defaultName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  /**
   * 解析搜索字符串为多关键词与结构化过滤条件
   * 支持：
   *   - 普通词：按名称/分类/内容匹配（不区分大小写，多个词之间 AND 关系）
   *   - `tag:xxx` / `分类:xxx`：仅匹配分类（包含匹配）
   *   - `is:star` / `is:fav` / `is:favorite`：仅匹配已收藏
   *   - `is:unstar`：仅匹配未收藏
   * @param {string} query
   * @returns {{tokens:string[], tags:string[], onlyFavorite:boolean|null}}
   */
  __APP.parsePromptSearchQuery = function (query) {
    var raw = String(query || "").trim();
    if (!raw) {
      return { tokens: [], tags: [], onlyFavorite: null };
    }
    var parts = raw.split(/\s+/).filter(Boolean);
    var tokens = [];
    var tags = [];
    var onlyFavorite = null;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var lower = p.toLowerCase();
      if (lower === "is:star" || lower === "is:fav" || lower === "is:favorite" || lower === "is:收藏") {
        onlyFavorite = true;
        continue;
      }
      if (lower === "is:unstar" || lower === "is:unfav" || lower === "is:未收藏") {
        onlyFavorite = false;
        continue;
      }
      var tagMatch = p.match(/^(?:tag|分类)[:：]\s*(.+)$/i);
      if (tagMatch) {
        var tag = String(tagMatch[1] || "").trim();
        if (tag) tags.push(tag);
        continue;
      }
      tokens.push(p);
    }
    return { tokens: tokens, tags: tags, onlyFavorite: onlyFavorite };
  };

  /**
   * 判断一条记录是否命中分类筛选（支持多分类，命中任一即通过）
   * @param {Object} item
   * @param {string} category "全部" / "收藏" / 具体分类名
   * @returns {boolean}
   */
  __APP.matchesCategory = function (item, category) {
    if (!category || category === "全部") return true;
    if (category === "收藏") return Boolean(item && item.isFavorite);
    var cats = __APP.getItemCategories(item);
    if (cats.length === 0) return category === "未分类";
    return cats.indexOf(category) !== -1;
  };

  /**
   * 搜索并筛选提示词
   * @param {Object} options
   * @param {string} [options.query] 搜索关键词（支持多关键词与 tag:/is: 前缀）
   * @param {string} [options.category] 分类过滤，"全部" 表示不过滤，"收藏" 表示仅收藏
   * @returns {Array}
   */
  __APP.filterPromptLibrary = function (options) {
    var category = String(options && options.category || "全部").trim();
    var library = __APP.getPromptLibrary();
    var parsed = __APP.parsePromptSearchQuery(options && options.query);
    var tokens = parsed.tokens.map(function (t) { return t.toLowerCase(); });
    var tags = parsed.tags.map(function (t) { return t.toLowerCase(); });
    var onlyFavorite = parsed.onlyFavorite;

    return library.filter(function (item) {
      if (!item) return false;

      // 分类过滤
      if (!__APP.matchesCategory(item, category)) {
        return false;
      }

      // is:star / is:unstar
      if (onlyFavorite === true && !item.isFavorite) return false;
      if (onlyFavorite === false && item.isFavorite) return false;

      // tag:xxx（包含匹配，多个 tag 之间 AND）
      if (tags.length) {
        var itemCats = __APP.getItemCategories(item).map(function (c) { return c.toLowerCase(); });
        for (var i = 0; i < tags.length; i++) {
          var t = tags[i];
          var matched = itemCats.some(function (c) { return c.indexOf(t) !== -1; });
          if (!matched) return false;
        }
      }

      // 普通关键词（多个之间 AND，全部要在 name/content/分类 中至少一个出现）
      if (tokens.length) {
        var name = String(item.name || "").toLowerCase();
        var content = String(item.content || "").toLowerCase();
        var itemCatsRaw = __APP.getItemCategories(item).join("\n").toLowerCase();
        for (var j = 0; j < tokens.length; j++) {
          var token = tokens[j];
          if (name.indexOf(token) === -1
              && content.indexOf(token) === -1
              && itemCatsRaw.indexOf(token) === -1) {
            return false;
          }
        }
      }

      return true;
    });
  };

  // ==================== 服务端代理 fetch ====================

  /**
   * 通过本地服务器代理转发外部 API 请求，绕过浏览器 CORS 限制
   * 返回的对象模拟标准 Response 接口（ok / status / json()）
   * @param {string} url - 目标 API 地址（必须 HTTPS）
   * @param {Object} options - { method, headers, body, signal }
   * @returns {Promise<{ok:boolean, status:number, json:Function}>}
   */
  __APP.proxyFetch = async function (url, options) {
    options = options || {};
    var proxyBody = {
      url: url,
      method: options.method || "POST",
      headers: options.headers || {},
      body: options.body != null ? String(options.body) : null
    };

    var proxyRes = await fetch("/api/proxy", {
      method: "POST",
      signal: options.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proxyBody)
    });

    var proxyData = await proxyRes.json();

    // 代理返回 { ok, status, data } 或 { ok, status, error }
    var mockResponse = {
      ok: Boolean(proxyData.ok),
      status: Number(proxyData.status) || 0,
      _data: proxyData.data || null,
      _error: proxyData.error || null
    };

    mockResponse.json = async function () {
      if (mockResponse._data != null) {
        return mockResponse._data;
      }
      if (mockResponse._error != null) {
        return { error: { message: mockResponse._error } };
      }
      return {};
    };

    return mockResponse;
  };
})();
