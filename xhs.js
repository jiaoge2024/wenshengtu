/**
 * 小红书图文笔记板块（独立页面逻辑）
 *
 * 功能流程：
 *   输入主题 → ① 文本模型策划大纲（标题 + 封面 + 子主题列表）
 *            → ② 文本模型为每页生成「儿童版知识图解」风格的生图提示词
 *            → ③ 逐张调用现有生图通道出图（3:4 竖版），可随时停止
 *
 * 依赖：app-config.js（常量）、app-utils.js（proxyFetch / callLlmApi / 通道管理）
 * 注意：本文件自包含生图调用引擎，不依赖 index.html 的 app.js，避免影响主创作台逻辑。
 */
(function () {
  "use strict";

  window.__APP = window.__APP || {};

  // ==================== 内部状态 ====================
  var state = {
    styleId: "",                 // 当前选中的自定义风格 ID（空 = 未选择）
    styles: [],                  // 用户自定义风格库 [{id, name, prompt, createdAt}]
    styleEditingId: null,        // 正在编辑的风格 ID（null = 新增模式）
    styleFilter: "",             // 风格搜索关键词（空 = 显示全部）
    pageCount: 5,                // 计划生成的总张数（1-9，含 1 张封面）
    generating: false,           // 是否正在生成
    paused: false,               // 是否存在断点（暂停后按钮变为「继续生成」）
    abortController: null,       // 生成中断控制器（停止按钮使用）
    outline: null,               // LLM 解析出的笔记大纲
    pages: []                    // 笔记页数组：[{ kind, name, points, prompt, status, imageUrls, error }]
  };

  var elements = {};
  var cardRefs = []; // 每页卡片的 DOM 引用，与 state.pages 一一对应

  /** 快捷获取元素 */
  function $(id) {
    return document.getElementById(id);
  }

  // ==================== 草稿持久化 ====================

  /** 保存草稿（主题 / 风格 / 生图模型）到 localStorage */
  function persistDraft() {
    try {
      var draft = {
        topic: elements.topic.value,
        styleId: state.styleId,
        imageModel: elements.imageModel.value || "",
        imageQuality: elements.imageQuality ? elements.imageQuality.value : "",
        pageCount: state.pageCount
      };
      window.localStorage.setItem(__APP.STORAGE_KEYS.xhsDraft, JSON.stringify(draft));
    } catch (e) {
      console.error("[xhs] 草稿保存失败", e);
    }
  }

  /** 恢复上次草稿 */
  function restoreDraft() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.xhsDraft);
      if (!raw) return;
      var draft = JSON.parse(raw);
      if (draft && typeof draft === "object") {
        if (draft.topic) elements.topic.value = draft.topic;
        if (draft.imageModel) elements.imageModel.value = draft.imageModel;
        if (draft.imageQuality && elements.imageQuality) elements.imageQuality.value = draft.imageQuality;
        if (draft.styleId && findStyle(draft.styleId)) {
          state.styleId = draft.styleId;
        }
        if (draft.pageCount >= 1 && draft.pageCount <= 50) {
          state.pageCount = draft.pageCount;
          // 超过 9 张的草稿由 initPageCountSelect 选中「自定义」档位并回填数字
          if (elements.pageCount && draft.pageCount <= 9) elements.pageCount.value = String(draft.pageCount);
          updateCountNote();
        }
      }
    } catch (e) {
      console.error("[xhs] 草稿恢复失败", e);
    }
  }

  // ==================== 断点记忆（暂停 / 继续生成） ====================

  /** 同步「清空」按钮显隐：主题输入框有内容才显示，空时隐藏避免误触（仅在初始化完成后调用） */
  function syncTopicClearVisibility() {
    elements.topicClear.hidden = elements.topic.value.trim().length === 0;
  }

  /**
   * 保存断点到 localStorage：记录大纲与每页状态，恢复后可跳过已完成页继续生成
   * 若内容超出存储容量（图片 data URL 过大），降级为只存结构不含图片，恢复后已完成页会重新生成
   */
  function persistCheckpoint() {
    if (!state.outline || state.pages.length === 0) return;
    var checkpoint = {
      styleId: state.styleId,
      outline: state.outline,
      pages: state.pages,
      savedAt: Date.now()
    };
    try {
      window.localStorage.setItem(__APP.STORAGE_KEYS.xhsCheckpoint, JSON.stringify(checkpoint));
    } catch (e) {
      // 容量超限：去掉图片数据后再存
      try {
        checkpoint.pages = state.pages.map(function (p) {
          var copy = {};
          for (var key in p) { if (key !== "imageUrls") copy[key] = p[key]; }
          return copy;
        });
        window.localStorage.setItem(__APP.STORAGE_KEYS.xhsCheckpoint, JSON.stringify(checkpoint));
        console.warn("[xhs] 断点内容过大，已降级保存（已生成的图片不入断点，继续时会重新生成这些页）");
      } catch (e2) {
        console.error("[xhs] 断点保存失败", e2);
      }
    }
  }

  /** 清除断点记录（全部完成后调用） */
  function clearCheckpoint() {
    try {
      window.localStorage.removeItem(__APP.STORAGE_KEYS.xhsCheckpoint);
    } catch (e) { /* 忽略清除失败 */ }
  }

  /**
   * 页面加载时恢复断点：刷新页面后仍可点击「继续生成」接着跑
   * @returns {boolean} 是否成功恢复了断点
   */
  function restoreCheckpoint() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.xhsCheckpoint);
      if (!raw) return false;
      var checkpoint = JSON.parse(raw);
      if (!checkpoint || !checkpoint.outline || !Array.isArray(checkpoint.pages) || checkpoint.pages.length === 0) {
        clearCheckpoint();
        return false;
      }
      // 超过 24 小时的断点视为过期，自动清除
      if (checkpoint.savedAt && Date.now() - checkpoint.savedAt > 24 * 60 * 60 * 1000) {
        clearCheckpoint();
        return false;
      }
      if (checkpoint.styleId && findStyle(checkpoint.styleId)) {
        state.styleId = checkpoint.styleId;
      }
      state.outline = checkpoint.outline;
      // 降级保存的断点里已完成页可能缺图片数据，这些页重置为待生成
      state.pages = checkpoint.pages.map(function (p) {
        if (p.status === "done" && (!Array.isArray(p.imageUrls) || p.imageUrls.length === 0)) {
          p.status = "pending";
        }
        return p;
      });
      state.paused = true;
      renderOutline(state.outline);
      renderPages(state.pages);
      elements.steps.hidden = false;
      setStep(3);
      var doneCount = state.pages.filter(function (p) { return p.status === "done"; }).length;
      showStatus("检测到上次未完成的生成断点（已完成 " + doneCount + "/" + state.pages.length + " 张），点击「继续生成」接着出图。", false);
      return true;
    } catch (e) {
      console.error("[xhs] 断点恢复失败", e);
      return false;
    }
  }

  /** 生成收尾：全部完成则清除断点；仍有未完成页则保留断点，供「继续生成」补跑/重试 */
  function finishRunCleanup() {
    var allDone = state.pages.length > 0 && state.pages.every(function (p) { return p.status === "done"; });
    if (allDone) {
      state.paused = false;
      clearCheckpoint();
    } else {
      state.paused = true;
      persistCheckpoint();
    }
  }

  /** 从断点继续生成：跳过已完成页，只补生成剩余页面（含之前失败的页） */
  async function resumeGenerate() {
    if (state.generating || !state.paused) return;
    var resolved = __APP.resolveImageChannel(elements.imageModel.value);
    var channel = resolved ? resolved.channel : null;
    if (!channel) {
      showStatus("当前生图模型不可用，请先到设置页启用并配置生图通道。", true);
      return;
    }
    var pendingCount = state.pages.filter(function (p) { return p.status !== "done"; }).length;
    if (pendingCount === 0) {
      finishRunCleanup();
      syncControls();
      return;
    }

    state.generating = true;
    state.abortController = new AbortController();
    var signal = state.abortController.signal;
    syncControls();
    elements.steps.hidden = false;
    setStep(3);

    try {
      showRunStatus("还有 " + pendingCount + " 张未生成，接着出图...");
      await generateAllPages(channel, signal);
      finishRunCleanup();
    } catch (error) {
      if (error && error.name === "AbortError") {
        persistCheckpoint();
        showStatus("已再次暂停。点击「继续生成」可随时接着生成。", false);
      } else {
        console.error("[xhs] 继续生成失败", error);
        state.paused = false;
        clearCheckpoint();
        showStatus("继续生成失败：" + (error && error.message ? error.message : "未知错误"), true);
      }
    } finally {
      state.generating = false;
      state.abortController = null;
      syncControls();
    }
  }

  // ==================== 自定义风格库（增删改查） ====================

  /** 简易 HTML 转义，防止风格名/描述中的特殊字符破坏页面结构 */
  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 从 localStorage 加载自定义风格库；首次使用时写入种子风格 */
  function loadStyles() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.xhsStyles);
      if (raw === null) {
        // 首次使用：种子风格作为第一条自定义风格（完全可编辑/删除）
        state.styles = [{
          id: "style-" + Date.now(),
          name: __APP.XHS_SEED_STYLE.name,
          prompt: __APP.XHS_SEED_STYLE.prompt,
          createdAt: Date.now()
        }];
        saveStyles();
        return;
      }
      var parsed = JSON.parse(raw);
      state.styles = Array.isArray(parsed) ? parsed.filter(function (s) { return s && s.name && s.prompt; }) : [];
    } catch (e) {
      console.error("[xhs] 风格库加载失败", e);
      state.styles = [];
    }
  }

  /** 保存风格库到 localStorage */
  function saveStyles() {
    try {
      window.localStorage.setItem(__APP.STORAGE_KEYS.xhsStyles, JSON.stringify(state.styles));
    } catch (e) {
      console.error("[xhs] 风格库保存失败", e);
    }
  }

  /** 根据 ID 查找自定义风格 */
  function findStyle(styleId) {
    return state.styles.find(function (s) { return s.id === styleId; }) || null;
  }

  /** 风格搜索框显示阈值：达到该数量才显示搜索框，避免少量风格时界面冗余 */
  var STYLE_SEARCH_THRESHOLD = 10;

  /** 渲染自定义风格卡片列表：点击卡片选中，卡片上带编辑/删除按钮；有搜索词时按名称过滤 */
  function renderStyleCards() {
    var wrap = elements.styleCards;
    wrap.innerHTML = "";
    // 搜索框仅在风格数量达到阈值时显示
    if (elements.styleSearch) {
      elements.styleSearch.hidden = state.styles.length < STYLE_SEARCH_THRESHOLD;
    }
    if (state.styles.length === 0) {
      elements.styleEmpty.hidden = true;
      var empty = document.createElement("p");
      empty.className = "xhs-style-empty";
      empty.textContent = "还没有自定义风格，先在下方添加一个吧。风格描述会作为固定画风贯穿封面与每张分镜图。";
      wrap.appendChild(empty);
      return;
    }
    // 按关键词过滤（匹配名称，不区分大小写）；风格未达阈值时搜索框已隐藏，忽略残留关键词
    var keyword = state.styles.length >= STYLE_SEARCH_THRESHOLD ? state.styleFilter.trim().toLowerCase() : "";
    var visibleStyles = state.styles.filter(function (style) {
      return !keyword || String(style.name || "").toLowerCase().indexOf(keyword) !== -1;
    });
    // 无匹配结果时给出提示，避免空白区域让用户困惑
    elements.styleEmpty.hidden = visibleStyles.length > 0;
    visibleStyles.forEach(function (style) {
      var card = document.createElement("div");
      card.className = "xhs-style-card" + (style.id === state.styleId ? " is-active" : "");
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      var desc = String(style.prompt || "");
      if (desc.length > 90) desc = desc.slice(0, 90) + "…";
      // 名称过长时截断展示（完整名称见悬停提示），避免撑破卡片
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
      // 点击卡片主体 → 选中该风格
      card.addEventListener("click", function () {
        state.styleId = style.id;
        renderStyleCards();
        persistDraft();
      });
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          state.styleId = style.id;
          renderStyleCards();
          persistDraft();
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

  /** 进入编辑模式：表单填入风格内容，按钮变为「保存修改」 */
  function startEditStyle(styleId) {
    var style = findStyle(styleId);
    if (!style) return;
    state.styleEditingId = styleId;
    elements.styleName.value = style.name;
    elements.stylePrompt.value = style.prompt;
    elements.styleSave.textContent = "保存修改";
    elements.styleCancel.hidden = false;
    updateStylePromptCount();
    // 编辑时自动展开表单（与文章配图板块同款交互）
    elements.styleForm.hidden = false;
    elements.styleNew.textContent = "收起表单";
    elements.styleName.focus();
  }

  /** 重置风格表单为新增模式 */
  function resetStyleForm() {
    state.styleEditingId = null;
    elements.styleName.value = "";
    elements.stylePrompt.value = "";
    elements.styleSave.textContent = "保存自定义风格";
    elements.styleCancel.hidden = true;
    updateStylePromptCount();
    // 收起表单，恢复为「新建」按钮
    elements.styleForm.hidden = true;
    elements.styleNew.textContent = "＋ 新建自定义风格";
  }

  /** 更新风格描述字数实时统计（如 566/2000） */
  function updateStylePromptCount() {
    var counter = $("xhs-style-prompt-count");
    if (!counter) return;
    counter.textContent = elements.stylePrompt.value.length + "/2000";
  }

  /** 保存自定义风格：新增或更新，并写入 localStorage */
  function handleStyleSave() {
    var name = elements.styleName.value.trim();
    var prompt = elements.stylePrompt.value.trim();
    if (!name) {
      window.alert("请先填写风格名称。");
      elements.styleName.focus();
      return;
    }
    if (!prompt) {
      window.alert("请先填写风格描述 Prompt（它将作为固定画风注入每一张图）。");
      elements.stylePrompt.focus();
      return;
    }
    if (state.styleEditingId) {
      // 编辑模式：更新已有风格
      var style = findStyle(state.styleEditingId);
      if (style) {
        style.name = name;
        style.prompt = prompt;
      }
    } else {
      // 新增模式：追加并自动选中新风格
      var newStyle = { id: "style-" + Date.now(), name: name, prompt: prompt, createdAt: Date.now() };
      state.styles.push(newStyle);
      state.styleId = newStyle.id;
    }
    saveStyles();
    resetStyleForm();
    renderStyleCards();
    persistDraft();
  }

  /** 删除自定义风格；若删除的是当前选中风格则自动切换到第一条 */
  function deleteStyle(styleId) {
    var style = findStyle(styleId);
    if (!style) return;
    if (!window.confirm('确定删除风格「' + style.name + '」吗？删除后不可恢复。')) return;
    state.styles = state.styles.filter(function (s) { return s.id !== styleId; });
    if (state.styleId === styleId) {
      state.styleId = state.styles.length > 0 ? state.styles[0].id : "";
    }
    saveStyles();
    renderStyleCards();
    persistDraft();
  }

  /**
   * 导出风格库为本地 JSON 文件（跨电脑迁移 / 备份用）
   * 文件格式：{ type: "xhs-styles", version: 1, exportedAt, styles: [...] }
   */
  function exportStyles() {
    try {
      if (!Array.isArray(state.styles) || state.styles.length === 0) {
        window.alert("当前风格库为空，没有可导出的内容。");
        return;
      }
      var payload = {
        type: "xhs-styles",
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
      link.download = "xhs-styles-" + dateTag + ".json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      console.log("[xhs] 已导出 " + state.styles.length + " 个风格");
    } catch (error) {
      console.error("[xhs] 风格导出失败", error);
      window.alert("导出失败：" + (error && error.message ? error.message : "未知错误"));
    }
  }

  /**
   * 解析导入的风格 JSON 文本，兼容两种格式：
   * 1. 本工具导出的完整格式 { type, version, styles: [...] }
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
   * 处理选中的风格 JSON 文件：解析后由用户选择「合并」或「替换」导入
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
        console.log("[xhs] 风格导入完成，当前 " + state.styles.length + " 个");
      } catch (error) {
        console.error("[xhs] 风格导入失败", error);
        window.alert("导入失败：" + (error && error.message ? error.message : "未知错误"));
      }
    };
    reader.onerror = function () {
      console.error("[xhs] 风格文件读取失败", reader.error);
      window.alert("文件读取失败，请重试。");
    };
    reader.readAsText(file, "utf-8");
  }

  /** 绑定风格表单事件 */
  function bindStyleForm() {
    elements.styleSave.addEventListener("click", handleStyleSave);
    elements.styleCancel.addEventListener("click", resetStyleForm);
    // 「新建自定义风格」开关：展开/收起表单（与文章配图板块同款交互）
    elements.styleNew.addEventListener("click", function () {
      var willOpen = elements.styleForm.hidden;
      elements.styleForm.hidden = !willOpen;
      elements.styleNew.textContent = willOpen ? "收起表单" : "＋ 新建自定义风格";
      if (willOpen) elements.styleName.focus();
    });
    // 风格描述字数实时统计（如 566/2000）
    elements.stylePrompt.addEventListener("input", updateStylePromptCount);
    updateStylePromptCount();
    // 导出：直接下载 JSON 文件
    elements.styleExport.addEventListener("click", exportStyles);
    // 导入：通过隐藏的 file input 选择文件；重置 value 以便可选同名文件
    elements.styleImport.addEventListener("click", function () {
      elements.styleImportFile.value = "";
      elements.styleImportFile.click();
    });
    elements.styleImportFile.addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      importStylesFile(file);
    });
  }

  // ==================== 生成张数选择 ====================

  /** 更新张数说明文字（如「共 5 张 = 1 张封面 + 4 张内容页」） */
  function updateCountNote() {
    if (!elements.countNote) return;
    var note = state.pageCount === 1
      ? "共 1 张（仅封面）"
      : "共 " + state.pageCount + " 张 = 1 张封面 + " + (state.pageCount - 1) + " 张内容页";
    // 张数较多时提醒用户可利用断点续生成，避免长时间等待的焦虑
    if (state.pageCount > 9) {
      note += " · 张数较多，中途可随时停止并继续";
    }
    elements.countNote.textContent = note;
  }

  /** 同步自定义张数输入框的显隐与回填值 */
  function syncCustomCountInput() {
    var isCustom = elements.pageCount.value === "custom";
    elements.pageCountCustom.hidden = !isCustom;
    if (isCustom) {
      elements.pageCountCustom.value = String(state.pageCount);
    }
  }

  /** 应用新的张数：更新状态、说明文字并写入草稿 */
  function applyPageCount(value) {
    var count = Math.floor(Number(value));
    if (isNaN(count)) return;
    // 钳制到 1-50：下限保证至少一张封面，上限避免 LLM 大纲过长导致输出不稳定
    if (count < 1) count = 1;
    if (count > 50) count = 50;
    state.pageCount = count;
    updateCountNote();
    persistDraft();
  }

  /**
   * 初始化生成张数选择器：预设 1-9 张 + 「自定义张数…」（支持 1-50），默认 5
   * 大于 9 张的场景（如 13/15/20 张长篇笔记）通过自定义输入框覆盖
   */
  function initPageCountSelect() {
    if (!elements.pageCount) return;
    for (var i = 1; i <= 9; i++) {
      var option = document.createElement("option");
      option.value = String(i);
      option.textContent = i + " 张";
      elements.pageCount.appendChild(option);
    }
    // 自定义档位：选择后出现数字输入框，可填 1-50
    var customOption = document.createElement("option");
    customOption.value = "custom";
    customOption.textContent = "自定义张数…";
    elements.pageCount.appendChild(customOption);

    // 恢复上次的张数：超过 9 张时选中「自定义」并回填数字
    if (state.pageCount > 9) {
      elements.pageCount.value = "custom";
    } else {
      elements.pageCount.value = String(state.pageCount);
    }
    syncCustomCountInput();
    updateCountNote();

    // 切换档位：选择「自定义」时显示输入框并聚焦，切回预设档位时隐藏
    elements.pageCount.addEventListener("change", function () {
      if (elements.pageCount.value === "custom") {
        syncCustomCountInput();
        elements.pageCountCustom.focus();
        elements.pageCountCustom.select();
        return;
      }
      elements.pageCountCustom.hidden = true;
      applyPageCount(elements.pageCount.value);
    });

    // 自定义输入：输入过程中即时生效（钳制在 1-50），失焦时规范化显示
    elements.pageCountCustom.addEventListener("input", function () {
      if (elements.pageCountCustom.value) {
        applyPageCount(elements.pageCountCustom.value);
      }
    });
    elements.pageCountCustom.addEventListener("change", function () {
      applyPageCount(elements.pageCountCustom.value || 5);
      elements.pageCountCustom.value = String(state.pageCount);
    });
  }

  /** 渲染示例主题 chips */
  function renderSampleChips() {
    var wrap = elements.sampleChips;
    wrap.innerHTML = "";
    __APP.XHS_SAMPLE_TOPICS.forEach(function (topic) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "xhs-sample-chip";
      chip.textContent = topic;
      chip.title = "点击填入该示例主题";
      chip.addEventListener("click", function () {
        elements.topic.value = topic;
        persistDraft();
      });
      wrap.appendChild(chip);
    });
  }

  /** 初始化生图质量下拉框（与主创作台共用同一份质量选项，默认 2K） */
  function initImageQualitySelect() {
    var select = elements.imageQuality;
    if (!select) return;
    var qualities = Array.isArray(__APP.IMAGE_QUALITIES) ? __APP.IMAGE_QUALITIES : [];
    select.innerHTML = qualities.map(function (item) {
      return '<option value="' + item.value + '">' + item.label + "</option>";
    }).join("");
    // 默认 2K（与历史行为一致），草稿恢复会在 init 中稍后覆盖此值
    select.value = "2K";
    if (!select.value && qualities.length > 0) {
      select.value = qualities[0].value;
    }
    select.addEventListener("change", persistDraft);
  }

  function initImageModelSelect() {
    var select = elements.imageModel;
    // 按通道分组的二级下拉（一级通道，二级模型）
    var options = __APP.renderModelSelectOptions(select, "暂无可用生图通道，请先到设置页启用");
    // 恢复草稿里保存的选择；不存在时默认选第一项
    if (!select.value) {
      select.value = options.length > 0 ? options[0].value : "";
    }
  }

  /** 渲染当前文本模型信息（复用「AI 助手模型」的当前使用配置） */
  function renderLlmInfo() {
    var info = elements.llmInfo;
    try {
      var providerId = __APP.getOptimizeProvider();
      var model = __APP.getOptimizeModel();
      var provider = __APP.getLlmProviderById(providerId);
      if (provider && provider.apiKey && model) {
        info.textContent = provider.name + " · " + model + "（已就绪）";
        info.classList.remove("is-empty");
      } else {
        info.textContent = "未就绪：请先在设置页配置 AI 助手模型并填写 API Key";
        info.classList.add("is-empty");
      }
    } catch (e) {
      info.textContent = "未就绪：请先在设置页配置 AI 助手模型";
      info.classList.add("is-empty");
    }
  }

  // ==================== 进度与状态展示 ====================

  /**
   * 状态栏语义显示：成功绿 / 失败红 / 进行中琥珀（带旋转图标），错误提及「设置页」时附「去配置」跳转
   * @param {string} text 状态文本
   * @param {boolean} isError 是否为错误
   * @param {Object} [opts] 可选 { running: 进行中, success: 成功 }
   */
  function showStatus(text, isError, opts) {
    var options = opts || {};
    elements.status.hidden = false;
    elements.status.classList.toggle("is-error", Boolean(isError));
    elements.status.classList.toggle("is-success", !isError && Boolean(options.success));
    elements.status.classList.toggle("is-running", Boolean(options.running));
    elements.status.textContent = "";
    if (options.running) {
      var spinner = document.createElement("span");
      spinner.className = "status-spinner";
      elements.status.appendChild(spinner);
    }
    elements.status.appendChild(document.createTextNode(text));
    if (isError && /设置页|请先配置|未配置/.test(text)) {
      var link = document.createElement("a");
      link.className = "status-action-link";
      link.href = "settings.html";
      link.textContent = "去配置 →";
      elements.status.appendChild(link);
    }
  }

  /** 进行中状态快捷封装（琥珀色 + 旋转图标） */
  function showRunStatus(text) {
    showStatus(text, false, { running: true });
  }

  /** 成功状态快捷封装（绿色） */
  function showDoneStatus(text) {
    showStatus(text, false, { success: true });
  }

  /** 更新步骤条高亮（1 策划大纲 / 2 生成提示词 / 3 逐张出图） */
  function setStep(step) {
    elements.steps.hidden = false;
    Array.prototype.forEach.call(elements.steps.querySelectorAll(".xhs-step"), function (node) {
      var value = Number(node.getAttribute("data-step"));
      node.classList.toggle("is-active", value === step);
      node.classList.toggle("is-done", value < step);
    });
  }

  /** 同步按钮可用状态（生成中禁用开始、显示停止） */
  function syncControls() {
    elements.start.disabled = state.generating;
    elements.start.classList.toggle("is-loading", state.generating);
    // 停止按钮三态：生成中显示「停止生成」；有断点时显示「继续生成」；其余隐藏
    if (state.generating) {
      elements.stop.hidden = false;
      elements.stop.textContent = "停止生成";
    } else if (state.paused) {
      elements.stop.hidden = false;
      elements.stop.textContent = "继续生成 ▶";
    } else {
      elements.stop.hidden = true;
    }
    Array.prototype.forEach.call(document.querySelectorAll(".js-regen-page"), function (button) {
      button.disabled = state.generating;
    });
  }

  // ==================== LLM 调用（大纲 + 提示词） ====================

  /**
   * 从 LLM 返回文本中提取并解析第一段完整 JSON
   * 兼容模型输出 ```json 代码块包裹、JSON 后附带解释文字、重复输出多段 JSON 等情况
   * 做法：定位第一个 { 或 [，用括号配对扫描（跳过字符串与转义）找到与之匹配的闭合符，
   * 只截取这一段进行解析，丢弃其后所有多余内容
   * @param {string} text LLM 原始返回
   * @returns {Object|Array} 解析后的 JSON
   */
  /**
   * 清理候选 JSON 文本尾部的悬空残留，便于闭合修复后解析：
   * - 尾逗号：[1,2,] / {"a":1,}
   * - 截断产生的悬空键：..., "points": （冒号后没有值就断了）
   * @param {string} candidate JSON 片段
   * @returns {string} 清理后的片段
   */
  function stripTrailingFragments(candidate) {
    // 删「逗号 + 闭合符」间的多余逗号（嵌套场景循环处理）：["p",] / {"a":1,}
    var text = candidate;
    var prev;
    do {
      prev = text;
      text = text.replace(/,(\s*[}\]])/g, "$1");
    } while (text !== prev);
    text = text.replace(/,\s*$/, "");
    // 悬空键：最后一个逗号后是 "key": 或 "key"（值缺失）
    text = text.replace(/,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, ",");
    return text.replace(/,\s*$/, "");
  }

  /**
   * 截断修复：把因模型输出上限而被截断的 JSON 尽量救回。
   * 策略：从尾部向前寻找「最后一个完整元素边界」（} 或 ]），截断到该处后
   * 补齐所有未闭合的括号与字符串，再尝试解析；逐个候选回退试探直到成功。
   * @param {string} value 已剥离代码块标记的原始文本
   * @param {number} start JSON 起始下标
   * @returns {Object|null} 修复解析成功的对象；全部候选失败时返回 null
   */
  function tryRepairTruncatedJson(value, start) {
    // 从尾部向前收集候选截断点（ } 或 ] 的位置），限制回退深度防止超长文本性能问题
    var candidates = [];
    for (var i = value.length - 1; i > start && candidates.length < 120; i--) {
      var c = value.charAt(i);
      if (c === "}" || c === "]") candidates.push(i);
    }
    for (var k = 0; k < candidates.length; k++) {
      var cut = candidates[k];
      var candidate = value.slice(start, cut + 1);
      // 重扫该片段：记录字符串状态与未闭合括号栈
      var stack = [];
      var inString = false;
      var escaped = false;
      for (var j = 0; j < candidate.length; j++) {
        var ch = candidate.charAt(j);
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
      }
      // 末尾悬空在字符串里：先补引号；再剥掉截断产生的悬空键/逗号；最后按栈补闭合符
      var repaired = candidate + (inString ? '"' : "");
      repaired = stripTrailingFragments(repaired);
      for (var t = stack.length - 1; t >= 0; t--) {
        repaired += stack[t] === "{" ? "}" : "]";
      }
      try {
        var parsed = JSON.parse(repaired);
        console.warn("[xhs] JSON 因输出截断而不完整，已自动修复（丢弃末尾不完整部分）", {
          原始长度: value.length,
          修复后: repaired.slice(0, 200) + "..."
        });
        return parsed;
      } catch (e) { /* 该候选边界无效，继续向前回退 */ }
    }
    return null;
  }

  function extractJson(text) {
    var value = String(text || "").trim();
    // 去掉 Markdown 代码块标记
    value = value.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    // 1) 整体直接解析（最常见情况，模型输出纯净 JSON）
    try {
      return JSON.parse(value);
    } catch (e) { /* 继续走括号配对提取 */ }

    // 2) 括号配对扫描，提取第一段完整 JSON
    var start = value.search(/[{[]/);
    if (start === -1) {
      console.error("[xhs] 模型返回内容中没有 JSON：", value.slice(0, 500));
      throw new Error("模型返回内容中没有找到 JSON 数据，请重试。");
    }
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < value.length; i++) {
      var ch = value.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          var candidate = value.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (parseError) {
            // 完整 JSON 解析失败：常见于尾逗号等轻微不规范，清理后再试一次
            try {
              return JSON.parse(stripTrailingFragments(candidate));
            } catch (cleanError) {
              console.error("[xhs] JSON 提取后仍解析失败：", candidate.slice(0, 500), parseError);
              throw new Error("模型返回的 JSON 格式有误，请重试。（" + (parseError && parseError.message ? parseError.message : "解析失败") + "）");
            }
          }
        }
      }
    }
    // 括号扫描到结尾仍未闭合：JSON 被模型输出上限截断，尝试截断修复（救回前面的完整页）
    console.error("[xhs] 模型返回的 JSON 不完整（疑似输出被截断），尝试自动修复：", value.slice(0, 300) + "...");
    var repaired = tryRepairTruncatedJson(value, start);
    if (repaired) {
      return repaired;
    }
    throw new Error("模型返回的 JSON 不完整且无法自动修复，请重试（张数较多时建议减少张数，或更换文本模型）。");
  }

  /** 获取当前文本模型配置（provider + model），未配置时抛出可读错误 */
  function getLlmConfig() {
    var providerId = __APP.getOptimizeProvider();
    var model = __APP.getOptimizeModel();
    var provider = __APP.getLlmProviderById(providerId);
    if (!provider) {
      throw new Error("未找到文本模型配置，请到设置页「AI 助手模型」完成配置。");
    }
    if (!provider.apiKey) {
      throw new Error("文本模型「" + provider.name + "」的 API Key 为空，请到设置页填写。");
    }
    if (!model) {
      throw new Error("文本模型未选择具体模型名，请到设置页填写。");
    }
    return { provider: provider, model: model };
  }

  /**
   * 第一步：调用文本模型策划笔记大纲
   * @param {string} topic 用户输入的主题
   * @param {AbortSignal} signal 中断信号
   * @returns {Object} 大纲 { title, cover:{heading,subheading,highlights}, pages:[{name,points}] }
   */
  async function requestOutline(topic, signal, pageCount) {
    var config = getLlmConfig();
    // 张数约束：总张数 = 1 张封面 + (N-1) 个子主题页，写入用户消息让模型严格遵守
    var requirement = pageCount >= 1
      ? "\n\n张数要求：总共生成 " + pageCount + " 张图 = 封面 1 张 + 子主题页 " + Math.max(pageCount - 1, 0) + " 张，pages 数组长度必须恰好为 " + Math.max(pageCount - 1, 0) + "。"
      : "";
    // 风格约束：把所选自定义风格作为固定画风注入大纲生成
    var style = findStyle(state.styleId);
    var styleText = style
      ? "\n\n风格要求（固定画风，必须贯穿封面与每一页的视觉呈现）：风格名称：「" + style.name + "」。风格描述：" + style.prompt
      : "";
    var messages = [
      { role: "system", content: __APP.XHS_OUTLINE_INSTRUCTION },
      { role: "user", content: "笔记主题：" + topic + styleText + requirement }
    ];
    var lastError = null;
    // 最多尝试 3 次：每次失败把模型上次的错误输出回传，强调必须输出严格合法且完整的 JSON
    for (var attempt = 0; attempt < 3; attempt++) {
      var text = await __APP.callLlmApi(config.provider.id || config.provider, config.model, messages, signal);
      try {
        var outline = extractJson(text);
        // 仅封面（张数为 1）时允许 pages 为空数组
        if (!outline || !Array.isArray(outline.pages) || !outline.cover || (pageCount > 1 && outline.pages.length === 0)) {
          throw new Error("大纲结构不完整（缺少 cover 或 pages）");
        }
        // 截断修复可能救回的页数少于要求：不中断流程，但给出可见提示
        if (pageCount > 1 && outline.pages.length < Math.max(pageCount - 1, 0)) {
          console.warn("[xhs] 大纲页数少于所选张数：要求 " + (pageCount - 1) + " 页，实际 " + outline.pages.length + " 页（可能因模型输出截断）");
        }
        console.log("[xhs] 大纲解析完成", outline);
        return outline;
      } catch (error) {
        lastError = error;
        console.error("[xhs] 第 " + (attempt + 1) + " 次大纲解析失败：" + (error && error.message), "\n模型原始输出：", text);
        // 把错误输出和纠正要求加入对话，要求模型重新输出
        messages.push({ role: "assistant", content: String(text).slice(0, 2000) });
        messages.push({
          role: "user",
          content: "你上面的输出不是合法且完整的 JSON（" + (error && error.message ? error.message : "解析失败") + "）。请重新输出：只输出一个 JSON 对象，以 { 开头、以 } 结尾，所有键名和字符串值（包括数组里的每一项）都必须用英文双引号包裹，不要包含任何解释文字或代码块标记。若内容较长，请精简每页要点（每页 2 条即可），确保一次性输出完整的 JSON，绝对不要中途截断。"
        });
      }
    }
    throw new Error("大纲解析失败（已自动重试 2 次）：" + (lastError && lastError.message ? lastError.message : "请重试"));
  }

  /**
   * 第二步：调用文本模型为每一页生成生图提示词
   * 失败或缺失的页面会回退到「大纲要点拼接」的兜底提示词，保证流程不中断
   * @param {Array} pages 页面数组（由 buildPages 生成）
   * @param {Object} outline 笔记大纲
   * @param {AbortSignal} signal 中断信号
   */
  async function assignPrompts(pages, outline, signal) {
    var config = getLlmConfig();
    var prompts = [];
    try {
      var text = await __APP.callLlmApi(config.provider.id || config.provider, config.model, [
        { role: "system", content: __APP.XHS_PROMPT_INSTRUCTION },
        { role: "user", content: "笔记大纲 JSON：\n" + JSON.stringify(outline) }
      ], signal);
      var parsed = extractJson(text);
      if (Array.isArray(parsed)) {
        prompts = parsed;
      }
    } catch (error) {
      // 提示词生成失败不中断整体流程：逐页回退到兜底提示词
      console.error("[xhs] 提示词生成失败，使用兜底提示词", error);
      showStatus("提示词智能生成失败（" + (error.message || "未知错误") + "），已回退到基础提示词，可直接继续出图。", true);
    }

    var promptMap = {};
    prompts.forEach(function (item) {
      if (item && typeof item.index === "number" && item.text) {
        promptMap[item.index] = String(item.text);
      }
    });

    pages.forEach(function (page, index) {
      var llmPrompt = promptMap[index];
      page.prompt = llmPrompt || buildFallbackPrompt(page, outline);
      // 统一拼接风格指令：所选自定义风格的描述作为固定画风追加到每条提示词末尾
      var style = findStyle(state.styleId);
      page.finalPrompt = style && style.prompt ? page.prompt + "\n\n画风要求：" + style.prompt : page.prompt;
    });
  }

  /**
   * 兜底提示词：当 LLM 提示词生成失败时，用大纲要点直接拼接
   * @param {Object} page 页面对象
   * @param {Object} outline 笔记大纲
   * @returns {string} 提示词
   */
  function buildFallbackPrompt(page, outline) {
    if (page.kind === "cover") {
      var highlights = (outline.cover && outline.cover.highlights) || (outline.pages || []).map(function (p) { return p.name; });
      return "知识图解封面图，画面中央醒目展示大号标题文字「" + (outline.cover.heading || outline.title) + "」，" +
        "副标题「" + ((outline.cover && outline.cover.subheading) || "") + "」，" +
        "画面中依次列出这些子主题名称：" + highlights.join("、") + "，每个子主题配一个对应的图示图标。";
    }
    var points = Array.isArray(page.points) ? page.points.join("；") : "";
    return "知识图解内容页，画面上方是大号标题文字「" + page.name + "」，" +
      "画面中用图示讲解以下要点：" + points + "，信息分区清晰，配箭头标注。";
  }

  // ==================== 生图调用引擎（自包含，支持同步/异步） ====================

  /**
   * 根据 Base URL 构建标准 OpenAI Images 接口 endpoint
   * 与主创作台 buildChannelEndpoint 逻辑一致
   */
  function buildChannelEndpoint(baseUrl) {
    var endpoint = (baseUrl || "").replace(/\/+$/, "");
    if (!endpoint) return "";
    if (!/\/images\/generations/.test(endpoint)) {
      endpoint += /\/v1(?:[\/?#]|$)/.test(endpoint) ? "/images/generations" : "/v1/images/generations";
    }
    return endpoint;
  }

  /**
   * 根据通道 Base URL 构建异步任务查询 endpoint（/v1/tasks/{id}）
   */
  function buildTaskEndpoint(baseUrl, taskId) {
    var normalized = (baseUrl || "").replace(/\/+$/, "").replace(/\/images\/generations(?:[?#].*)?$/, "");
    if (/\/v1(?:[\/?#]|$)/.test(normalized)) {
      return normalized + "/tasks/" + encodeURIComponent(taskId);
    }
    return normalized + "/v1/tasks/" + encodeURIComponent(taskId);
  }

  /** 可中断的延时等待（与主创作台 abortableSleep 行为一致） */
  function abortableSleep(ms, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new DOMException("生成已停止", "AbortError"));
    }
    return new Promise(function (resolve, reject) {
      var timeoutId = window.setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener("abort", function () {
        window.clearTimeout(timeoutId);
        reject(new DOMException("生成已停止", "AbortError"));
      }, { once: true });
    });
  }

  /** 从同步响应中提取图片（b64_json / url），与主创作台逻辑一致 */
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

  /** 从异步任务结果中提取图片，与主创作台逻辑一致 */
  function extractTaskImageUrls(taskData) {
    var resultImages = taskData && taskData.result && Array.isArray(taskData.result.images) ? taskData.result.images : [];
    var images = [];
    resultImages.forEach(function (item) {
      if (typeof item === "string" && item.trim()) {
        images.push(item);
      } else if (item && typeof item.b64_json === "string" && item.b64_json.trim()) {
        images.push("data:image/png;base64," + item.b64_json);
      } else if (item && Array.isArray(item.b64_json)) {
        item.b64_json.forEach(function (data) { if (typeof data === "string" && data.trim()) images.push("data:image/png;base64," + data); });
      } else if (item && typeof item.url === "string" && item.url.trim()) {
        images.push(item.url);
      } else if (item && Array.isArray(item.url)) {
        item.url.forEach(function (url) { if (typeof url === "string" && url.trim()) images.push(url); });
      }
    });
    return images;
  }

  /**
   * 轮询异步生图任务直到完成（与主创作台轮询参数一致）
   */
  async function pollImageTask(taskId, apiKey, signal, taskEndpoint) {
    var startedAt = Date.now();
    await abortableSleep(__APP.GPT_IMAGE_TASK_INITIAL_DELAY, signal);

    while (Date.now() - startedAt <= __APP.GPT_IMAGE_TASK_TIMEOUT) {
      var elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      var response = await __APP.proxyFetch(taskEndpoint, {
        method: "GET",
        signal: signal,
        headers: { Authorization: "Bearer " + apiKey }
      });
      var data = await response.json();
      var taskData = data && Array.isArray(data.data) ? data.data[0] : (data && data.data ? data.data : data);

      if (!response.ok || (data && data.code >= 400)) {
        throw new Error((data && data.error && data.error.message) || "任务查询失败（HTTP " + response.status + "）");
      }
      var status = String(taskData && taskData.status || "").trim().toLowerCase();
      if (["completed", "succeeded", "success", "done"].indexOf(status) !== -1) {
        var images = extractTaskImageUrls(taskData);
        if (images.length === 0) {
          throw new Error("任务已完成，但没有返回可用图片。");
        }
        return images;
      }
      if (["failed", "error", "cancelled", "canceled"].indexOf(status) !== -1) {
        throw new Error((taskData && taskData.error && taskData.error.message) || "任务生成失败。");
      }
      console.log("[xhs] 任务轮询中，已等待 " + elapsedSeconds + " 秒");
      await abortableSleep(__APP.GPT_IMAGE_TASK_POLL_INTERVAL, signal);
    }
    throw new Error("任务等待超过 10 分钟，已停止轮询。");
  }

  /**
   * 调用生图通道生成一张图片（支持 openai_images / agnes，自动适配同步/异步）
   * @param {Object} channel 生图通道配置对象
   * @param {string} finalPrompt 完整提示词（已拼接风格指令）
   * @param {AbortSignal} signal 中断信号
   * @param {Function} onProgress 进度回调（用于更新卡片状态文字）
   * @returns {Promise<string[]>} 图片 URL 数组
   */
  async function generateImage(channel, finalPrompt, signal, onProgress) {
    var apiKey = (channel.apiKey || "").trim();
    var model = channel.model;
    var baseUrl = (channel.baseUrl || "").replace(/\/+$/, "");
    if (!apiKey) throw new Error("通道「" + channel.name + "」的 API Key 为空，请先在设置页填写。");
    if (!model) throw new Error("通道「" + channel.name + "」的模型名为空，请先在设置页填写。");
    if (!baseUrl) throw new Error("通道「" + channel.name + "」的 Base URL 为空，请先在设置页填写。");

    var aspectRatio = __APP.XHS_ASPECT_RATIO;
    // 生图质量来自页面下拉框（1K/2K/4K），未选择时默认 2K
    var quality = elements.imageQuality && elements.imageQuality.value ? elements.imageQuality.value : "2K";

    if (channel.type === "agnes") {
      // Agnes 接口：同步返回 url
      onProgress("正在通过「" + channel.name + "」生成...");
      var agnesRes = await __APP.proxyFetch(buildChannelEndpoint(baseUrl), {
        method: "POST",
        signal: signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: model,
          prompt: finalPrompt,
          size: quality,
          ratio: aspectRatio,
          extra_body: { response_format: "url" }
        })
      });
      var agnesData = await agnesRes.json();
      if (!agnesRes.ok) {
        throw new Error((agnesData && agnesData.error && agnesData.error.message) || "Agnes 请求失败（HTTP " + agnesRes.status + "）");
      }
      var agnesFirst = agnesData && Array.isArray(agnesData.data) && agnesData.data[0];
      if (!agnesFirst || (!agnesFirst.url && !agnesFirst.b64_json)) {
        throw new Error("Agnes 已返回，但没有拿到图片数据。");
      }
      return [agnesFirst.url || "data:image/png;base64," + agnesFirst.b64_json];
    }

    // OpenAI Images 兼容接口：先按像素尺寸请求，尺寸报错时自动改用比例尺寸重试
    var endpoint = buildChannelEndpoint(baseUrl);

    async function callOnce(sizeFormat) {
      var res = await __APP.proxyFetch(endpoint, {
        method: "POST",
        signal: signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: model,
          prompt: finalPrompt,
          n: 1,
          size: __APP.getGptImageSize(aspectRatio, quality, sizeFormat),
          resolution: quality
        })
      });
      var resData = await res.json();
      return { response: res, data: resData };
    }

    onProgress("正在通过「" + channel.name + "」生成...");
    var result;
    try {
      result = await callOnce("pixels");
    } catch (networkError) {
      if (networkError && networkError.name === "AbortError") throw networkError;
      throw new Error("图片生成请求失败：" + (networkError && networkError.message ? networkError.message : "网络错误"));
    }

    // 尺寸格式错误时自动用比例重试（与主创作台行为一致）
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

    // 检查是否为异步模式（返回 task_id 则轮询）
    var firstData = result.data && Array.isArray(result.data.data) ? result.data.data[0] : null;
    if (firstData && firstData.task_id && (channel.mode === "async" || channel.mode === "auto")) {
      onProgress("任务已提交，等待出图...");
      return pollImageTask(firstData.task_id, apiKey, signal, buildTaskEndpoint(baseUrl, firstData.task_id));
    }

    // 同步模式：直接提取图片
    var syncImages = extractSyncImageUrls(result.data);
    if (syncImages.length === 0) {
      throw new Error("通道已返回，但没有拿到图片数据。");
    }
    return syncImages;
  }

  // ==================== 结果渲染 ====================

  /** 清空结果区 */
  function clearResults() {
    state.outline = null;
    state.pages = [];
    cardRefs = [];
    elements.outline.hidden = true;
    elements.pagesGrid.innerHTML = "";
  }

  /** 渲染大纲卡片 */
  function renderOutline(outline) {
    elements.outline.hidden = false;
    elements.outlineTitle.textContent = outline.title || "未命名笔记";
    elements.outlineSub.textContent = (outline.cover && outline.cover.subheading) || "";
    var wrap = elements.outlineHighlights;
    wrap.innerHTML = "";
    var highlights = (outline.cover && outline.cover.highlights) || outline.pages.map(function (p) { return p.name; });
    highlights.forEach(function (item) {
      var chip = document.createElement("span");
      chip.className = "xhs-outline-chip";
      chip.textContent = item;
      wrap.appendChild(chip);
    });
  }

  /** 由大纲构建页面数组：第 0 页为封面，之后每个子主题一页 */
  function buildPages(outline) {
    // 内容页数量受「生成张数」约束：总张数 = 1 张封面 + (N-1) 张内容页，多出的子主题直接裁掉
    var maxContent = Math.max(state.pageCount - 1, 0);
    var pages = [{
      kind: "cover",
      name: (outline.cover && outline.cover.heading) || outline.title || "封面",
      points: (outline.cover && outline.cover.highlights) || [],
      status: "pending",
      imageUrls: []
    }];
    (outline.pages || []).slice(0, maxContent).forEach(function (p) {
      pages.push({
        kind: "page",
        name: p.name || "未命名页",
        points: Array.isArray(p.points) ? p.points : [],
        status: "pending",
        imageUrls: []
      });
    });
    return pages;
  }

  /** 为所有页面创建卡片 DOM */
  function renderPages(pages) {
    elements.pagesGrid.innerHTML = "";
    cardRefs = [];
    pages.forEach(function (page, index) {
      var node = elements.cardTemplate.content.firstElementChild.cloneNode(true);
      var tag = node.querySelector(".xhs-page-tag");
      var title = node.querySelector(".xhs-page-title");
      var img = node.querySelector(".xhs-page-img");
      var placeholder = node.querySelector(".xhs-page-placeholder");
      var statusText = node.querySelector(".xhs-page-status-text");
      var spinner = node.querySelector(".xhs-page-spinner");
      var promptText = node.querySelector(".xhs-page-prompt");
      var promptEdit = node.querySelector(".xhs-page-prompt-edit");
      var editPromptButton = node.querySelector(".js-edit-prompt");
      var savePromptButton = node.querySelector(".js-save-prompt");
      var cancelPromptButton = node.querySelector(".js-cancel-prompt");
      var promptEditActions = node.querySelector(".xhs-prompt-edit-actions");
      var promptWrap = node.querySelector(".xhs-page-prompt-wrap");
      var actionsRow = node.querySelector(".xhs-page-actions");
      var copyButton = node.querySelector(".js-copy-prompt");
      var regenButton = node.querySelector(".js-regen-page");
      var downloadButton = node.querySelector(".js-download-page");

      tag.textContent = page.kind === "cover" ? "封面" : "P" + index;
      if (page.kind !== "cover") tag.classList.add("is-content");
      title.textContent = page.name;
      title.title = page.name;
      promptText.textContent = page.finalPrompt || "";

      // ==================== 提示词编辑 ====================

      /** 切换提示词的展示态 / 编辑态：编辑时隐藏底部操作行，只保留「保存/取消」 */
      function setPromptEditing(editing) {
        promptText.hidden = editing;
        promptEdit.hidden = !editing;
        promptEditActions.hidden = !editing;
        actionsRow.hidden = editing;
        if (editing) {
          promptWrap.open = true;
          promptEdit.value = page.finalPrompt || page.prompt || "";
          promptEdit.focus();
        }
      }

      // 进入编辑态：把当前提示词填入输入框
      editPromptButton.addEventListener("click", function () {
        setPromptEditing(true);
      });
      // 取消编辑：放弃修改，回到展示态
      cancelPromptButton.addEventListener("click", function () {
        setPromptEditing(false);
      });
      // 保存修改：更新页面的最终提示词，之后「重新生成」「复制提示词」都使用新值
      savePromptButton.addEventListener("click", function () {
        var value = promptEdit.value.trim();
        if (!value) {
          promptEdit.focus();
          return;
        }
        page.finalPrompt = value;
        promptText.textContent = value;
        setPromptEditing(false);
      });

      copyButton.addEventListener("click", function () {
        __APP.copyTextToClipboard(page.finalPrompt || page.prompt || "").then(function (ok) {
          copyButton.textContent = ok ? "已复制" : "复制失败";
          setTimeout(function () { copyButton.textContent = "复制提示词"; }, 1500);
        });
      });

      regenButton.addEventListener("click", function () {
        regeneratePage(index);
      });
      regenButton.disabled = state.generating;

      downloadButton.addEventListener("click", function () {
        downloadPageImage(index, downloadButton);
      });
      downloadButton.disabled = page.status !== "done";

      elements.pagesGrid.appendChild(node);
      cardRefs.push({ img: img, placeholder: placeholder, statusText: statusText, spinner: spinner, downloadButton: downloadButton });
    });
  }

  /** 更新某页卡片状态文字 */
  function setCardStatus(index, statusKind, text) {
    var refs = cardRefs[index];
    var page = state.pages[index];
    if (page) page.status = statusKind;
    if (!refs) return;
    refs.statusText.textContent = text;
    var busy = statusKind === "generating";
    refs.spinner.hidden = !busy;
    refs.placeholder.classList.toggle("is-error", statusKind === "failed");
    refs.img.hidden = statusKind !== "done";
    // 转回非完成态时移除旧动画类，保证下次完成时「模糊→清晰」动画能重新触发
    if (statusKind !== "done") {
      refs.img.classList.remove("gen-blur-reveal-img");
    }
    refs.placeholder.style.display = statusKind === "done" ? "none" : "flex";
    if (refs.downloadButton) {
      refs.downloadButton.disabled = statusKind !== "done" || state.generating;
    }
  }

  /** 设置某页卡片图片（由占位切换为真图时播放「模糊→清晰」淡入） */
  function setCardImage(index, url) {
    var refs = cardRefs[index];
    if (!refs) return;
    var wasHidden = refs.img.hidden;
    refs.img.src = url;
    refs.img.hidden = false;
    if (wasHidden) {
      refs.img.classList.add("gen-blur-reveal-img");
    }
    refs.placeholder.style.display = "none";
    if (refs.downloadButton) refs.downloadButton.disabled = false;
  }

  // ==================== 生成主流程 ====================

  /** 校验输入与配置，通过则返回通道对象，否则返回错误信息 */
  function validateBeforeStart() {
    var topic = elements.topic.value.trim();
    if (!topic) return { error: "请先输入笔记主题。" };
    var modelValue = elements.imageModel.value;
    var resolved = __APP.resolveImageChannel(modelValue);
    if (!resolved) return { error: "当前生图模型不可用，请先到设置页启用并配置生图通道。" };
    try {
      getLlmConfig();
    } catch (error) {
      return { error: error.message };
    }
    return { channel: resolved.channel, topic: topic };
  }

  /** 开始生成整篇笔记 */
  async function startGenerate() {
    if (state.generating) return;
    var check = validateBeforeStart();
    if (check.error) {
      showStatus(check.error, true);
      return;
    }

    state.generating = true;
    state.paused = false;        // 全新一轮开始，清除断点状态
    clearCheckpoint();
    state.abortController = new AbortController();
    var signal = state.abortController.signal;
    var channel = check.channel;
    syncControls();
    clearResults();
    elements.steps.hidden = false;

    try {
      // 第一步：策划大纲
      setStep(1);
      showRunStatus("");
      var outline = await requestOutline(check.topic, signal, state.pageCount);
      state.outline = outline;
      state.pages = buildPages(outline);
      renderOutline(outline);

      // 第二步：生成每页提示词
      setStep(2);
      showRunStatus("正在为每一页撰写绘图提示词...");
      await assignPrompts(state.pages, outline, signal);
      renderPages(state.pages);
      var countText = state.pages.length === 1
        ? "共 1 张图（仅封面）"
        : "共 " + state.pages.length + " 张图（1 张封面 + " + (state.pages.length - 1) + " 张内容页）";
      showRunStatus(countText + "，开始逐张出图...");

      // 第三步：逐张出图
      setStep(3);
      await generateAllPages(channel, signal);
      finishRunCleanup();
    } catch (error) {
      if (error && error.name === "AbortError") {
        // 暂停：保存断点，按钮变为「继续生成」，已完成的页面不会重复生成
        state.paused = true;
        persistCheckpoint();
        showStatus("已暂停并保存断点。点击「继续生成」从断点接着生成，已完成的图片不会重复生成。", false);
      } else {
        console.error("[xhs] 生成失败", error);
        showStatus("生成失败：" + (error && error.message ? error.message : "未知错误"), true);
      }
    } finally {
      state.generating = false;
      state.abortController = null;
      syncControls();
    }
  }

  // ==================== 限流自动重试 ====================

  /** 可自动重试的暂时性错误特征（并发超限 / 限流 / 429 类） */
  var RETRYABLE_ERROR_PATTERN = /concurrency|并发|rate\s*limit|too\s*many\s*requests|\b429\b|频率|超限|quota/i;

  /** 判断错误信息是否属于并发/限流类可重试错误 */
  function isRetryableError(message) {
    return RETRYABLE_ERROR_PATTERN.test(String(message || ""));
  }

  /** 可被中断信号打断的延时 */
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        var err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      }
      if (signal) signal.addEventListener("abort", onAbort);
    });
  }

  /**
   * 带自动重试的生图调用：并发/限流类错误按 10s/20s/30s 退避重试，最多 3 次
   * 等待期间在卡片和状态栏同步显示倒计时，让用户明确知道正在发生什么
   * @param {string} label 反馈文案里对该次生成的称呼（如「第 2/5 张：造纸术」）
   */
  async function generateImageWithRetry(channel, prompt, signal, onProgress, label) {
    var maxRetries = 3;
    var attempt = 0;
    while (true) {
      try {
        return await generateImage(channel, prompt, signal, onProgress);
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        var message = error && error.message ? error.message : "未知错误";
        if (!isRetryableError(message) || attempt >= maxRetries) throw error;
        attempt++;
        var waitSeconds = attempt * 10;
        // 倒计时反馈：卡片 + 状态栏同步
        var deadline = Date.now() + waitSeconds * 1000;
        while (Date.now() < deadline) {
          var left = Math.ceil((deadline - Date.now()) / 1000);
          var msg = "并发超限，" + left + " 秒后自动重试（第 " + attempt + "/" + maxRetries + " 次）...";
          onProgress(msg);
          showStatus(label + "：" + msg, false);
          await sleep(1000, signal);
        }
        onProgress("自动重试中（第 " + attempt + "/" + maxRetries + " 次）...");
        showStatus(label + "：自动重试中（第 " + attempt + "/" + maxRetries + " 次）...", false);
      }
    }
  }

  /** 按顺序生成所有页面的图片（每张成功后自动落盘到本地图片库） */
  async function generateAllPages(channel, signal) {
    var pages = state.pages;
    var doneCount = 0;
    var saveFailCount = 0;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].status === "done") { doneCount++; continue; }
      var label = "第 " + (i + 1) + "/" + pages.length + " 张（" + pages[i].name + "）";
      try {
        setCardStatus(i, "generating", "生成中（第 " + (i + 1) + "/" + pages.length + " 张）...");
        showRunStatus("第 " + (i + 1) + "/" + pages.length + " 张：" + pages[i].name);
        var urls = await generateImageWithRetry(channel, pages[i].finalPrompt, signal, function (msg) {
          setCardStatus(i, "generating", msg);
        }, label);
        pages[i].imageUrls = urls;
        pages[i].status = "done";
        setCardImage(i, urls[0]);
        doneCount++;
        // 生成成功后立即自动落盘到本地图片库（失败不影响图片本身，仅记录日志）
        showRunStatus("正在自动保存到图片库...");
        var saved = await savePageToGallery(pages[i], i, channel);
        if (!saved) saveFailCount++;
        showDoneStatus("第 " + (i + 1) + "/" + pages.length + " 张完成" + (saved ? "（已自动保存到图片库）" : "（自动保存失败，可手动下载）"));
        // 温馨小提示：每张生成成功后底部轻提示
        if (typeof __APP.showToast === "function") {
          __APP.showToast("✨ " + label + " 已生成");
        }
        // 张与张之间留 2 秒间隔，降低触发并发限制的概率
        if (i < pages.length - 1 && pages.slice(i + 1).some(function (p) { return p.status !== "done"; })) {
          showRunStatus("休息 2 秒，即将继续下一张...");
          await sleep(2000, signal);
        }
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        console.error("[xhs] 第 " + (i + 1) + " 张生成失败", error);
        pages[i].status = "failed";
        pages[i].error = error && error.message ? error.message : "未知错误";
        setCardStatus(i, "failed", "生成失败：" + pages[i].error);
      }
    }

    var failedCount = pages.length - doneCount;
    var summary = "生成结束：成功 " + doneCount + " 张";
    if (failedCount > 0) {
      summary += "，失败 " + failedCount + " 张（可点击卡片上的「重新生成」单独重试）";
    }
    if (saveFailCount > 0) {
      summary += "，" + saveFailCount + " 张自动保存失败（可手动下载）";
    } else {
      summary += "，已全部自动保存到本地图片库";
    }
    showStatus(summary + "。", false);
  }

  /** 单独重新生成某一页 */
  async function regeneratePage(index) {
    if (state.generating) return;
    var page = state.pages[index];
    if (!page) return;
    var check = validateBeforeStart();
    if (check.error) {
      showStatus(check.error, true);
      return;
    }

    state.generating = true;
    state.abortController = new AbortController();
    var signal = state.abortController.signal;
    syncControls();
    setStep(3);

    try {
      setCardStatus(index, "generating", "重新生成中...");
      var urls = await generateImageWithRetry(check.channel, page.finalPrompt, signal, function (msg) {
        setCardStatus(index, "generating", msg);
      }, "重新生成「" + page.name + "」");
      page.imageUrls = urls;
      page.status = "done";
      setCardImage(index, urls[0]);
      // 重新生成成功后同样自动落盘到本地图片库
      var saved = await savePageToGallery(page, index, check.channel);
      showDoneStatus("" + (saved ? "，已自动保存到图片库。" : "，自动保存失败（可手动下载）。"), false);
      // 温馨小提示：重新生成成功后底部轻提示
      if (typeof __APP.showToast === "function") {
        __APP.showToast("✨ 「" + page.name + "」已重新生成");
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        setCardStatus(index, "failed", "已停止");
        showStatus("已停止生成。", false);
      } else {
        console.error("[xhs] 重新生成失败", error);
        setCardStatus(index, "failed", "生成失败：" + (error && error.message ? error.message : "未知错误"));
        showStatus("重新生成失败：" + (error && error.message ? error.message : "未知错误"), true);
      }
    } finally {
      state.generating = false;
      state.abortController = null;
      syncControls();
    }
  }

  // ==================== 保存与下载 ====================

  /**
   * 单页生成成功后自动保存到本地图片库（复用服务端保存接口，图片落盘到 generated-images/ 目录）
   * @param {Object} page 页面对象（需已生成 imageUrls）
   * @param {number} index 页面序号
   * @param {Object} channel 当前使用的生图通道（用于记录模型名）
   * @returns {boolean} 是否保存成功（失败只记录日志，不中断生成流程）
   */
  async function savePageToGallery(page, index, channel) {
    try {
      // 记录当前实际使用的质量与风格信息
      var qualityValue = elements.imageQuality && elements.imageQuality.value ? elements.imageQuality.value : "2K";
      var qualityMeta = (__APP.IMAGE_QUALITIES || []).find(function (q) { return q.value === qualityValue; });
      var styleForRecord = findStyle(state.styleId);
      // 文件名主题：大标题（笔记主题）- 页名（封面即标题本身，内容页为「标题-页名」）
      var recordTopic = getPageTopic(page);
      var response = await fetch(__APP.API_ENDPOINTS.save, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record: {
            id: "xhs-" + Date.now() + "-" + index,
            prompt: page.finalPrompt || page.prompt || "",
            rawPrompt: page.prompt || "",
            topic: recordTopic,
            images: page.imageUrls,
            aspectRatio: __APP.XHS_ASPECT_RATIO,
            imageQuality: qualityValue,
            imageQualityLabel: qualityMeta ? qualityMeta.label : qualityValue,
            styleTemplateId: state.styleId,
            styleTemplateLabel: "小红书" + (styleForRecord ? " · " + styleForRecord.name : ""),
            model: channel ? channel.model : "",
            mode: "text",
            modeLabel: "小红书图文",
            time: Date.now()
          }
        })
      });
      var data = await response.json();
      if (!data || !data.ok) {
        throw new Error(data && data.error ? data.error : "服务端返回异常");
      }
      return true;
    } catch (error) {
      console.error("[xhs] 自动保存到图片库失败（" + page.name + "）", error);
      return false;
    }
  }

  /**
   * 下载单页图片
   * data URL 直接下载；远程 URL 尝试 fetch 为 blob，失败时新窗口打开
   */
  /**
   * 构造页面主题（用于文件命名与保存记录）：封面 = 笔记标题，内容页 = 「标题-页名」
   * @param {Object} page 页面对象
   * @returns {string} 主题文本，无大纲信息时退化为页名，可能为空串
   */
  function getPageTopic(page) {
    var noteTitle = state.outline && state.outline.title ? String(state.outline.title) : "";
    if (page.kind === "cover") return noteTitle;
    return noteTitle ? noteTitle + "-" + page.name : page.name;
  }

  async function downloadPageImage(index, button) {
    var page = state.pages[index];
    var url = page && page.imageUrls && page.imageUrls[0];
    if (!url) return;
    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = "下载中...";
    try {
      // 下载文件名与保存到图片库的命名规则保持一致：主题 + 时间戳
      // 清洗文件系统非法字符，避免不同操作系统下载失败
      var topic = getPageTopic(page).replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      var timestamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+$/, "").slice(0, 14);
      var filename = (topic ? topic + "-" : "xhs-") + timestamp + ".png";
      if (url.indexOf("data:") === 0) {
        triggerDownload(url, filename);
      } else {
        // 远程图片：先取 blob 再下载，跨域受限时退化为新窗口打开
        var blob = await fetch(url).then(function (res) { return res.blob(); });
        var objectUrl = URL.createObjectURL(blob);
        triggerDownload(objectUrl, filename);
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 2000);
      }
    } catch (error) {
      console.error("[xhs] 下载失败", error);
      window.open(url, "_blank", "noopener");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  /** 触发浏览器下载 */
  function triggerDownload(href, filename) {
    var link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ==================== 卡片折叠/展开 ====================

  /**
   * 初始化卡片折叠开关：点击标题条任意位置即可展开/收起，右侧的展开/收起按钮同样可用。
   * 标题条内的其他功能按钮（如「清空」）不受影响，点击它们不会触发折叠。
   * @param {string} toggleId 折叠按钮元素 ID
   * @param {string} bodyId 折叠内容区元素 ID
   */
  function initCollapseToggle(toggleId, bodyId) {
    var toggle = $(toggleId);
    var body = $(bodyId);
    if (!toggle || !body) return;
    // 标题条 = 按钮所在的头部容器（包含标题文字 + 右侧按钮组）
    var head = toggle.closest(".xhs-panel-head") || toggle.parentElement;

    function applyToggle() {
      var willExpand = body.hidden;
      body.hidden = !willExpand;
      toggle.textContent = willExpand ? "收起 ▴" : "展开 ▾";
      toggle.setAttribute("aria-expanded", willExpand ? "true" : "false");
    }

    // 整个标题条都可点击：命中其他按钮（清空等）时保持其原功能，不触发折叠
    head.addEventListener("click", function (event) {
      var clickedButton = event.target.closest("button");
      if (clickedButton && clickedButton !== toggle) return;
      applyToggle();
    });
  }

  // ==================== 事件绑定与启动 ====================

  function bindEvents() {
    elements.start.addEventListener("click", startGenerate);
    elements.stop.addEventListener("click", function () {
      // 生成中 → 暂停；有断点 → 继续生成
      if (state.generating) {
        if (state.abortController) {
          state.abortController.abort();
        }
      } else if (state.paused) {
        resumeGenerate();
      }
    });
    elements.topic.addEventListener("input", persistDraft);
    elements.topic.addEventListener("input", syncTopicClearVisibility);
    // 快捷键：Ctrl+Enter / Cmd+Enter 快速开始生成（生成中不重复触发）
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !state.generating) {
        event.preventDefault();
        startGenerate();
      }
    });
    // 风格搜索：输入关键词即时过滤卡片
    elements.styleSearch.addEventListener("input", function () {
      state.styleFilter = elements.styleSearch.value;
      renderStyleCards();
    });
    // 「清空」按钮：清空主题输入框，并同步清掉草稿里的主题，刷新后不残留
    elements.topicClear.addEventListener("click", function () {
      elements.topic.value = "";
      persistDraft();
      syncTopicClearVisibility();
      elements.topic.focus();
    });
    elements.imageModel.addEventListener("change", persistDraft);
    // 两个卡片的展开/收起开关
    initCollapseToggle("xhs-config-toggle", "xhs-config-body");
    initCollapseToggle("xhs-composer-toggle", "xhs-composer-body");
  }

  /** 页面入口 */
  function init() {
    elements = {
      styleCards: $("xhs-style-cards"),
      styleSearch: $("xhs-style-search"),
      styleExport: $("xhs-style-export"),
      styleImport: $("xhs-style-import"),
      styleImportFile: $("xhs-style-import-file"),
      styleEmpty: $("xhs-style-empty"),
      styleNew: $("xhs-style-new"),
      styleForm: $("xhs-style-form"),
      styleName: $("xhs-style-name"),
      stylePrompt: $("xhs-style-prompt"),
      styleSave: $("xhs-style-save"),
      styleCancel: $("xhs-style-cancel"),
      imageModel: $("xhs-image-model"),
      imageQuality: $("xhs-image-quality"),
      topic: $("xhs-topic"),
      topicClear: $("xhs-topic-clear"),
      sampleChips: $("xhs-sample-chips"),
      start: $("xhs-start"),
      stop: $("xhs-stop"),
      steps: $("xhs-steps"),
      status: $("xhs-status"),
      outline: $("xhs-outline"),
      outlineTitle: $("xhs-outline-title"),
      outlineSub: $("xhs-outline-sub"),
      outlineHighlights: $("xhs-outline-highlights"),
      pagesGrid: $("xhs-pages-grid"),
      cardTemplate: $("xhs-page-card-template"),
      pageCount: $("xhs-page-count"),
      pageCountCustom: $("xhs-page-count-custom"),
      countNote: $("xhs-count-note"),
      llmInfo: $("xhs-llm-info")
    };

    // 加载自定义风格库（首次使用会写入种子风格），并绑定风格表单
    loadStyles();
    bindStyleForm();
    renderStyleCards();
    renderSampleChips();
    initImageModelSelect();
    initImageQualitySelect();
    initPageCountSelect();
    renderLlmInfo();
    restoreDraft();
    // 草稿恢复后按当前内容同步「清空」按钮显隐
    syncTopicClearVisibility();
    // 未选择风格时默认选中第一条自定义风格
    if (!state.styleId && state.styles.length > 0) {
      state.styleId = state.styles[0].id;
    }
    // 恢复草稿后需要按草稿值重新高亮风格卡片
    renderStyleCards();
    // 恢复上次未完成的生成断点（若有），按钮会显示「继续生成」
    restoreCheckpoint();
    bindEvents();
    console.log("[xhs] 小红书图文笔记板块初始化完成");
  }

  // DOM 就绪后初始化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
