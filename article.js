/**
 * 文章配图板块（Article Illustration）
 *
 * 流程：粘贴/上传文章 → 选择统一风格与张数 → AI 拆解插图点（可编辑）
 *      → 批量提交本地服务后台生图（跳转页面不中断）→ 图文对照结果
 *
 * 复用能力：
 * - 服务端后台任务 API：POST/GET /api/image-studio/generation-tasks（与创作台共用）
 * - 文本 AI：__APP.callLlmApi（与小红书大纲策划共用同一条文本通道）
 * - 自定义风格库：文章配图独立存储（与小红书板块互不影响，交互同款）
 * - 断点记忆：输入/配置/插图点/结果全部持久化，切换页面后回来不丢失
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var SERVER_MODE = window.location.protocol !== "file:";
  var SERVER_TASKS_URL = "/api/image-studio/generation-tasks";
  var POLL_INTERVAL_MS = 3000;
  var STATE_STORAGE_KEY = "image-studio:article-state-v1"; // 断点记忆
  var STYLE_SEARCH_THRESHOLD = 10; // 风格数量达到阈值才显示搜索框（与小红书一致）
  var MAX_COUNT = 8;

  var state = {
    points: [],            // 插图点：{ id, title, excerpt, prompt }
    results: {},           // pointId → { status: "pending"|"done"|"failed", imageUrl, error, durationSeconds }
    tasks: {},             // taskId → pointId（生图任务与结果卡片的映射）
    submitAt: {},          // pointId → 提交时间戳（用于进行中的实时耗时显示）
    pollTimer: null,
    elapsedTimer: null,    // 进行中卡片的实时秒数刷新器
    running: false,        // 是否正在生图
    styles: [],            // 自定义风格库（文章配图独立存储，与小红书互不影响）
    styleId: "",           // 当前选中的风格 ID（空 = 不注入风格）
    styleEditingId: null,  // 正在编辑的风格 ID
    styleFilter: ""        // 风格搜索关键词
  };

  var elements = {
    inputToggle: $("article-input-toggle"),
    inputBody: $("article-input-body"),
    text: $("article-text"),
    clear: $("article-clear"),
    upload: $("article-upload"),
    file: $("article-file"),
    example: $("article-example"),
    charCount: $("article-char-count"),
    configToggle: $("article-config-toggle"),
    configBody: $("article-config-body"),
    styleSearch: $("article-style-search"),
    styleCards: $("article-style-cards"),
    styleHint: $("article-style-hint"),
    styleNew: $("article-style-new"),
    styleForm: $("article-style-form"),
    styleName: $("article-style-name"),
    stylePrompt: $("article-style-prompt"),
    styleSave: $("article-style-save"),
    styleCancel: $("article-style-cancel"),
    styleExport: $("article-style-export"),
    styleImport: $("article-style-import"),
    styleImportFile: $("article-style-import-file"),
    model: $("article-model"),
    modelNote: $("article-model-note"),
    ratio: $("article-ratio"),
    quality: $("article-quality"),
    count: $("article-count"),
    analyze: $("article-analyze"),
    stop: $("article-stop"),
    status: $("article-status"),
    llmHint: $("article-llm-hint"),
    reset: $("article-reset"),
    pointsPanel: $("article-points-panel"),
    pointsToggle: $("article-points-toggle"),
    pointsBody: $("article-points-body"),
    points: $("article-points"),
    pointsTip: $("article-points-tip"),
    addPoint: $("article-add-point"),
    generate: $("article-generate"),
    resultsPanel: $("article-results-panel"),
    resultsToggle: $("article-results-toggle"),
    resultsBody: $("article-results-body"),
    results: $("article-results"),
    downloadAll: $("article-download-all")
  };

  // ==================== 断点记忆 ====================

  /** 把当前页面状态写入 localStorage（输入、配置、插图点、结果） */
  function persistState() {
    try {
      var payload = {
        version: 1,
        text: elements.text.value,
        styleId: state.styleId,
        model: elements.model.value,
        ratio: elements.ratio.value,
        quality: elements.quality.value,
        count: elements.count.value,
        points: state.points,
        results: state.results
      };
      window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn("[article] 断点保存失败", error);
    }
  }

  /** 从 localStorage 恢复上次状态；返回 true 表示有可恢复的断点 */
  function restoreState() {
    try {
      var raw = window.localStorage.getItem(STATE_STORAGE_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (!saved || saved.version !== 1) return false;

      elements.text.value = String(saved.text || "");
      state.styleId = String(saved.styleId || "");
      state.points = Array.isArray(saved.points)
        ? saved.points.filter(function (p) { return p && p.id; })
        : [];
      state.results = saved.results && typeof saved.results === "object" ? saved.results : {};

      // 配置项恢复（下拉值必须是当前存在的 option，否则跳过）
      if (saved.model) {
        var hasModel = Array.from(elements.model.options).some(function (o) { return o.value === saved.model; });
        if (hasModel) elements.model.value = saved.model;
      }
      if (saved.ratio) elements.ratio.value = saved.ratio;
      if (saved.quality) elements.quality.value = saved.quality;
      if (saved.count) elements.count.value = saved.count;
      return true;
    } catch (error) {
      console.warn("[article] 断点恢复失败", error);
      return false;
    }
  }

  // ==================== 下拉填充 ====================

  function fillSelect(select, options, placeholder) {
    select.innerHTML = "";
    if (placeholder) {
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = placeholder;
      select.appendChild(ph);
    }
    options.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
  }

  function fillModelSelect() {
    var modelOptions = __APP.getModelOptions();
    fillSelect(elements.model, modelOptions, modelOptions.length === 0 ? "-- 没有可用模型，请先到通道设置配置 --" : "");
    if (modelOptions.length > 0 && !elements.model.value) {
      elements.model.value = modelOptions[0].value;
    }
    updateModelNote();
  }

  function updateModelNote() {
    var resolved = __APP.resolveImageChannel(elements.model.value);
    if (!resolved) {
      elements.modelNote.textContent = "";
      return;
    }
    elements.modelNote.textContent = __APP.describeChannelNote(resolved.channel) + " · " + resolved.channel.name;
  }

  // ==================== 输入区 ====================

  function updateCharCount() {
    var length = elements.text.value.trim().length;
    elements.charCount.textContent = length + " 字";
    elements.clear.hidden = length === 0;
    elements.analyze.disabled = length === 0 || state.running;
  }

  /**
   * 处理上传文档：txt/md 直接读取文本；docx 用 mammoth 提取正文
   * @param {File} file 用户选择的文件
   */
  async function handleFile(file) {
    var name = String(file.name || "").toLowerCase();
    try {
      var text = "";
      if (/\.(txt|md|markdown)$/.test(name)) {
        text = await file.text();
      } else if (/\.docx$/.test(name)) {
        if (!window.mammoth) {
          throw new Error("文档解析组件未加载，请刷新页面重试。");
        }
        var arrayBuffer = await file.arrayBuffer();
        var result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer });
        text = result && result.value ? result.value : "";
      } else {
        throw new Error("暂只支持 .txt / .md / .docx 文档。");
      }
      text = String(text || "").trim();
      if (!text) {
        throw new Error("文档内容为空。");
      }
      elements.text.value = text;
      updateCharCount();
      persistState();
      showStatus("已导入「" + file.name + "」，共 " + text.length + " 字。");
    } catch (error) {
      console.error("[article] 文档导入失败", error);
      showStatus("文档导入失败：" + (error && error.message ? error.message : "未知错误"), true);
    }
  }

  var EXAMPLE_TEXT = "深秋的清晨，山里的雾还没有散。老周把竹篓背上门前的石阶，篓里是刚蒸好的糯米。他和往常一样，先给灶膛添一把松枝，火光映着他手背上的裂口。\n\n镇上的年轻人一年比一年少，酒坊里的活计大部分落在他一个人肩上。蒸馏、拌曲、封坛，每一个步骤他都记得母亲教他时的样子。坛子上的红纸是妻子生前叠的，他一直舍不得换。\n\n下午来了几个城里来的游客，举着手机拍院子里晒的酒糟。老周不善言辞，只是把刚舀出的头道酒递给他们尝。有个姑娘喝完红了眼眶，说这是她外婆家乡的味道。\n\n傍晚的雾又起来了，老周把坛口一一封好。他知道，这些酒和这些手艺，总有一天会等来愿意留下来的人。";

  // ==================== 状态提示 ====================

  function showStatus(message, isError) {
    if (!message) {
      elements.status.hidden = true;
      elements.status.textContent = "";
      return;
    }
    elements.status.hidden = false;
    elements.status.textContent = message;
    elements.status.classList.toggle("is-error", Boolean(isError));
  }

  // ==================== 标题条折叠 ====================

  /**
   * 初始化卡片折叠开关：点击标题条任意位置即可展开/收起，右侧按钮同样可用。
   * 标题条内的其他功能按钮（如「清空」）不受影响。
   */
  function initCollapseToggle(toggleId, bodyId) {
    var toggle = $(toggleId);
    var body = $(bodyId);
    if (!toggle || !body) return;
    var head = toggle.closest(".article-panel-head") || toggle.parentElement;

    function applyToggle() {
      var willExpand = body.hidden;
      body.hidden = !willExpand;
      toggle.textContent = willExpand ? "收起 ▴" : "展开 ▾";
      toggle.setAttribute("aria-expanded", willExpand ? "true" : "false");
      persistState();
    }

    head.addEventListener("click", function (event) {
      var clickedButton = event.target.closest("button");
      if (clickedButton && clickedButton !== toggle) return;
      applyToggle();
    });
  }

  // ==================== 自定义风格库（文章配图独立存储，与小红书互不影响） ====================

  /**
   * 加载文章配图自己的风格库。
   * 历史兼容：早期版本与小红书共用同一个存储键，首次加载时若本板块键为空
   * 而共享旧键有数据，则把旧数据复制一份作为初始库；此后两边完全独立、互不影响。
   */
  function loadStyles() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.articleStyles);
      if (raw === null) {
        // 首次使用独立库：从共享旧键复制一份（一次性迁移，不删除旧键）
        var legacy = window.localStorage.getItem(__APP.STORAGE_KEYS.xhsStyles);
        if (legacy) {
          window.localStorage.setItem(__APP.STORAGE_KEYS.articleStyles, legacy);
          raw = legacy;
          console.log("[article] 已从共享风格库复制初始数据，此后与小红书风格库相互独立");
        }
      }
      var parsed = raw ? JSON.parse(raw) : [];
      state.styles = Array.isArray(parsed) ? parsed.filter(function (s) { return s && s.name && s.prompt; }) : [];
    } catch (error) {
      console.error("[article] 风格库加载失败", error);
      state.styles = [];
    }
  }

  function saveStyles() {
    try {
      window.localStorage.setItem(__APP.STORAGE_KEYS.articleStyles, JSON.stringify(state.styles));
    } catch (error) {
      console.error("[article] 风格库保存失败", error);
    }
  }

  function findStyle(styleId) {
    return state.styles.find(function (s) { return s.id === styleId; }) || null;
  }

  /** 当前选中的风格描述；未选中返回空串 */
  function getActiveStyle() {
    var style = findStyle(state.styleId);
    return style ? style.prompt : "";
  }

  function getActiveStyleLabel() {
    var style = findStyle(state.styleId);
    return style ? style.name : "";
  }

  /** 渲染风格卡片列表：点击选中，卡片带编辑/删除；有搜索词时按名称过滤（与小红书同款交互） */
  function renderStyleCards() {
    var wrap = elements.styleCards;
    wrap.innerHTML = "";
    elements.styleSearch.hidden = state.styles.length < STYLE_SEARCH_THRESHOLD;

    var keyword = state.styles.length >= STYLE_SEARCH_THRESHOLD ? state.styleFilter.trim().toLowerCase() : "";
    var visibleStyles = state.styles.filter(function (style) {
      return !keyword || String(style.name || "").toLowerCase().indexOf(keyword) !== -1;
    });

    // 提示行按状态给出最短的必要信息，避免占用多余空间
    if (keyword && visibleStyles.length === 0) {
      elements.styleHint.hidden = false;
      elements.styleHint.textContent = "没有匹配的风格。";
    } else if (state.styles.length === 0) {
      elements.styleHint.hidden = false;
      elements.styleHint.textContent = "还没有自定义风格。不选风格时，配图将完全忠实于提示词本身的画面描述。";
    } else if (!state.styleId) {
      elements.styleHint.hidden = false;
      elements.styleHint.textContent = "未选中任何风格时，配图将完全忠实于提示词本身的画面描述。";
    } else {
      elements.styleHint.hidden = true;
    }

    visibleStyles.forEach(function (style) {
      var card = document.createElement("div");
      card.className = "xhs-style-card" + (style.id === state.styleId ? " is-active" : "");
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      var desc = String(style.prompt || "");
      if (desc.length > 90) desc = desc.slice(0, 90) + "…";
      var name = String(style.name || "");
      if (name.length > 20) name = name.slice(0, 20) + "…";
      card.title = style.name;
      card.innerHTML =
        '<span class="xhs-style-card-name">' + escapeHtml(name) + "</span>" +
        '<span class="xhs-style-card-desc">' + escapeHtml(desc) + "</span>" +
        '<span class="xhs-style-card-actions">' +
        '<button type="button" class="xhs-style-action" data-act="edit">编辑</button>' +
        '<button type="button" class="xhs-style-action danger" data-act="delete">删除</button>' +
        "</span>";
      card.addEventListener("click", function () {
        state.styleId = style.id === state.styleId ? "" : style.id; // 再点一次取消选中
        renderStyleCards();
        persistState();
      });
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.styleId = style.id;
          renderStyleCards();
          persistState();
        }
      });
      card.querySelector('[data-act="edit"]').addEventListener("click", function (event) {
        event.stopPropagation();
        startEditStyle(style.id);
      });
      card.querySelector('[data-act="delete"]').addEventListener("click", function (event) {
        event.stopPropagation();
        deleteStyle(style.id);
      });
      wrap.appendChild(card);
    });
  }

  function startEditStyle(styleId) {
    var style = findStyle(styleId);
    if (!style) return;
    state.styleEditingId = styleId;
    elements.styleForm.hidden = false; // 编辑时展开表单
    elements.styleName.value = style.name;
    elements.stylePrompt.value = style.prompt;
    elements.styleSave.textContent = "保存修改";
    elements.styleCancel.hidden = false;
    updateStylePromptCount();
    elements.styleName.focus();
  }

  /** 更新风格描述字数实时统计（如 566/2000） */
  function updateStylePromptCount() {
    var counter = $("article-style-prompt-count");
    if (!counter) return;
    counter.textContent = elements.stylePrompt.value.length + "/2000";
  }

  function resetStyleForm() {
    state.styleEditingId = null;
    elements.styleName.value = "";
    elements.stylePrompt.value = "";
    elements.styleSave.textContent = "保存自定义风格";
    elements.styleCancel.hidden = true;
    elements.styleForm.hidden = true; // 收起表单，恢复为「新建」按钮
    elements.styleNew.textContent = "＋ 新建自定义风格";
    updateStylePromptCount();
  }

  function handleStyleSave() {
    var name = elements.styleName.value.trim();
    var prompt = elements.stylePrompt.value.trim();
    if (!name) {
      window.alert("请先填写风格名称。");
      elements.styleName.focus();
      return;
    }
    if (!prompt) {
      window.alert("请先填写风格描述（它将作为固定画风注入每一张配图）。");
      elements.stylePrompt.focus();
      return;
    }
    if (state.styleEditingId) {
      var style = findStyle(state.styleEditingId);
      if (style) {
        style.name = name;
        style.prompt = prompt;
      }
    } else {
      var newStyle = { id: "style-" + Date.now(), name: name, prompt: prompt, createdAt: Date.now() };
      state.styles.push(newStyle);
      state.styleId = newStyle.id;
    }
    saveStyles();
    resetStyleForm();
    renderStyleCards();
    persistState();
    showStatus("风格已保存。");
  }

  function deleteStyle(styleId) {
    var style = findStyle(styleId);
    if (!style) return;
    if (!window.confirm('确定删除风格「' + style.name + '」吗？')) return;
    state.styles = state.styles.filter(function (s) { return s.id !== styleId; });
    if (state.styleId === styleId) {
      state.styleId = "";
    }
    saveStyles();
    renderStyleCards();
    persistState();
  }

  /**
   * 导出文章配图风格库为本地 JSON 文件（跨电脑迁移 / 备份用）
   * 文件格式：{ type: "article-styles", version: 1, exportedAt, styles: [...] }
   */
  function exportStyles() {
    try {
      if (!Array.isArray(state.styles) || state.styles.length === 0) {
        window.alert("当前风格库为空，没有可导出的内容。");
        return;
      }
      var payload = {
        type: "article-styles",
        version: 1,
        exportedAt: new Date().toISOString(),
        styles: state.styles
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      // 文件名带日期，方便辨认备份时间
      var dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      link.href = url;
      link.download = "article-styles-" + dateTag + ".json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      console.log("[article] 已导出 " + state.styles.length + " 个风格");
    } catch (error) {
      console.error("[article] 风格导出失败", error);
      window.alert("导出失败：" + (error && error.message ? error.message : "未知错误"));
    }
  }

  /**
   * 解析导入的风格 JSON 文本，兼容两种格式：
   * 1. 本工具导出的完整格式 { type, version, styles: [...] }（含小红书导出的文件）
   * 2. 纯风格数组 [ {name, prompt}, ... ]
   * @param {string} text 文件内容
   * @returns {Array<{name: string, prompt: string}>} 校验后的风格数组
   */
  function parseStylesImport(text) {
    var parsed = JSON.parse(text);
    var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.styles) ? parsed.styles : null);
    if (!list) {
      throw new Error("文件格式不正确：未找到风格数组");
    }
    // 只保留名称与描述齐全的项（字段做截断保护，防止超长内容撑爆界面）
    var cleaned = list
      .filter(function (s) { return s && typeof s.name === "string" && s.name.trim() && typeof s.prompt === "string" && s.prompt.trim(); })
      .map(function (s) {
        return {
          id: "style-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8),
          name: s.name.trim().slice(0, 30),
          prompt: s.prompt.trim().slice(0, 2000),
          createdAt: Date.now()
        };
      });
    if (cleaned.length === 0) {
      throw new Error("文件中没有有效的风格（需同时包含名称与描述）");
    }
    return cleaned;
  }

  /**
   * 处理选中的风格 JSON 文件：解析后由用户选择「合并」或「替换」导入（仅写入文章配图风格库）
   * 合并 = 同名风格覆盖描述、新风格追加；替换 = 清空当前库后导入（适合新电脑首次使用）
   * @param {File} file 用户选择的 JSON 文件
   */
  function importStylesFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (event) {
      try {
        var incoming = parseStylesImport(String(event.target && event.target.result || ""));
        var mergeMode = window.confirm(
          "检测到 " + incoming.length + " 个风格。\n\n" +
          "点击「确定」= 合并导入（与当前库同名的风格会被覆盖为新描述，其余追加）。\n" +
          "点击「取消」= 替换导入（清空当前风格库后导入，适合在新电脑首次使用）。"
        );
        if (mergeMode) {
          // 合并：以「名称」为唯一键，同名覆盖描述（保持原位置），新名称追加到末尾
          var byName = {};
          state.styles.forEach(function (s) { byName[s.name] = s; });
          var overwritten = 0;
          incoming.forEach(function (item) {
            if (byName[item.name]) {
              byName[item.name].prompt = item.prompt;
              overwritten += 1;
            } else {
              byName[item.name] = item;
              state.styles.push(item);
            }
          });
          window.alert("合并完成。\n覆盖同名风格：" + overwritten + " 个\n新增：" + (incoming.length - overwritten) + " 个\n当前共：" + state.styles.length + " 个");
        } else {
          state.styles = incoming;
          window.alert("替换完成。当前共 " + state.styles.length + " 个风格。");
        }
        saveStyles();
        // 导入后重置编辑表单：正在编辑的风格可能已被合并覆盖或替换删除
        resetStyleForm();
        renderStyleCards();
        persistState();
        console.log("[article] 风格导入完成，当前 " + state.styles.length + " 个");
      } catch (error) {
        console.error("[article] 风格导入失败", error);
        window.alert("导入失败：" + (error && error.message ? error.message : "未知错误"));
      }
    };
    reader.onerror = function () {
      console.error("[article] 风格文件读取失败", reader.error);
      window.alert("文件读取失败，请重试。");
    };
    reader.readAsText(file, "utf-8");
  }

  // ==================== AI 拆解插图点 ====================

  var ARTICLE_ANALYZE_INSTRUCTION = [
    "你是一名资深文章配图编辑。用户会给你一篇文章、需要的插图数量 N，以及本文使用的配图风格。",
    "",
    "第一目标——内容覆盖（最重要）：这 N 张图作为一组，要忠实反映文章的大部分核心观点与内容脉络。",
    "每张图表达的是「这一部分整体讲了什么」，绝不是只给文中某一句话画一个孤立场景。",
    "做法：先按行文顺序提炼各部分的核心观点/关键情节，把 N 张图分配到开头、发展、高潮、结尾各关键部分，",
    "全文重心（篇幅最长或观点最重要）可以多分一两张；绝不允许把插图都集中在最有画面感的一两段。",
    "",
    "第二目标——风格决定画面形态：配图风格不是事后滤镜，而是决定画面长什么样的根本，你必须按风格构思每张图：",
    "- 知识图谱/信息图/图表类风格 → 画面是结构化的节点、连线、层级框、标签卡片，把该部分的知识点组织成图形化关系，标签文字直接取自该部分的关键词；",
    "- 摄影/插画/漫画等场景类风格 → 画面是具体场景，但场景必须浓缩该部分的核心观点，抽象观点用贴切的视觉隐喻表达；",
    "- 其他风格同理：先想清楚这种风格下「表达这段内容」的典型画面形态，再写提示词。",
    "",
    "每个插图点输出：",
    "1. excerpt：该部分最能代表核心内容的原文摘录（1~2 句，不超过 80 字）",
    "2. title：4~12 字短标题，概括该部分的核心观点或内容",
    "3. prompt：生图提示词（中文）。按所选风格的画面形态把该部分核心内容视觉化：",
    "   结构化风格要写清画面包含哪些节点/模块/标签及其关系；场景类风格写清谁 + 在做什么 + 在哪里 + 关键细节。",
    "   prompt 中保留风格名称字样，但不要描写光线氛围，不要出现排版要求以外的文字内容说明。",
    "",
    "只输出一个 JSON 数组，以 [ 开头、以 ] 结尾，格式：",
    '[{"excerpt":"原文摘录","title":"短标题","prompt":"画面提示词"}]',
    "数组长度必须恰好等于要求的插图数量。不要输出任何解释文字或代码块标记。"
  ].join("\n");

  /**
   * 从模型输出中提取 JSON 数组（扫描第一个平衡的 [ ... ]）
   * @param {string} value 模型原始输出
   * @returns {Array|null} 解析结果，失败返回 null
   */
  function extractJsonArray(value) {
    var text = String(value || "");
    var start = text.indexOf("[");
    if (start === -1) return null;
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inString) {
        if (escaped) { escaped = false; }
        else if (ch === "\\") { escaped = true; }
        else if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "[" || ch === "{") { depth++; }
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            var parsed = JSON.parse(text.slice(start, i + 1));
            return Array.isArray(parsed) ? parsed : null;
          } catch (error) {
            console.error("[article] JSON 解析失败", error);
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * 获取文本模型配置，未配置时返回 null（由调用方走本地规则拆解）
   */
  function getLlmConfig() {
    try {
      var providerId = __APP.getOptimizeProvider();
      var model = __APP.getOptimizeModel();
      var provider = __APP.getLlmProviderById(providerId);
      if (!provider || !provider.apiKey || !model) return null;
      return { provider: provider, model: model };
    } catch (error) {
      return null;
    }
  }

  /**
   * 本地规则拆解（无文本模型时的兜底）：按段落均匀选取 N 个插图点
   * @param {string} article 文章全文
   * @param {number} count 插图数量
   * @returns {Array} 插图点数组
   */
  function ruleBasedAnalyze(article, count) {
    var paragraphs = String(article)
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n+/)
      .map(function (item) { return item.trim(); })
      .filter(function (item) { return item.length >= 10; });
    if (paragraphs.length === 0) {
      paragraphs = [article.trim()];
    }
    var points = [];
    for (var i = 0; i < count; i++) {
      // 均匀分布取样，避免集中在文章开头
      var index = Math.min(paragraphs.length - 1, Math.round(i * (paragraphs.length - 1) / Math.max(count - 1, 1)));
      var paragraph = paragraphs[index];
      var excerpt = paragraph.slice(0, 60).replace(/\s+/g, " ");
      points.push({
        id: __APP.createId(),
        excerpt: excerpt,
        title: "插图 " + (i + 1),
        prompt: "还原以下段落描绘的场景与情绪，画面主体明确、构图完整：\n" + excerpt
      });
    }
    return points;
  }

  /**
   * AI 拆解：调用文本模型选出 N 个插图点；失败时回退本地规则拆解
   * @returns {Promise<{points:Array, mode:"ai"|"rule"}>}
   */
  async function analyzeArticle(article, count) {
    var config = getLlmConfig();
    if (!config) {
      return { points: ruleBasedAnalyze(article, count), mode: "rule" };
    }
    var stylePrompt = getActiveStyle();
    var styleLabel = getActiveStyleLabel();
    var styleBrief = stylePrompt
      ? "配图风格：" + styleLabel + " —— " + stylePrompt
      : "配图风格：未指定（按通用插画/摄影场景构思，但依然保证内容覆盖）";
    var messages = [
      { role: "system", content: ARTICLE_ANALYZE_INSTRUCTION },
      { role: "user", content: "插图数量：" + count + "\n" + styleBrief + "\n\n文章全文：\n" + article }
    ];
    var text = "";
    // 最多尝试 2 次：失败时把错误回传，要求严格输出合法 JSON
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        text = await __APP.callLlmApi(config.provider.id || config.provider, config.model, messages, null);
        var parsed = extractJsonArray(text);
        if (!parsed || parsed.length === 0) {
          throw new Error("模型输出中没有合法的插图点数组");
        }
        var points = parsed
          .map(function (item, index) {
            if (!item || !item.prompt) return null;
            return {
              id: __APP.createId(),
              title: String(item.title || "插图 " + (index + 1)).slice(0, 24),
              excerpt: String(item.excerpt || "").slice(0, 120),
              prompt: String(item.prompt).slice(0, 900)
            };
          })
          .filter(Boolean);
        if (points.length === 0) {
          throw new Error("模型输出的插图点全部为空");
        }
        return { points: points, mode: "ai" };
      } catch (error) {
        console.error("[article] 第 " + (attempt + 1) + " 次拆解失败：" + (error && error.message));
        messages.push({ role: "assistant", content: String(text || "").slice(0, 1500) });
        messages.push({
          role: "user",
          content: "你上面的输出不是合法的 JSON 数组（" + (error && error.message ? error.message : "解析失败") + "）。请重新输出：只输出一个 JSON 数组，以 [ 开头、以 ] 结尾，所有键名和字符串值都用英文双引号包裹，不要包含解释文字或代码块标记。"
        });
      }
    }
    console.warn("[article] AI 拆解失败，回退到本地规则拆解");
    return { points: ruleBasedAnalyze(article, count), mode: "rule" };
  }

  /**
   * 智能推荐张数：有文本模型时让模型按文章结构决定，否则按字数估算
   * @returns {Promise<number>} 推荐张数（1~8）
   */
  async function recommendCount(article) {
    var config = getLlmConfig();
    // 先按文章长度设置硬上限，避免文本模型对短文直接推荐 8 张
    var lengthLimit = article.length <= 180 ? 1
      : article.length <= 500 ? 2
        : article.length <= 900 ? 3
          : article.length <= 1400 ? 4
            : article.length <= 2200 ? 6 : MAX_COUNT;
    var fallback = Math.max(1, Math.min(lengthLimit, Math.ceil(article.length / 450)));
    if (!config) return fallback;
    try {
      var text = await __APP.callLlmApi(config.provider.id || config.provider, config.model, [
        { role: "system", content: "你是文章配图编辑。根据文章内容密度和结构推荐插图数量。必须遵守：180字以内只能推荐1张；181~500字最多2张；501~900字最多3张；901~1400字最多4张；1401~2200字最多6张；2200字以上最多8张。每张图必须承载一段完整核心内容，不要为了凑数量拆成孤立句子。只输出一个整数数字，不要输出任何其他内容。" },
        { role: "user", content: "文章全文（共" + article.length + "字）：\n" + article + "\n\n本次推荐的硬上限为 " + lengthLimit + " 张，请在 1 到 " + lengthLimit + " 张中选择最合适的数量。" }
      ], null);
      var n = parseInt(String(text).replace(/[^0-9]/g, ""), 10);
      if (!isNaN(n) && n >= 1) return Math.min(n, lengthLimit);
    } catch (error) {
      console.warn("[article] 智能张数推荐失败，使用字数估算", error);
    }
    return fallback;
  }

  // ==================== 插图点列表渲染 ====================

  function renderPoints() {
    var wrap = elements.points;
    wrap.innerHTML = "";
    state.points.forEach(function (point, index) {
      var card = document.createElement("div");
      card.className = "article-point-card";
      card.dataset.pointId = point.id;

      var head = document.createElement("div");
      head.className = "article-point-head";
      var badge = document.createElement("span");
      badge.className = "article-point-index";
      badge.textContent = String(index + 1);
      var title = document.createElement("input");
      title.className = "article-point-title";
      title.type = "text";
      title.value = point.title;
      title.maxLength = 20;
      title.addEventListener("change", function () {
        point.title = title.value;
        persistState();
      });
      head.appendChild(badge);
      head.appendChild(title);
      card.appendChild(head);

      if (point.excerpt) {
        var excerpt = document.createElement("p");
        excerpt.className = "article-point-excerpt";
        excerpt.textContent = "原文：" + point.excerpt;
        card.appendChild(excerpt);
      }

      var prompt = document.createElement("textarea");
      prompt.className = "text-input article-point-prompt";
      prompt.rows = 3;
      prompt.value = point.prompt;
      prompt.addEventListener("change", function () {
        point.prompt = prompt.value;
        persistState();
      });
      card.appendChild(prompt);

      var remove = document.createElement("button");
      remove.className = "ghost-button article-point-remove";
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", function () {
        state.points = state.points.filter(function (item) { return item.id !== point.id; });
        delete state.results[point.id];
        renderPoints();
        persistState();
      });
      card.appendChild(remove);

      wrap.appendChild(card);
    });
    elements.generate.textContent = "开始生图（共 " + state.points.length + " 张）";
    elements.generate.disabled = state.points.length === 0 || state.running;
    // 提示行说明当前生效的风格，避免「选了风格但提示词里看不到」的困惑
    var styleLabel = getActiveStyleLabel();
    elements.pointsTip.textContent = styleLabel
      ? "已按「" + styleLabel + "」风格构思每张图的画面形态，提交生图时会再次注入风格描述确保统一。可修改提示词、删除或补充插图点。"
      : "每张图对应文章一部分的核心内容。当前未选风格，配图将忠实于提示词本身的画面描述。";
  }

  // ==================== 生图（服务端后台任务） ====================

  /**
   * 组装一个生图任务（payload 与创作台后台任务格式一致）
   * @param {Object} point 插图点
   * @returns {Object} job payload；通道缺失时抛错
   */
  function buildJob(point) {
    var resolved = __APP.resolveImageChannel(elements.model.value);
    if (!resolved) {
      throw new Error("当前模型没有可用的生图通道，请先到设置页启用或配置对应通道。");
    }
    var ch = resolved.channel;
    if (!(ch.apiKey || "").trim()) {
      throw new Error("通道「" + ch.name + "」的 API Key 为空，请先在设置页填写。");
    }
    var stylePrompt = getActiveStyle();
    // 最终提示词 = 画面提示词 + 统一风格注入（保证系列插图画风一致）
    var finalPrompt = stylePrompt
      ? point.prompt + "\n\n风格要求（本组插图统一画风）：" + stylePrompt
      : point.prompt;
    var quality = elements.quality.value;
    var qualityLabel = (__APP.IMAGE_QUALITIES.find(function (item) { return item.value === quality; }) || {}).label || quality;
    return {
      id: __APP.createId(),
      rawPrompt: point.prompt,
      finalPrompt: finalPrompt,
      topic: "文章配图-" + point.title,
      model: elements.model.value.split("|")[0],
      channel: {
        type: ch.type,
        name: ch.name,
        baseUrl: ch.baseUrl,
        apiKey: ch.apiKey,
        model: resolved.model,
        mode: ch.mode || "auto"
      },
      aspectRatio: elements.ratio.value,
      imageQuality: quality,
      imageQualityLabel: qualityLabel,
      styleTemplateId: "none",
      styleTemplateLabel: getActiveStyleLabel(),
      mode: "text",
      modeLabel: "文章配图",
      imageCount: 1,
      mediaType: ""
    };
  }

  function setRunning(running) {
    state.running = running;
    elements.analyze.disabled = running || elements.text.value.trim().length === 0;
    elements.generate.disabled = running || state.points.length === 0;
    elements.stop.hidden = !running;
    if (!running) {
      elements.stop.disabled = false;
    }
  }

  /**
   * 提交全部插图点到本地服务，并进入轮询
   */
  async function startGeneration() {
    if (state.points.length === 0) return;
    if (!SERVER_MODE) {
      showStatus("文章配图依赖本地服务后台执行，请通过 start.bat 启动后使用。", true);
      return;
    }

    var jobs = [];
    try {
      state.points.forEach(function (point) {
        jobs.push(buildJob(point));
      });
    } catch (error) {
      showStatus(error.message, true);
      return;
    }

    setRunning(true);
    showStatus("正在提交 " + jobs.length + " 个生图任务…");
    renderResultsSkeleton(jobs);

    try {
      var response = await fetch(SERVER_TASKS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: jobs })
      });
      var data = await response.json();
      if (!response.ok || !data || !data.ok || !Array.isArray(data.tasks)) {
        throw new Error(data && data.error ? data.error : "任务提交失败");
      }
      data.tasks.forEach(function (task, index) {
        var point = state.points[index];
        if (!point) return;
        state.tasks[task.id] = point.id;
        state.results[point.id] = {
          status: "pending",
          queueStatus: task.status || (index === 0 ? "running" : "queued")
        };
        // 只有当前执行的任务记录开始时间；排队任务不虚增耗时
        if (task.status === "running" || index === 0) {
          state.submitAt[point.id] = Date.now();
        }
        renderResultCard(point.id);
      });
      showStatus("已提交 " + data.tasks.length + " 个任务，后台将严格逐张生成，可离开本页，生图不会中断。");
      persistState();
      ensurePolling();
      ensureElapsedTicker();
    } catch (error) {
      console.error("[article] 任务提交失败", error);
      showStatus("任务提交失败：" + (error && error.message ? error.message : "未知错误"), true);
      setRunning(false);
      state.points.forEach(function (point) {
        state.results[point.id] = { status: "failed", error: "任务提交失败" };
        renderResultCard(point.id);
      });
      persistState();
    }
  }

  /** 停止全部后台任务 */
  async function stopGeneration() {
    elements.stop.disabled = true;
    // 交给服务端判断：已结束的任务会被自动忽略，只取消排队/执行中的
    var ids = Object.keys(state.tasks);
    if (ids.length === 0) return;
    try {
      await fetch(SERVER_TASKS_URL + "/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids })
      });
    } catch (error) {
      console.error("[article] 取消任务失败", error);
    }
    showStatus("已发出停止指令，正在等待任务退出…");
  }

  // ---------- 结果卡片渲染 ----------

  function findPointCard(pointId) {
    return elements.results.querySelector('[data-point-id="' + pointId + '"]');
  }

  /** 根据插图点创建一张结果卡（生成中占位态） */
  function createResultCard(point, ratioCss) {
    var card = document.createElement("div");
    card.className = "article-result-card";
    card.dataset.pointId = point.id;
    card.innerHTML =
      '<div class="article-result-media" style="--article-media-ratio:' + ratioCss + '">' +
      '<div class="gen-blur-layer"></div>' +
      '<div class="gen-status-text"><span class="status-spinner"></span><span class="gen-status-label">正在生成图片...</span> <span class="gen-status-elapsed"></span></div>' +
      "</div>" +
      '<div class="article-result-body">' +
      '<p class="article-result-excerpt"></p>' +
      '<div class="article-result-actions">' +
      '<button class="ghost-button" data-action="regenerate" type="button" hidden>重新生成</button>' +
      '<button class="ghost-button" data-action="download" type="button" hidden>下载</button>' +
      '<button class="ghost-button" data-action="copy" type="button" hidden>复制提示词</button>' +
      '<span class="article-result-duration"></span>' +
      "</div></div>";
    var excerptNode = card.querySelector(".article-result-excerpt");
    excerptNode.textContent = point.excerpt ? "原文：" + point.excerpt : point.title;
    card.querySelector('[data-action="regenerate"]').addEventListener("click", function () {
      regeneratePoint(point.id);
    });
    card.querySelector('[data-action="copy"]').addEventListener("click", function () {
      window.navigator.clipboard.writeText(point.prompt).then(function () {
        showStatus("提示词已复制。");
      });
    });
    return card;
  }

  function currentRatioCss() {
    var ratioPair = String(elements.ratio.value || "3:4").split(":");
    return (Number(ratioPair[0]) || 3) + " / " + (Number(ratioPair[1]) || 4);
  }

  /** 生图前：按插图点铺一排占位卡 */
  function renderResultsSkeleton(jobs) {
    elements.resultsPanel.hidden = false;
    elements.results.innerHTML = "";
    var ratioCss = currentRatioCss();
    jobs.forEach(function (job, index) {
      var point = state.points[index];
      if (!point) return;
      elements.results.appendChild(createResultCard(point, ratioCss));
    });
  }

  /** 断点恢复：按插图点 + 结果状态重建整个结果区 */
  function renderResultsFromState() {
    var hasResults = state.points.some(function (point) { return state.results[point.id]; });
    if (!hasResults) return;
    elements.resultsPanel.hidden = false;
    elements.results.innerHTML = "";
    var ratioCss = currentRatioCss();
    state.points.forEach(function (point) {
      elements.results.appendChild(createResultCard(point, ratioCss));
      renderResultCard(point.id);
    });
    elements.downloadAll.hidden = false;
  }

  function escapeHtml(value) {
    var div = document.createElement("div");
    div.textContent = String(value == null ? "" : value);
    return div.innerHTML;
  }

  /** 根据 state.results 中该点的状态渲染结果卡（生成中/成功/失败） */
  function renderResultCard(pointId) {
    var card = findPointCard(pointId);
    if (!card) return;
    var point = state.points.find(function (item) { return item.id === pointId; });
    var result = state.results[pointId];
    if (!point || !result) return;
    var media = card.querySelector(".article-result-media");
    var regenerate = card.querySelector('[data-action="regenerate"]');
    var download = card.querySelector('[data-action="download"]');
    var durationNode = card.querySelector(".article-result-duration");

    if (result.status === "pending") {
      media.classList.remove("is-failed");
      var isQueued = result.queueStatus === "queued";
      var pendingLabel = isQueued ? "排队中，前一张完成后继续..." : "正在生成图片...";
      media.innerHTML = '<div class="gen-blur-layer"></div>' +
        '<div class="gen-status-text"><span class="status-spinner"' + (isQueued ? ' style="opacity:.45"' : '') + '></span><span class="gen-status-label">' + pendingLabel + '</span> <span class="gen-status-elapsed"></span></div>';
      regenerate.hidden = true;
      download.hidden = true;
      durationNode.textContent = "";
      updatePendingElapsed(pointId); // 只有当前执行中的任务显示实时耗时
    } else if (result.status === "done" && result.imageUrl) {
      media.classList.remove("is-failed");
      media.innerHTML = '<img src="' + escapeHtml(result.imageUrl) + '" alt="配图" />';
      regenerate.hidden = false;
      download.hidden = false;
      // 显示服务端统计的精确生成耗时
      durationNode.textContent = result.durationSeconds
        ? "耗时 " + __APP.formatDurationSeconds(result.durationSeconds)
        : "";
      download.onclick = function () {
        var link = document.createElement("a");
        link.href = result.imageUrl;
        link.download = "article-" + pointId + ".png";
        document.body.appendChild(link);
        link.click();
        link.remove();
      };
    } else {
      media.classList.add("is-failed");
      media.innerHTML = "生成失败：" + escapeHtml(result.error || "未知错误");
      regenerate.hidden = false;
      download.hidden = true;
      durationNode.textContent = "";
    }
  }

  /** 刷新某张进行中卡片的实时秒数（基于本地提交时间估算） */
  function updatePendingElapsed(pointId) {
    var card = findPointCard(pointId);
    if (!card) return;
    var elapsedNode = card.querySelector(".gen-status-elapsed");
    if (!elapsedNode) return;
    var startedAt = state.submitAt[pointId];
    if (!startedAt) {
      elapsedNode.textContent = "";
      return;
    }
    var seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    elapsedNode.textContent = seconds > 0 ? "(" + seconds + "s)" : "";
  }

  /** 启动实时秒数刷新器（1 秒一跳，刷新所有进行中的卡片） */
  function ensureElapsedTicker() {
    if (state.elapsedTimer) return;
    state.elapsedTimer = window.setInterval(function () {
      Object.keys(state.tasks).forEach(function (taskId) {
        updatePendingElapsed(state.tasks[taskId]);
      });
    }, 1000);
  }

  function stopElapsedTicker() {
    if (state.elapsedTimer) {
      window.clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
  }

  /** 单张重新生成：为该插图点重新提交一个任务 */
  async function regeneratePoint(pointId) {
    var point = state.points.find(function (item) { return item.id === pointId; });
    if (!point || state.running) return;
    try {
      var job = buildJob(point);
      state.results[pointId] = { status: "pending" };
      state.submitAt[pointId] = Date.now();
      renderResultCard(pointId);
      var response = await fetch(SERVER_TASKS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs: [job] })
      });
      var data = await response.json();
      if (!response.ok || !data || !data.ok || !Array.isArray(data.tasks) || data.tasks.length === 0) {
        throw new Error(data && data.error ? data.error : "任务提交失败");
      }
      state.tasks[data.tasks[0].id] = pointId;
      setRunning(true);
      persistState();
      ensurePolling();
    } catch (error) {
      console.error("[article] 重新生成失败", error);
      showStatus("重新生成失败：" + (error && error.message ? error.message : "未知错误"), true);
      state.results[pointId] = { status: "failed", error: error && error.message ? error.message : "未知错误" };
      renderResultCard(pointId);
      persistState();
    }
  }

  // ==================== 轮询任务状态 ====================

  function ensurePolling() {
    if (state.pollTimer) return;
    state.pollTimer = window.setInterval(function () {
      pollOnce().catch(function (error) {
        console.error("[article] 轮询失败，下个周期重试", error);
      });
    }, POLL_INTERVAL_MS);
    pollOnce().catch(function () { /* 首次拉取失败忽略 */ });
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    stopElapsedTicker();
    setRunning(false);
  }

  async function pollOnce() {
    var activeIds = Object.keys(state.tasks);
    if (activeIds.length === 0) {
      stopPolling();
      return;
    }
    var response = await fetch(SERVER_TASKS_URL, { method: "GET" });
    var data = await response.json();
    if (!response.ok || !data || !data.ok || !Array.isArray(data.tasks)) {
      throw new Error("任务状态查询失败");
    }
    var taskMap = {};
    data.tasks.forEach(function (task) { taskMap[task.id] = task; });

    var doneCount = 0;
    var failedCount = 0;
    activeIds.forEach(function (taskId) {
      var task = taskMap[taskId];
      var pointId = state.tasks[taskId];
      if (!task) {
        // 本地服务重启导致任务丢失
        delete state.tasks[taskId];
        delete state.submitAt[pointId];
        state.results[pointId] = { status: "failed", error: "本地服务中找不到该任务（服务可能已重启），请重新生成。" };
        renderResultCard(pointId);
        return;
      }
      if (task.status === "succeeded") {
        delete state.tasks[taskId];
        delete state.submitAt[pointId];
        doneCount += 1;
        var images = (task.record && task.record.images) || task.images || [];
        if (images.length > 0) {
          state.results[pointId] = {
            status: "done",
            imageUrl: images[0],
            durationSeconds: task.generationDurationSeconds || null
          };
          // 温馨小提示：每张配图成功后底部轻提示
          if (typeof __APP.showToast === "function") {
            var pointMeta = state.points.find(function (p) { return p.id === pointId; });
            __APP.showToast("✨ 配图「" + (pointMeta && pointMeta.title ? pointMeta.title : "插图") + "」已生成（" + doneCount + "/" + state.points.length + "）");
          }
        } else {
          state.results[pointId] = { status: "failed", error: "通道已返回但没有图片数据。" };
          failedCount += 1;
        }
        renderResultCard(pointId);
      } else if (task.status === "failed") {
        delete state.tasks[taskId];
        delete state.submitAt[pointId];
        failedCount += 1;
        state.results[pointId] = {
          status: "failed",
          error: task.error && task.error.message ? task.error.message : "生成失败"
        };
        renderResultCard(pointId);
      } else if (task.status === "queued" || task.status === "running") {
        // 后台任务按提交顺序串行执行：只有当前任务显示「生成中」，后续任务明确显示「排队中」
        state.results[pointId] = {
          status: "pending",
          queueStatus: task.status,
          durationSeconds: task.startedAt ? Math.floor((Date.now() - task.startedAt) / 1000) : null
        };
        renderResultCard(pointId);
      } else if (task.status === "cancelled") {
        delete state.tasks[taskId];
        delete state.submitAt[pointId];
        failedCount += 1; // 取消计入失败数，保证结束后汇总提示准确
        state.results[pointId] = { status: "failed", error: "任务已取消。" };
        renderResultCard(pointId);
      }
    });

    persistState();
    if (Object.keys(state.tasks).length === 0) {
      stopPolling();
      showStatus("生图结束：成功 " + doneCount + " 张，失败 " + failedCount + " 张。图片已保存到图片库。");
      elements.downloadAll.hidden = state.points.every(function (point) {
        return !state.results[point.id] || state.results[point.id].status !== "done";
      });
    }
  }

  // ==================== 事件绑定与初始化 ====================

  function bindEvents() {
    // 输入区
    elements.text.addEventListener("input", function () {
      updateCharCount();
      persistState();
    });
    elements.clear.addEventListener("click", function () {
      elements.text.value = "";
      updateCharCount();
      persistState();
      showStatus("");
    });
    elements.upload.addEventListener("click", function () { elements.file.click(); });
    elements.file.addEventListener("change", function () {
      if (elements.file.files && elements.file.files[0]) {
        handleFile(elements.file.files[0]);
      }
      elements.file.value = "";
    });
    elements.example.addEventListener("click", function () {
      elements.text.value = EXAMPLE_TEXT;
      updateCharCount();
      persistState();
      showStatus("已填入示例文章，可直接点击「AI 拆解插图点」体验。");
    });

    // 风格库（文章配图独立存储）
    elements.styleSearch.addEventListener("input", function () {
      state.styleFilter = elements.styleSearch.value;
      renderStyleCards();
    });
    // 导出/导入：操作文章配图自己的独立风格库，与小红书板块互不影响
    elements.styleExport.addEventListener("click", exportStyles);
    elements.styleImport.addEventListener("click", function () {
      elements.styleImportFile.value = ""; // 重置以便可选择同名文件
      elements.styleImportFile.click();
    });
    elements.styleImportFile.addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      importStylesFile(file);
    });
    // 「新建自定义风格」开关：展开/收起表单
    elements.styleNew.addEventListener("click", function () {
      var willOpen = elements.styleForm.hidden;
      elements.styleForm.hidden = !willOpen;
      elements.styleNew.textContent = willOpen ? "收起表单" : "＋ 新建自定义风格";
      if (willOpen) elements.styleName.focus();
    });
    elements.styleSave.addEventListener("click", handleStyleSave);
    elements.styleCancel.addEventListener("click", resetStyleForm);
    // 风格描述字数实时统计（如 566/2000）
    elements.stylePrompt.addEventListener("input", updateStylePromptCount);
    updateStylePromptCount();

    // 模型联动说明 + 配置持久化
    elements.model.addEventListener("change", function () {
      updateModelNote();
      persistState();
    });
    elements.ratio.addEventListener("change", persistState);
    elements.quality.addEventListener("change", persistState);
    elements.count.addEventListener("change", persistState);

    // 主流程
    elements.analyze.addEventListener("click", async function () {
      var article = elements.text.value.trim();
      if (!article) return;
      var countValue = elements.count.value;
      elements.analyze.disabled = true;
      showStatus(countValue === "auto" ? "正在分析文章并推荐张数…" : "正在拆解插图点…");
      try {
        var count = countValue === "auto"
          ? await recommendCount(article)
          : Math.max(1, Math.min(parseInt(countValue, 10) || 1, MAX_COUNT));
        var result = await analyzeArticle(article, count);
        state.points = result.points;
        // 新一轮拆解覆盖旧结果
        state.results = {};
        renderPoints();
        elements.pointsPanel.hidden = false;
        elements.pointsBody.hidden = false;
        elements.resultsPanel.hidden = true;
        persistState();
        showStatus(result.mode === "ai"
          ? "AI 已找出 " + result.points.length + " 个插图点，可直接修改后开始生图。"
          : "文本模型未配置或拆解失败，已按段落规则拆出 " + result.points.length + " 个插图点（配置「AI 助手模型」可获得更佳效果）。");
      } catch (error) {
        console.error("[article] 拆解失败", error);
        showStatus("拆解失败：" + (error && error.message ? error.message : "未知错误"), true);
      } finally {
        elements.analyze.disabled = elements.text.value.trim().length === 0;
      }
    });

    elements.addPoint.addEventListener("click", function () {
      state.points.push({
        id: __APP.createId(),
        title: "补充插图",
        excerpt: "",
        prompt: ""
      });
      renderPoints();
      persistState();
    });

    elements.generate.addEventListener("click", startGeneration);
    elements.stop.addEventListener("click", stopGeneration);

    // 一键清空重来：清掉本页全部创作状态（不影响风格库与通道配置）
    elements.reset.addEventListener("click", async function () {
      var message = state.running
        ? "正在生图中，清空将尝试停止后台任务，并清除本页全部内容与结果。确定吗？"
        : "将清除本页的文章、插图点与生成结果（不影响风格库和通道配置）。确定吗？";
      if (!window.confirm(message)) return;
      // 有任务在跑时先请求取消，避免后台继续消耗
      if (state.running && Object.keys(state.tasks).length > 0) {
        try {
          await fetch(SERVER_TASKS_URL + "/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: Object.keys(state.tasks) })
          });
        } catch (error) {
          console.warn("[article] 清空时取消任务失败", error);
        }
      }
      stopPolling();
      elements.text.value = "";
      state.points = [];
      state.results = {};
      state.submitAt = {};
      state.tasks = {};
      elements.count.value = "auto";
      // 重置界面
      elements.points.innerHTML = "";
      elements.results.innerHTML = "";
      elements.pointsPanel.hidden = true;
      elements.resultsPanel.hidden = true;
      elements.downloadAll.hidden = true;
      elements.generate.textContent = "开始生图";
      updateCharCount();
      persistState();
      showStatus("已全部清空，可以重新开始。");
    });

    elements.downloadAll.addEventListener("click", function () {
      var buttons = elements.results.querySelectorAll('[data-action="download"]:not([hidden])');
      buttons.forEach(function (button) { button.click(); });
    });

    // 标题条折叠（内容区、配置区、插图点、结果区）
    initCollapseToggle("article-input-toggle", "article-input-body");
    initCollapseToggle("article-config-toggle", "article-config-body");
    initCollapseToggle("article-points-toggle", "article-points-body");
    initCollapseToggle("article-results-toggle", "article-results-body");
  }

  function init() {
    fillModelSelect();
    fillSelect(elements.ratio, __APP.ASPECT_RATIOS.map(function (item) {
      return { value: item.value, label: item.label };
    }), "");
    fillSelect(elements.quality, __APP.IMAGE_QUALITIES.map(function (item) {
      return { value: item.value, label: item.label };
    }), "");
    loadStyles();
    var restored = restoreState();
    if (!state.styleId && state.styles.length > 0) {
      state.styleId = state.styles[0].id; // 默认选中第一个风格（与小红书一致）
    }
    renderStyleCards();
    // 文本模型未配置时显示配置引导（核心观点拆解依赖 AI 助手模型）
    elements.llmHint.hidden = Boolean(getLlmConfig());
    if (!SERVER_MODE) {
      showStatus("当前通过 file:// 直接打开，生图需要本地服务支持。请关闭本页，使用 start.bat 启动后再访问。", true);
      elements.analyze.disabled = true;
    }
    updateCharCount();
    bindEvents();
    // 断点恢复：有插图点就还原确认层和结果区
    if (restored && state.points.length > 0) {
      renderPoints();
      elements.pointsPanel.hidden = false;
      renderResultsFromState();
      showStatus("已恢复上次的内容与生成结果。");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
