(function () {
  const QUEUE_DELAY_MS = 3000; // 排队任务间隔时间（毫秒），防止频繁请求报错

  const state = {
    history: loadHistory(),
    generating: false,
    optimizing: false,
    abortController: null,
    mode: "text",
    taskMode: window.localStorage.getItem(__APP.STORAGE_KEYS.taskMode) || "single",
    batchQueue: [],
    currentAccount: null,
    generationQueue: [],   // 生图排队队列：每个元素为 { id, prompt, runConfig }
    queueProcessing: false  // 是否正在处理排队队列
  };

  const elements = {
    controlDeck: document.getElementById("control-deck"),
    controlStack: document.getElementById("control-stack"),
    toggleControlDeck: document.getElementById("toggle-control-deck"),
    modelChannelNote: document.getElementById("model-channel-note"),
    previewPanel: document.getElementById("preview-panel"),
    chatWorkspace: document.getElementById("chat-workspace"),
    messageViewport: document.getElementById("message-viewport"),
    resizeHandle: document.getElementById("resize-handle"),
    verticalResizeHandle: document.getElementById("vertical-resize-handle"),
    togglePreviewPanel: document.getElementById("toggle-preview-panel"),
    apiKeyField: document.getElementById("api-key-field"),
    apiKey: document.getElementById("api-key"),
    gptApiKeyField: document.getElementById("gpt-api-key-field"),
    gptApiKey: document.getElementById("gpt-api-key"),
    customApiKeyField: document.getElementById("custom-api-key-field"),
    customApiKey: document.getElementById("custom-api-key"),
    agnesApiKeyField: document.getElementById("agnes-api-key-field"),
    agnesApiKey: document.getElementById("agnes-api-key"),
    baseUrlField: document.getElementById("base-url-field"),
    baseUrl: document.getElementById("base-url"),
    modelName: document.getElementById("model-name"),
    aspectRatio: document.getElementById("aspect-ratio"),
    imageQuality: document.getElementById("image-quality"),
    styleTemplate: document.getElementById("style-template"),
    imageCount: document.getElementById("image-count"),
    promptInput: document.getElementById("prompt-input"),
    clearPrompt: document.getElementById("clear-prompt"),
    optimizePromptButton: document.getElementById("optimize-prompt"),
    clearHistory: document.getElementById("clear-history"),
    clearChat: document.getElementById("clear-chat"),
    historyList: document.getElementById("history-list"),
    messageList: document.getElementById("message-list"),
    composer: document.getElementById("composer"),
    taskModeButtons: Array.from(document.querySelectorAll("[data-task-mode]")),
    singlePromptPanel: document.getElementById("single-prompt-panel"),
    batchPanel: document.getElementById("batch-panel"),
    batchPromptInput: document.getElementById("batch-prompt-input"),
    clearBatchPrompts: document.getElementById("clear-batch-prompts"),
    batchQueueSummary: document.getElementById("batch-queue-summary"),
    batchQueueList: document.getElementById("batch-queue-list"),
    templateBody: document.getElementById("template-body"),
    templateValues: document.getElementById("template-values"),
    templateSummary: document.getElementById("template-summary"),
    applyTemplate: document.getElementById("apply-template"),
    composerHelperText: document.getElementById("composer-helper-text"),
    messageTemplate: document.getElementById("message-template"),
    modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
    taskModeField: document.getElementById("task-mode-field"),
    taskModeHint: document.getElementById("task-mode-hint"),
    taskModeHintIcon: document.getElementById("task-mode-hint-icon"),
    taskModeHintText: document.getElementById("task-mode-hint-text"),
    generationOptionsGrid: document.getElementById("generation-options-grid"),
    randomGenerateButton: document.getElementById("random-generate-button"),
    generateButton: document.getElementById("generate-button"),
    stopGenerateButton: document.getElementById("stop-generate-button"),
    // 账号系统
    accountUserBtn: document.getElementById("account-user-btn"),
    accountAvatar: document.getElementById("account-avatar"),
    accountNickname: document.getElementById("account-nickname"),
    accountModalOverlay: document.getElementById("account-modal-overlay"),
    accountModalClose: document.getElementById("account-modal-close"),
    loginPanel: document.getElementById("account-login-panel"),
    registerPanel: document.getElementById("account-register-panel"),
    profilePanel: document.getElementById("account-profile-panel"),
    loginEmail: document.getElementById("login-email"),
    loginPassword: document.getElementById("login-password"),
    loginError: document.getElementById("login-error"),
    loginSubmit: document.getElementById("login-submit-btn"),
    registerNickname: document.getElementById("register-nickname"),
    registerEmail: document.getElementById("register-email"),
    registerPassword: document.getElementById("register-password"),
    registerError: document.getElementById("register-error"),
    registerSubmit: document.getElementById("register-submit-btn"),
    switchToRegister: document.getElementById("switch-to-register"),
    switchToLogin: document.getElementById("switch-to-login"),
    profileNickname: document.getElementById("profile-nickname"),
    profilePassword: document.getElementById("profile-password"),
    profileError: document.getElementById("profile-error"),
    profileSave: document.getElementById("profile-save-btn"),
    profileAvatar: document.getElementById("account-profile-avatar"),
    profileNicknameDisp: document.getElementById("account-profile-nickname"),
    profileEmailDisp: document.getElementById("account-profile-email"),
    logoutBtn: document.getElementById("account-logout-btn"),
    lightbox: document.getElementById("preview-lightbox"),
    lightboxImage: document.getElementById("lightbox-image"),
    lightboxCaption: document.getElementById("lightbox-caption"),
    lightboxClose: document.getElementById("lightbox-close-btn"),
  };

  function createIntroMessage(text) {
    return {
      id: __APP.createId(),
      role: "assistant",
      text,
      images: [],
      prompt: "",
      rawPrompt: "",
      aspectRatio: "",
      styleTemplateId: "none",
      styleTemplateLabel: "",
      model: "",
      mode: state.mode,
      modeLabel: __APP.MODE_META[state.mode].label,
      time: Date.now()
    };
  }

  function loadHistory() {
    try {
      const raw = window.localStorage.getItem(__APP.STORAGE_KEYS.history);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function loadLegacyGallery() {
    try {
      const raw = window.localStorage.getItem(__APP.STORAGE_KEYS.legacyGallery);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveLegacyGallery(records) {
    const snapshot = Array.isArray(records) ? records.slice(-__APP.MAX_LEGACY_GALLERY) : [];
    window.localStorage.setItem(__APP.STORAGE_KEYS.legacyGallery, JSON.stringify(snapshot));
  }

  function appendLegacyGalleryRecord(record) {
    saveLegacyGallery(loadLegacyGallery().concat(record));
  }

  function trimHistorySnapshot(snapshot) {
    const firstImageIndex = snapshot.findIndex((item) => Array.isArray(item.images) && item.images.length > 0);

    if (firstImageIndex === -1) {
      return snapshot.slice(1);
    }

    return snapshot.map((item, index) => {
      if (index !== firstImageIndex) {
        return item;
      }
      return {
        id: item.id,
        role: item.role,
        text: `${item.text || "图片已生成。"}\n\n[旧图片缓存已移除，避免超过浏览器本地存储限制。]`,
        images: [],
        prompt: item.prompt,
        rawPrompt: item.rawPrompt,
        aspectRatio: item.aspectRatio,
        imageQuality: item.imageQuality,
        imageQualityLabel: item.imageQualityLabel,
        styleTemplateId: item.styleTemplateId,
        styleTemplateLabel: item.styleTemplateLabel,
        mode: item.mode,
        modeLabel: item.modeLabel,
        time: item.time,
        model: item.model
      };
    });
  }

  function saveHistory() {
    let snapshot = state.history.slice(-__APP.MAX_HISTORY);
    while (snapshot.length > 0) {
      try {
        window.localStorage.setItem(__APP.STORAGE_KEYS.history, JSON.stringify(snapshot));
        state.history = snapshot;
        return;
      } catch (error) {
        snapshot = trimHistorySnapshot(snapshot);
      }
    }
    window.localStorage.removeItem(__APP.STORAGE_KEYS.history);
  }

  function setStatus() {
  }

  function openPreviewLightbox(src, caption) {
    if (!elements.lightbox || !elements.lightboxImage) {
      return;
    }
    elements.lightboxImage.src = src;
    elements.lightboxImage.alt = caption || "放大预览图片";
    if (elements.lightboxCaption) {
      elements.lightboxCaption.textContent = caption || "";
    }
    elements.lightbox.hidden = false;
    document.body.classList.add("lightbox-open");
    if (elements.lightboxClose) {
      elements.lightboxClose.focus();
    }
  }

  function closePreviewLightbox() {
    if (!elements.lightbox || elements.lightbox.hidden) {
      return;
    }
    elements.lightbox.hidden = true;
    document.body.classList.remove("lightbox-open");
    if (elements.lightboxCaption) {
      elements.lightboxCaption.textContent = "";
    }
  }

  function setPreviewPanelCollapsed(collapsed) {
    if (!elements.previewPanel || !elements.chatWorkspace || !elements.togglePreviewPanel) {
      return;
    }
    elements.previewPanel.classList.toggle("is-collapsed", collapsed);
    elements.chatWorkspace.hidden = collapsed;
    elements.togglePreviewPanel.textContent = collapsed ? "展开" : "收起";
    elements.togglePreviewPanel.setAttribute("aria-expanded", collapsed ? "false" : "true");
    window.localStorage.setItem(__APP.STORAGE_KEYS.previewPanelCollapsed, collapsed ? "true" : "false");
  }

  function initPreviewPanelCollapse() {
    const collapsed = window.localStorage.getItem(__APP.STORAGE_KEYS.previewPanelCollapsed) === "true";
    setPreviewPanelCollapsed(collapsed);
  }

  /**
   * 初始化对话面板上下拖拽调整高度功能
   * 拖拽时改变整个 chat-panel 的高度，下方输入区会跟随上下移动
   */
  function initResizeHandle() {
    if (!elements.resizeHandle || !elements.previewPanel) {
      return;
    }

    // 恢复用户上次调整的高度
    const savedHeight = window.localStorage.getItem(__APP.STORAGE_KEYS.chatPanelHeight);
    if (savedHeight) {
      const height = parseInt(savedHeight, 10);
      if (!isNaN(height) && height > 0) {
        elements.previewPanel.style.setProperty("--chat-panel-height", height + "px");
      }
    }

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    elements.resizeHandle.addEventListener("mousedown", function (event) {
      if (event.button !== 0) {
        return;
      }
      isDragging = true;
      startY = event.clientY;
      startHeight = elements.previewPanel.offsetHeight;
      elements.resizeHandle.classList.add("is-dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      event.preventDefault();
      console.log("[resize] 开始调整对话面板高度");
    });

    document.addEventListener("mousemove", function (event) {
      if (!isDragging) {
        return;
      }
      const delta = event.clientY - startY;
      const minHeight = 360;
      let newHeight = startHeight + delta;
      newHeight = Math.max(minHeight, newHeight);
      elements.previewPanel.style.setProperty("--chat-panel-height", newHeight + "px");
    });

    document.addEventListener("mouseup", function () {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      elements.resizeHandle.classList.remove("is-dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const finalHeight = elements.previewPanel.offsetHeight;
      window.localStorage.setItem(__APP.STORAGE_KEYS.chatPanelHeight, String(finalHeight));
      console.log("[resize] 对话面板高度已保存为", finalHeight);
    });
  }

  /**
   * 初始化侧边栏左右拖拽调整宽度功能
   * 拖拽时改变左侧 sidebar 与右侧 workspace 的宽度比例
   */
  function initVerticalResizeHandle() {
    if (!elements.verticalResizeHandle) {
      return;
    }

    const shell = document.querySelector(".shell");
    const sidebar = document.querySelector(".sidebar");
    if (!shell || !sidebar) {
      return;
    }

    // 恢复用户上次调整的宽度
    const savedWidth = window.localStorage.getItem(__APP.STORAGE_KEYS.sidebarWidth);
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (!isNaN(width) && width > 0) {
        shell.style.setProperty("--sidebar-width", width + "px");
      }
    }

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    elements.verticalResizeHandle.addEventListener("mousedown", function (event) {
      if (event.button !== 0) {
        return;
      }
      isDragging = true;
      startX = event.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      elements.verticalResizeHandle.classList.add("is-dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      event.preventDefault();
      console.log("[resize] 开始调整侧边栏宽度");
    });

    document.addEventListener("mousemove", function (event) {
      if (!isDragging) {
        return;
      }
      const delta = event.clientX - startX;
      const shellWidth = shell.getBoundingClientRect().width;
      const minWidth = 320;
      const maxWidth = Math.max(minWidth, shellWidth - 480);
      let newWidth = startWidth + delta;
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      shell.style.setProperty("--sidebar-width", newWidth + "px");
    });

    document.addEventListener("mouseup", function () {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      elements.verticalResizeHandle.classList.remove("is-dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const finalWidth = parseInt(window.getComputedStyle(shell).getPropertyValue("--sidebar-width"), 10);
      if (!isNaN(finalWidth) && finalWidth > 0) {
        window.localStorage.setItem(__APP.STORAGE_KEYS.sidebarWidth, String(finalWidth));
        console.log("[resize] 侧边栏宽度已保存为", finalWidth);
      }
    });
  }

  function resetConversation(statusMetaText) {
    state.history = [createIntroMessage("历史记录已清空。你可以继续发新的提示词开始下一轮创作。")];
    saveHistory();
    renderMessages();
    renderHistorySummary();
    setStatus("待命", statusMetaText);
  }

  function getAspectLabel(value) {
    var match = __APP.ASPECT_RATIOS.find(function (item) { return item.value === value; });
    return match ? match.label : value;
  }

  function getImageQualityMeta(value) {
    return __APP.IMAGE_QUALITIES.find(function (item) { return item.value === value; }) || __APP.IMAGE_QUALITIES[1];
  }

  function normalizeMode(value) {
    return "text";
  }

  function renderSelectOptions() {
    var modelOptions = __APP.getModelOptions();
    if (modelOptions.length === 0) {
      elements.modelName.innerHTML = '<option value="">-- 没有可用模型 --</option>';
    } else {
      elements.modelName.innerHTML = modelOptions.map(function (item) { return '<option value="' + item.value + '">' + item.label + '</option>'; }).join("");
    }
    elements.aspectRatio.innerHTML = __APP.ASPECT_RATIOS.map(function (item) { return '<option value="' + item.value + '">' + item.label + '</option>'; }).join("");
    elements.imageQuality.innerHTML = __APP.IMAGE_QUALITIES.map(function (item) { return '<option value="' + item.value + '">' + item.label + '</option>'; }).join("");
    elements.styleTemplate.innerHTML = __APP.STYLE_TEMPLATES.map(function (item) { return '<option value="' + item.id + '">' + item.label + '</option>'; }).join("");
  }

  /**
   * 校验指定模型是否仍在可用选项中，不在则回退到第一个可用选项
   * 用于设置页返回或通道配置变更后，避免当前模型对应通道已失效导致请求发错
   * @param {string} [preferredModel] 优先校验的模型 value（避免读取被 renderSelectOptions 重置后的 select 值）
   * @returns {string} 校验后的模型 value
   */
  function normalizeCurrentModel(preferredModel) {
    var options = __APP.getModelOptions();
    var currentModel = preferredModel || elements.modelName.value || __APP.DEFAULT_MODEL;
    var exists = options.some(function (item) { return item.value === currentModel; });
    if (exists) {
      return currentModel;
    }
    if (options.length > 0) {
      return options[0].value;
    }
    // 没有任何可用模型时返回空字符串，配合空状态提示引导用户去设置页
    return "";
  }

  function renderModeButtons() {
    elements.modeButtons.forEach(function (button) {
      button.classList.toggle("is-active", button.dataset.mode === state.mode);
    });
  }

  function normalizeTaskMode(value) {
    return value === "batch" ? "batch" : "single";
  }

  function getGenerateButtonLabel() {
    if (state.taskMode === "batch") {
      return "开始批量";
    }
    return "开始创作";
  }

  function getTaskModeHintCopy() {
    if (state.taskMode === "batch") {
      return {
        icon: "✨",
        mode: "batch",
        html: "<b>批量模式已开启</b>：在下方输入多段提示词，用 <b>空行</b> 分隔，逐张顺序生成（每次间隔 1-2 秒）"
      };
    }
    return {
      icon: "💡",
      mode: "single",
      html: "想一次生成多张图？点上方切换到 <b>批量</b> 模式，用 <b>空行</b> 分隔多段提示词"
    };
  }

  function syncTaskModeHint() {
    if (!elements.taskModeHint) {
      return;
    }
    var copy = getTaskModeHintCopy();
    elements.taskModeHint.setAttribute("data-mode-hint", copy.mode);
    if (elements.taskModeHintIcon) {
      elements.taskModeHintIcon.textContent = copy.icon;
    }
    if (elements.taskModeHintText) {
      elements.taskModeHintText.innerHTML = copy.html;
    }
  }

  function renderTaskModeButtons() {
    elements.taskModeButtons.forEach(function (button) {
      button.classList.toggle("is-active", button.dataset.taskMode === state.taskMode);
    });
  }

  function getBatchQueuePreviewText(prompt) {
    return String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 88) || "未命名提示词";
  }

  function getBatchQueueDisplayText(item) {
    var normalizedPrompt = String(item.prompt || "").replace(/\s+/g, " ").trim();
    if (item.status === "running") {
      return normalizedPrompt || getBatchQueuePreviewText(item.prompt);
    }
    return getBatchQueuePreviewText(item.prompt);
  }

  function scrollBatchQueueItemIntoView(entryId) {
    if (!entryId || !elements.batchQueueList) {
      return;
    }

    window.requestAnimationFrame(function () {
      var rows = Array.from(elements.batchQueueList.querySelectorAll("[data-batch-queue-id]"));
      var target = rows.find(function (row) { return row.dataset.batchQueueId === entryId; });
      if (target) {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  function updateTemplatePreview() {
    if (!elements.templateSummary || !elements.batchPromptInput || !elements.templateValues) {
      return;
    }
    var template = elements.batchPromptInput.value.trim();
    var valuesText = elements.templateValues.value.trim();
    if (!template || !valuesText) {
      elements.templateSummary.textContent = "将生成 0 条";
      return;
    }
    var count = __APP.expandTemplateVars(template, valuesText).length;
    var varCount = (template.match(/\{[^}]+\}/g) || []).length;
    var label = varCount > 0 ? "模板变量" : "逐行";
    elements.templateSummary.textContent = label + " · 将生成 " + count + " 条";
  }

  function renderBatchQueue(focusEntryId) {
    if (!elements.batchQueueList || !elements.batchQueueSummary) {
      return;
    }

    var queueItems = state.batchQueue.length > 0
      ? state.batchQueue
      : __APP.createBatchQueueEntries(__APP.parseBatchPrompts(elements.batchPromptInput.value));

    elements.batchQueueList.innerHTML = "";

    if (queueItems.length === 0) {
      elements.batchQueueSummary.textContent = "未添加提示词";
      var empty = document.createElement("div");
      empty.className = "batch-queue-item is-empty";
      empty.textContent = "每段提示词之间空一行，系统会按顺序逐张生成。";
      elements.batchQueueList.appendChild(empty);
      return;
    }

    var completedCount = queueItems.filter(function (item) { return item.status === "success"; }).length;
    var failedCount = queueItems.filter(function (item) { return item.status === "error"; }).length;
    var runningCount = queueItems.filter(function (item) { return item.status === "running"; }).length;
    var stoppedCount = queueItems.filter(function (item) { return item.status === "stopped"; }).length;
    var pendingCount = queueItems.filter(function (item) { return item.status === "pending"; }).length;
    elements.batchQueueSummary.textContent = queueItems.length + " 条 · " + completedCount + " 完成 · " + failedCount + " 失败 · " + runningCount + " 进行中 · " + pendingCount + " 待处理" + (stoppedCount ? " · " + stoppedCount + " 已停止" : "");

    queueItems.forEach(function (item, index) {
      var row = document.createElement("div");
      row.className = "batch-queue-item is-" + item.status;
      row.dataset.batchQueueId = item.id;

      var indexLabel = document.createElement("span");
      indexLabel.className = "batch-queue-index";
      indexLabel.textContent = String(index + 1).padStart(2, "0");

      var textWrap = document.createElement("div");
      textWrap.className = "batch-queue-copy";

      var text = document.createElement("p");
      text.className = "batch-queue-text";
      text.textContent = getBatchQueueDisplayText(item);

      var note = document.createElement("span");
      note.className = "batch-queue-note";
      note.textContent = item.note || ({
        pending: "等待开始",
        running: "正在生成",
        success: "已完成",
        error: "生成失败",
        stopped: "已停止"
      }[item.status] || "等待开始");

      textWrap.append(text, note);
      row.append(indexLabel, textWrap);
      elements.batchQueueList.appendChild(row);
    });

    scrollBatchQueueItemIntoView(focusEntryId || (queueItems.find(function (item) { return item.status === "running"; }) || {}).id);
  }

  function renderTaskMode() {
    renderTaskModeButtons();
    if (elements.taskModeField) {
      elements.taskModeField.hidden = false;
    }
    if (elements.generationOptionsGrid) {
      elements.generationOptionsGrid.hidden = false;
    }
    if (elements.singlePromptPanel) {
      elements.singlePromptPanel.hidden = state.taskMode !== "single";
    }
    if (elements.batchPanel) {
      elements.batchPanel.hidden = state.taskMode !== "batch";
    }
    if (elements.randomGenerateButton) {
      elements.randomGenerateButton.hidden = state.taskMode !== "single";
    }
    if (elements.generateButton) {
      elements.generateButton.textContent = getGenerateButtonLabel();
    }
    syncTaskModeHint();
    if (elements.stopGenerateButton) {
      elements.stopGenerateButton.textContent = state.taskMode === "batch" ? "停止批量" : "停止生图";
    }
    if (elements.composerHelperText) {
      elements.composerHelperText.innerHTML = state.taskMode === "batch"
        ? "按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 可开始批量生成，提示词之间请留空行分隔。"
        : "按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 可直接生成";
    }
    if (elements.promptInput) {
      elements.promptInput.placeholder = "描述你想要的画面，例如：一只橘猫坐在窗台上，午后阳光，写实摄影风格。";
    }
    syncApiFields();
    renderBatchQueue();
  }

  function renderMetaTags(container, message) {
    container.innerHTML = "";

    if (message.modeLabel) {
      var mode = document.createElement("span");
      mode.className = "meta-pill";
      mode.textContent = message.modeLabel;
      container.appendChild(mode);
    }
    if (message.aspectRatio) {
      var aspect = document.createElement("span");
      aspect.className = "meta-pill";
      aspect.textContent = getAspectLabel(message.aspectRatio);
      container.appendChild(aspect);
    }
    if (message.imageQuality || message.imageQualityLabel) {
      var quality = document.createElement("span");
      quality.className = "meta-pill";
      quality.textContent = message.imageQualityLabel || getImageQualityMeta(message.imageQuality).label;
      container.appendChild(quality);
    }
    if (message.styleTemplateLabel) {
      var style = document.createElement("span");
      style.className = "meta-pill";
      style.textContent = message.styleTemplateLabel;
      container.appendChild(style);
    }
    if (message.imageCount && Number(message.imageCount) > 0) {
      var count = document.createElement("span");
      count.className = "meta-pill";
      count.textContent = Number(message.imageCount) + " 张";
      container.appendChild(count);
    }
    if (message.model) {
      var model = document.createElement("span");
      model.className = "meta-pill";
      model.textContent = __APP.getModelMeta(message.model).label;
      container.appendChild(model);
    }
  }

  function renderMessages() {
    elements.messageList.innerHTML = "";

    state.history.forEach(function (message) {
      var fragment = elements.messageTemplate.content.cloneNode(true);
      var item = fragment.querySelector(".message-item");
      var role = fragment.querySelector(".message-role");
      var time = fragment.querySelector(".message-time");
      var tags = fragment.querySelector(".message-tags");
      var text = fragment.querySelector(".message-text");
      var gallery = fragment.querySelector(".image-gallery");
      var actions = fragment.querySelector(".message-actions");

      item.classList.add(message.role);
      role.textContent = message.role === "user" ? getUserDisplayName() : "AI 助手";
      time.dateTime = new Date(message.time).toISOString();
      time.textContent = new Date(message.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      renderMetaTags(tags, message);
      if (!tags.children.length) {
        tags.remove();
      }
      text.textContent = message.text || (message.role === "assistant" ? "图片已生成。" : "");

      if (Array.isArray(message.images) && message.images.length > 0) {
        message.images.forEach(function (src, index) {
          var wrapper = document.createElement("div");
          wrapper.className = "image-wrapper";

          var image = document.createElement("img");
          image.src = src;
          image.alt = (message.rawPrompt || message.prompt || "生成图片") + " " + (index + 1);
          image.addEventListener("click", function () {
            openPreviewLightbox(src, image.alt);
          });

          wrapper.append(image);

          gallery.appendChild(wrapper);
        });
        // 多图时使用网格布局并排展示
        if (message.images.length >= 2) {
          gallery.classList.add("image-gallery--grid");
        }
      } else {
        gallery.remove();
      }

      if (message.role === "assistant" && message.rawPrompt) {
        var reuse = document.createElement("button");
        reuse.type = "button";
        reuse.textContent = "复用提示词";
        reuse.addEventListener("click", function () {
          elements.promptInput.value = message.rawPrompt;
          persistDraft();
          if (message.aspectRatio) {
            elements.aspectRatio.value = message.aspectRatio;
            persistAspectRatio();
          }
          if (message.styleTemplateId) {
            elements.styleTemplate.value = message.styleTemplateId;
            persistStyleTemplate();
          }
          if (message.model) {
            elements.modelName.value = __APP.normalizeModelValue(message.model);
            persistModel();
          }
          if (message.mode) {
            setMode("text");
          }
          elements.promptInput.focus();
        });
        actions.appendChild(reuse);

        var copyPromptBtn = document.createElement("button");
        copyPromptBtn.type = "button";
        copyPromptBtn.className = "ghost-button small-button";
        copyPromptBtn.textContent = "复制提示词";
        copyPromptBtn.addEventListener("click", function () {
          __APP.copyTextToClipboard(message.rawPrompt)
            .then(function (ok) {
              copyPromptBtn.textContent = ok ? "已复制 ✓" : "复制失败";
              copyPromptBtn.classList.toggle("is-success", ok);
              copyPromptBtn.classList.toggle("is-error", !ok);
              window.setTimeout(function () {
                copyPromptBtn.textContent = "复制提示词";
                copyPromptBtn.classList.remove("is-success", "is-error");
              }, 2000);
            });
        });
        actions.appendChild(copyPromptBtn);

        var favoritePromptBtn = document.createElement("button");
        favoritePromptBtn.type = "button";
        favoritePromptBtn.className = "ghost-button small-button";
        favoritePromptBtn.textContent = "收藏提示词";
        favoritePromptBtn.addEventListener("click", function () {
          try {
            var rawName = String(message.rawPrompt || "未命名提示词").replace(/\s+/g, " ").trim();
            var shortName = rawName.slice(0, 30) || "未命名提示词";
            __APP.addPromptToLibrary({
              name: shortName,
              content: message.rawPrompt,
              category: "收藏",
              isFavorite: true
            });
            flashButton(favoritePromptBtn, "已收藏 ✓", "is-success", 2000);
          } catch (error) {
            window.alert("收藏失败：" + (error && error.message ? error.message : "未知错误"));
          }
        });
        actions.appendChild(favoritePromptBtn);

        // 始终提供「重新生成」按钮，方便用户用原参数重新生成
        var regenerateBtn = document.createElement("button");
        regenerateBtn.type = "button";
        regenerateBtn.className = "ghost-button small-button";
        regenerateBtn.textContent = "重新生成";
        regenerateBtn.addEventListener("click", function () {
          regenerateFailedMessage(message);
        });
        actions.appendChild(regenerateBtn);
      } else {
        actions.remove();
      }

      elements.messageList.appendChild(fragment);

      if (text.textContent && text.textContent.length > 80) {
        text.classList.add("is-clamped");
        window.requestAnimationFrame(function () {
          if (text.scrollHeight > text.clientHeight + 2) {
            var expandBtn = document.createElement("button");
            expandBtn.className = "text-expand-btn";
            expandBtn.type = "button";
            expandBtn.textContent = "展开全文";
            expandBtn.addEventListener("click", function () {
              var isClamped = text.classList.toggle("is-clamped");
              expandBtn.textContent = isClamped ? "展开全文" : "收起";
            });
            text.parentNode.insertBefore(expandBtn, text.nextSibling);
          } else {
            text.classList.remove("is-clamped");
          }
        });
      }
    });

    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  }

  function getImageMessages() {
    return state.history
      .filter(function (item) { return item.role === "assistant" && Array.isArray(item.images) && item.images.length > 0; })
      .slice()
      .reverse();
  }

  function renderHistorySummary() {
    var imageMessages = getImageMessages().slice(0, 8);
    elements.historyList.innerHTML = "";

    if (imageMessages.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "当前对话里还没有生成记录。图片库会独立保留。";
      elements.historyList.appendChild(empty);
      return;
    }

    imageMessages.forEach(function (message) {
      var item = document.createElement("article");
      item.className = "history-entry";
      var header = document.createElement("div");
      header.className = "history-entry-header";
      var title = document.createElement("p");
      title.className = "history-entry-title";
      title.textContent = message.rawPrompt || "未命名提示词";
      var time = document.createElement("span");
      time.className = "history-note";
      time.textContent = new Date(message.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      var meta = document.createElement("div");
      meta.className = "meta-row";
      renderMetaTags(meta, message);
      var actions = document.createElement("div");
      actions.className = "message-actions";
      var reuse = document.createElement("button");
      reuse.type = "button";
      reuse.textContent = "再次创作";
      reuse.addEventListener("click", function () {
        elements.promptInput.value = message.rawPrompt || "";
        persistDraft();
        if (message.aspectRatio) {
          elements.aspectRatio.value = message.aspectRatio;
          persistAspectRatio();
        }
        if (message.styleTemplateId) {
          elements.styleTemplate.value = message.styleTemplateId;
          persistStyleTemplate();
        }
        if (message.model) {
          var targetModel = __APP.normalizeModelValue(message.model);
          var optionMatch = __APP.getModelOptions().find(function (item) {
            return item.value === targetModel || item.channelId === targetModel || item.value.indexOf(targetModel + "|") === 0;
          });
          elements.modelName.value = optionMatch ? optionMatch.value : targetModel;
          persistModel();
        }
        if (message.mode) {
          setMode(message.mode);
        }
        elements.promptInput.focus();
      });
      header.append(title, time);
      actions.appendChild(reuse);

      item.append(header);
      if (meta.children.length) {
        item.appendChild(meta);
      }
      item.appendChild(actions);
      elements.historyList.appendChild(item);
    });
  }

  function persistDraft() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.draft, elements.promptInput.value);
  }

  function persistBatchDraft() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.batchDraft, elements.batchPromptInput.value);
  }

  function persistAspectRatio() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.aspectRatio, elements.aspectRatio.value);
  }

  function persistImageQuality() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.imageQuality, elements.imageQuality.value);
  }

function persistStyleTemplate() {
window.localStorage.setItem(__APP.STORAGE_KEYS.styleTemplate, elements.styleTemplate.value);
}

  function persistImageCount() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.imageCount, elements.imageCount.value);
  }

  function persistMode() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.mode, state.mode);
  }

  function persistTaskMode() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.taskMode, state.taskMode);
  }

  function persistModel() {
    window.localStorage.setItem(__APP.STORAGE_KEYS.model, elements.modelName.value);
  }

  function getStoredApiKey() {
// 从动态生图通道中查找 API Key
var model = elements.modelName.value || __APP.DEFAULT_MODEL;
var ch = __APP.getImageChannelByModel(model);
if (ch) {
return ch.apiKey || "";
}
return "";
}

function getStoredBaseUrl() {
	// 从动态生图通道中查找 Base URL
	var model = elements.modelName.value || __APP.DEFAULT_MODEL;
	var ch = __APP.getImageChannelByModel(model);
	if (ch && ch.baseUrl) {
		return ch.baseUrl;
	}
	return __APP.APIMART_GENERATION_URL;
}

function getStoredCustomBaseUrl() {
	var model = elements.modelName.value || __APP.DEFAULT_MODEL;
	var ch = __APP.getImageChannelByModel(model);
	if (ch && ch.baseUrl) {
		return ch.baseUrl;
	}
	return "";
}

  function syncModelHelpText() {
    var note = __APP.getModelMeta(elements.modelName.value).note;
    var noteElement = elements.modelName.parentElement.querySelector(".field-note");
    if (noteElement) {
      noteElement.textContent = "当前模型：" + note + "。";
    }
  }

function syncApiFields() {
var model = elements.modelName.value;
if (!model) {
  if (elements.modelChannelNote) {
    elements.modelChannelNote.textContent = "当前没有可用模型，请到设置页启用至少一个生图通道。";
  }
  return;
}
var ch = __APP.getImageChannelByModel(model);
if (elements.modelChannelNote) {
if (ch) {
var modeLabel = ch.mode === "sync" ? "同步出图" : ch.mode === "async" ? "异步出图" : "自动检测";
elements.modelChannelNote.textContent = "通道「" + ch.name + "」· " + ch.type + " · " + modeLabel + "，请在设置页配置。";
} else {
elements.modelChannelNote.textContent = "当前模型没有可用的生图通道，请到设置页启用或配置对应通道。";
}
}
if (elements.apiKeyField) {
elements.apiKeyField.hidden = true;
}
if (elements.gptApiKeyField) {
elements.gptApiKeyField.hidden = true;
}
if (elements.customApiKeyField) {
elements.customApiKeyField.hidden = true;
}
if (elements.agnesApiKeyField) {
elements.agnesApiKeyField.hidden = true;
}
if (elements.baseUrl) {
elements.baseUrl.readOnly = true;
}
}

function getRequestChannelLabel() {
var model = elements.modelName.value || __APP.DEFAULT_MODEL;
var ch = __APP.getImageChannelByModel(model);
if (ch) {
return ch.name + " · " + ch.model;
}
return "生图通道";
}

  function buildTaskEndpointForModel(taskId, model) {
    var relayBaseUrl;
    if (model && __APP.isCustomImageModel(model)) {
      relayBaseUrl = getStoredCustomBaseUrl();
    } else {
      relayBaseUrl = getStoredBaseUrl();
    }
    var normalizedBaseUrl = (relayBaseUrl || __APP.APIMART_GENERATION_URL).replace(/\/+$/, "");
    if (/\/images\/generations(?:[?#].*)?$/.test(normalizedBaseUrl)) {
      return normalizedBaseUrl.replace(/\/images\/generations(?:[?#].*)?$/, "/tasks/" + encodeURIComponent(taskId));
    }
    if (/\/v1(?:[\/?#]|$)/.test(normalizedBaseUrl)) {
      return normalizedBaseUrl + "/tasks/" + encodeURIComponent(taskId);
    }
    return normalizedBaseUrl + "/v1/tasks/" + encodeURIComponent(taskId);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function abortableSleep(ms, signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new DOMException("生成已停止", "AbortError"));
    }
    return new Promise(function (resolve, reject) {
      var timeoutId = window.setTimeout(resolve, ms);
      if (!signal) {
        return;
      }
      signal.addEventListener("abort", function () {
        window.clearTimeout(timeoutId);
        reject(new DOMException("生成已停止", "AbortError"));
      }, { once: true });
    });
  }

  function syncGenerationControls() {
    var isGenerating = state.generating;
    var queueCount = state.generationQueue.length;

    // 生成中时，禁用不影响排队参数的核心控件
    // 但保持所有生成参数控件可用，以便用户为排队任务调整参数
    [
      elements.apiKey,
      elements.gptApiKey,
      elements.agnesApiKey,
      elements.baseUrl,
      elements.clearHistory,
      elements.clearChat
    ].forEach(function (element) {
      if (element) {
        element.disabled = isGenerating;
      }
    });

    // 生成参数控件始终可用（排队时每个任务独立记录参数快照）
    if (elements.modelName) {
      elements.modelName.disabled = false;
    }
    if (elements.aspectRatio) {
      elements.aspectRatio.disabled = false;
    }
    if (elements.imageQuality) {
      elements.imageQuality.disabled = false;
    }
    if (elements.styleTemplate) {
      elements.styleTemplate.disabled = false;
    }
    if (elements.imageCount) {
      elements.imageCount.disabled = false;
    }

    // 提示词输入框始终可用（允许排队输入）
    if (elements.promptInput) {
      elements.promptInput.disabled = false;
    }
    if (elements.batchPromptInput) {
      elements.batchPromptInput.disabled = isGenerating;
    }
    if (elements.clearBatchPrompts) {
      elements.clearBatchPrompts.disabled = isGenerating;
    }

    elements.modeButtons.forEach(function (button) {
      button.disabled = isGenerating;
    });
    elements.taskModeButtons.forEach(function (button) {
      button.disabled = isGenerating;
    });

    if (elements.randomGenerateButton) {
      elements.randomGenerateButton.disabled = false;
    }
    if (elements.optimizePromptButton) {
      elements.optimizePromptButton.disabled = state.optimizing;
    }
    if (elements.generateButton) {
      // 生成中也不禁用，允许提交排队
      elements.generateButton.disabled = false;
      // 移除 loading 状态（pointer-events: none 会阻止点击），改用文字提示
      if (isGenerating) {
        elements.generateButton.classList.remove("is-loading");
        elements.generateButton.removeAttribute("aria-busy");
      }
    }
    if (elements.stopGenerateButton) {
      elements.stopGenerateButton.hidden = !isGenerating;
      elements.stopGenerateButton.disabled = !isGenerating;
    }
    if (elements.generateButton) {
      if (isGenerating) {
        if (queueCount > 0) {
          elements.generateButton.textContent = "排队生成 (" + queueCount + ")";
        } else {
          elements.generateButton.textContent = "加入排队";
        }
      } else {
        elements.generateButton.textContent = getGenerateButtonLabel();
      }
    }

    // 渲染排队状态指示器
    renderQueueStatus();
  }

  // 临时替换按钮文字与样式，用于即时反馈；执行完毕后会自动恢复
  function flashButton(button, text, className, duration) {
    if (!button) {
      return;
    }
    var restoreTimer = button.__flashTimer;
    if (restoreTimer) {
      window.clearTimeout(restoreTimer);
      button.__flashTimer = null;
    }
    var previousText = button.__flashOriginalText != null
      ? button.__flashOriginalText
      : (button.textContent || "");
    button.__flashOriginalText = previousText;
    if (text) {
      button.textContent = text;
    }
    if (className) {
      button.classList.add(className);
      button.dataset.flashClass = className;
    }
    button.__flashTimer = window.setTimeout(function () {
      var originalClass = button.dataset.flashClass || "";
      if (originalClass) {
        button.classList.remove(originalClass);
        button.dataset.flashClass = "";
      }
      button.textContent = button.__flashOriginalText || "";
      button.__flashOriginalText = null;
      button.__flashTimer = null;
    }, duration);
  }

  function stopCurrentGeneration() {
    if (!state.generating || !state.abortController) {
      return;
    }
    state.abortController.abort();
    // 清空排队队列
    var clearedCount = state.generationQueue.length;
    state.generationQueue = [];
    state.queueProcessing = false;
    if (elements.stopGenerateButton) {
      elements.stopGenerateButton.disabled = true;
      // 给用户明确反馈：停止请求已发出
      flashButton(elements.stopGenerateButton, "停止中…", "is-loading", 1200);
    }
    var stopMsg = "正在停止当前生图请求...";
    if (clearedCount > 0) {
      stopMsg += "（已清空 " + clearedCount + " 条排队任务）";
    }
    setStatus("停止中", stopMsg);
    renderQueueStatus();
  }

  function getRandomImagePrompt() {
    var index = Math.floor(Math.random() * __APP.RANDOM_IMAGE_PROMPTS.length);
    return __APP.RANDOM_IMAGE_PROMPTS[index];
  }

  function startRandomGeneration() {
    var preset = getRandomImagePrompt();
    if (state.taskMode !== "single") {
      setTaskMode("single");
    }
    setMode("text");
    elements.promptInput.value = preset.prompt;
    persistDraft();
    // 即时反馈：让用户明确知道点的是哪个随机场景
    if (elements.randomGenerateButton) {
      flashButton(elements.randomGenerateButton, "已选「" + preset.title + "」", "", 1400);
    }
    setStatus("随机生图", "已生成提示词：" + preset.title + "，可点击「开始创作」或「加入排队」。");
  }

  function clearSinglePrompt() {
    elements.promptInput.value = "";
    persistDraft();
    setStatus("待命", "提示词已清空。");
    elements.promptInput.focus();
  }

  async function optimizePrompt() {
    if (state.optimizing) {
      return;
    }

    var rawPrompt = elements.promptInput.value.trim();
    if (!rawPrompt) {
      setStatus("待命", "请先输入提示词，再点「一键优化」。");
      elements.promptInput.focus();
      return;
    }

    var providerId = __APP.getOptimizeProvider();
    var model = __APP.getOptimizeModel();
    var provider = __APP.getLlmProviderById(providerId);
    if (!provider) {
      setStatus("待命", "未找到一键优化所用的模型商配置，请先到设置页配置。");
      return;
    }
    if (!String(provider.apiKey || "").trim()) {
      setStatus("待命", "模型商「" + provider.name + "」的 API Key 为空，请先在辅助模型配置中填写。");
      return;
    }

    state.optimizing = true;
    if (elements.optimizePromptButton) {
      elements.optimizePromptButton.disabled = true;
      elements.optimizePromptButton.textContent = "优化中…";
    }

    var instruction = __APP.OPTIMIZE_PROMPT_INSTRUCTION + "\n\n用户提示词：" + rawPrompt;
    var messages = [{ role: "user", content: instruction }];

    try {
      var text = await __APP.callLlmApi(providerId, model, messages);
      if (!text) {
        throw new Error("接口已返回，但没有拿到可用的优化结果。");
      }

      elements.promptInput.value = text;
      persistDraft();
      setStatus("待命", "提示词已优化，可继续点击「一键优化」再次精炼，或直接「开始创作」。");
    } catch (error) {
      if (error && error.name === "AbortError") {
        setStatus("待命", "提示词优化已取消。");
      } else {
        setStatus("待命", "优化失败：" + (error && error.message ? error.message : "未知错误"));
      }
    } finally {
      state.optimizing = false;
      if (elements.optimizePromptButton) {
        elements.optimizePromptButton.disabled = false;
        elements.optimizePromptButton.textContent = "一键优化";
      }
    }
  }

  function clearBatchPrompts() {
    if (state.generating) {
      return;
    }

    elements.batchPromptInput.value = "";
    state.batchQueue = [];
    persistBatchDraft();
    renderBatchQueue();
    setStatus("待命", "批量提示词已清空。");
    elements.batchPromptInput.focus();
  }

  function setMode(nextMode) {
    var normalizedMode = normalizeMode(nextMode);
    state.mode = normalizedMode;
    persistMode();
    renderModeButtons();
    renderTaskMode();
  }

  function setTaskMode(nextMode) {
    state.taskMode = normalizeTaskMode(nextMode);
    persistTaskMode();
    renderTaskMode();
  }

  async function saveRecordToServer(record, signal) {
    var response = await fetch(__APP.API_ENDPOINTS.save, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: signal,
      body: JSON.stringify({ record: record })
    });
    var data = await response.json();
    if (!response.ok || !data || !data.record) {
      throw new Error(data && data.error ? data.error : "本地保存失败");
    }
    return data.record;
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

  function extractGptImageUrls(taskData) {
    var resultImages = taskData && taskData.result && Array.isArray(taskData.result.images)
      ? taskData.result.images
      : [];
    return resultImages.flatMap(function (item) {
      if (typeof item === "string") {
        return [item];
      }
      if (item && Array.isArray(item.b64_json)) {
        return item.b64_json.filter(function (data) { return typeof data === "string" && data.trim(); }).map(function (data) { return "data:image/png;base64," + data; });
      }
      if (item && typeof item.b64_json === "string") {
        return ["data:image/png;base64," + item.b64_json];
      }
      if (item && Array.isArray(item.url)) {
        return item.url.filter(function (url) { return typeof url === "string" && url.trim(); });
      }
      if (item && typeof item.url === "string") {
        return [item.url];
      }
      return [];
    });
  }

  function normalizeGptTaskData(data) {
    if (data && Array.isArray(data.data)) {
      return data.data[0] || {};
    }
    if (data && data.data) {
      return data.data;
    }
    return data || {};
  }

  async function pollGptImageTask(taskId, apiKey, signal, model) {
    var startedAt = Date.now();
    await abortableSleep(__APP.GPT_IMAGE_TASK_INITIAL_DELAY, signal);

    while (Date.now() - startedAt <= __APP.GPT_IMAGE_TASK_TIMEOUT) {
      var elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      setStatus("生成中", "任务 " + taskId + " 正在处理中，已等待 " + elapsedSeconds + " 秒...");
      var taskEndpoint = buildTaskEndpointForModel(taskId, model);
      var response;
      try {
        response = await __APP.proxyFetch(taskEndpoint, {
          method: "GET",
          signal: signal,
          headers: {
            Authorization: "Bearer " + apiKey
          }
        });
      } catch (networkError) {
        console.error("[pollGptImageTask] 任务查询 fetch 失败", networkError, taskEndpoint);
        throw wrapFetchError(networkError, "任务结果查询", taskEndpoint);
      }
      var data = await response.json();
      var taskData = normalizeGptTaskData(data);

      if (!response.ok || data.code >= 400) {
        var message = data && data.error && data.error.message ? data.error.message : "GPT-Image 中转任务查询失败。";
        throw new Error(message);
      }

      if (__APP.isGptTaskCompleted(taskData.status)) {
        var images = extractGptImageUrls(taskData);
        if (images.length === 0) {
          throw new Error("GPT-Image 中转任务已完成，但没有返回可用图片 URL。");
        }
        return images;
      }

      if (__APP.isGptTaskFailed(taskData.status)) {
        var message = taskData.error && taskData.error.message ? taskData.error.message : "GPT-Image 中转任务生成失败。";
        throw new Error(message);
      }

      await abortableSleep(__APP.GPT_IMAGE_TASK_POLL_INTERVAL, signal);
    }

    throw new Error("GPT-Image 中转任务等待超过 10 分钟，请稍后到当前中转站后台查看任务结果，或复制任务 ID 联系平台排查。");
  }

  /**
   * 包装 fetch 网络错误，把浏览器原始的 "Failed to fetch" 转换成带上下文的可读信息
   * @param {Error} error fetch 抛出的错误
   * @param {string} context 当前正在执行的操作描述
   * @param {string} endpoint 请求地址
   * @returns {Error}
   */
  function wrapFetchError(error, context, endpoint) {
    if (error && error.name === "AbortError") {
      return error;
    }
    var message = error && error.message ? String(error.message) : "未知网络错误";
    // 浏览器在 CORS、DNS、证书、协议错误、请求被拦截时常返回 Failed to fetch / NetworkError
    // Node.js fetch 失败时返回 fetch failed（真实原因在 cause 里，已由服务端代理追加）
    if (/failed to fetch|fetch failed|networkerror|network error|无法访问|abort|timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
      var hint = "请检查：1) 网络连接；2) Base URL 是否以 https:// 开头且拼写正确；3) 浏览器是否拦截了跨域请求；4) 本地代理或防火墙设置。";
      return new Error(context + "失败：无法连接到 " + endpoint + "。(" + message + ") " + hint);
    }
    return new Error(context + "失败：" + message + " (请求地址：" + endpoint + ")");
  }

  /**
   * 根据 Base URL 构建标准 OpenAI Images / Agnes 接口 endpoint
   * @param {string} baseUrl
   * @returns {string}
   */
  function buildChannelEndpoint(baseUrl) {
    var endpoint = (baseUrl || "").replace(/\/+$/, "");
    if (!endpoint) {
      return "";
    }
    if (!/\/images\/generations/.test(endpoint)) {
      endpoint += /\/v1(?:[\/?#]|$)/.test(endpoint) ? "/images/generations" : "/v1/images/generations";
    }
    return endpoint;
  }

  /**
   * 统一生图通道调用（支持 openai_images / agnes 类型，自动适配同步/异步）
   * @param {Object} ch 通道配置对象
   */
  async function generateImageChannel(ch, rawPrompt, aspectRatio, imageQuality, styleTemplateId, signal) {
    var finalPrompt = __APP.buildPrompt(rawPrompt, styleTemplateId);
    var apiKey = (ch.apiKey || "").trim();
    var model = ch.model;
    var baseUrl = (ch.baseUrl || "").replace(/\/+$/, "");

    if (!apiKey) {
      throw new Error("通道「" + ch.name + "」的 API Key 为空，请先在设置页填写。");
    }
    if (!model) {
      throw new Error("通道「" + ch.name + "」的模型名为空，请先在设置页填写。");
    }
    if (!baseUrl) {
      throw new Error("通道「" + ch.name + "」的 Base URL 为空，请先在设置页填写完整地址（例如 https://api.apimart.ai）。直接写相对地址会导致请求发不出去。");
    }

    var channelLabel = ch.name + " · " + model;
    var qualityMeta = getImageQualityMeta(imageQuality);

    if (ch.type === "openai_images") {
      var endpoint = buildChannelEndpoint(baseUrl);

      /**
       * 执行一次 OpenAI Images 格式请求，返回原始响应对象
       * @param {string} sizeFormat "pixels" | "ratio"
       */
      async function callOpenAiImagesOnce(sizeFormat) {
        var body = {
          model: model,
          prompt: finalPrompt,
          n: 1,
          size: __APP.getGptImageSize(aspectRatio, imageQuality, sizeFormat),
          resolution: __APP.getGptImageResolution(imageQuality)
        };
        var res = await __APP.proxyFetch(endpoint, {
          method: "POST",
          signal: signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
          },
          body: JSON.stringify(body)
        });
        var resData = await res.json();
        return { response: res, data: resData };
      }

      setStatus("生成中", "正在通过「" + ch.name + "」生成图片...");

      var response, data;
      try {
        var firstTry = await callOpenAiImagesOnce("pixels");
        response = firstTry.response;
        data = firstTry.data;
      } catch (networkError) {
        console.error("[generateImageChannel] openai_images fetch 失败", networkError, endpoint);
        throw wrapFetchError(networkError, "「" + ch.name + "」图片生成", endpoint);
      }

      // 如果返回 size 格式错误，自动改用 ratio 尺寸重试
      if (!response.ok || (data && data.code >= 400)) {
        var firstErrMsg = data && data.error && data.error.message ? data.error.message : "";
        if (__APP.isGptImageSizeFormatError(firstErrMsg)) {
          setStatus("调整尺寸", "当前中转站不接受像素尺寸，正在自动改用比例尺寸重试。");
          try {
            var secondTry = await callOpenAiImagesOnce("ratio");
            response = secondTry.response;
            data = secondTry.data;
          } catch (networkError) {
            console.error("[generateImageChannel] openai_images ratio 重试失败", networkError, endpoint);
            throw wrapFetchError(networkError, "「" + ch.name + "」图片生成（比例尺寸重试）", endpoint);
          }
        }
      }

      if (!response.ok || (data && data.code >= 400)) {
        var errMsg = "请求失败（" + response.status + "）";
        if (data) {
          if (data.error && data.error.message) {
            errMsg = data.error.message;
          } else if (data.message) {
            errMsg = data.message;
          } else if (data.detail) {
            errMsg = data.detail;
          } else if (typeof data.error === "string" && data.error) {
            errMsg = data.error;
          } else if (typeof data === "string") {
            errMsg = data;
          } else {
            try { errMsg = JSON.stringify(data).slice(0, 500); } catch (e) { /* keep default */ }
          }
        }
        throw new Error("通道「" + ch.name + "」请求失败（HTTP " + response.status + "）：" + errMsg);
      }

      // 检查是否为异步模式（有 task_id）
      var firstData = data && Array.isArray(data.data) ? data.data[0] : null;
      var taskId = firstData && firstData.task_id;

      if (ch.mode === "async" || (ch.mode === "auto" && taskId)) {
        setStatus("轮询中", "任务 " + taskId + " 正在处理，等待出图...");
        var images;
        try {
          images = await pollGptImageTask(taskId, apiKey, signal, model);
        } catch (pollError) {
          if (pollError && pollError.name === "AbortError") {
            throw pollError;
          }
          throw new Error("通道「" + ch.name + "」任务轮询失败：" + (pollError && pollError.message ? pollError.message : "未知错误"));
        }
        return {
          model: model,
          text: "已使用 " + channelLabel + " · " + qualityMeta.label + " 完成图片生成，共 " + images.length + " 张图片。",
          images: images,
          finalPrompt: finalPrompt
        };
      }

      // 同步模式：直接提取图片
      var syncImages = extractSyncImageUrls(data);
      if (syncImages.length === 0) {
        throw new Error("通道「" + ch.name + "」已返回，但没有拿到图片数据。");
      }

      return {
        model: model,
        text: "已使用 " + channelLabel + " · " + qualityMeta.label + " 完成图片生成，共 " + syncImages.length + " 张图片。",
        images: syncImages,
        finalPrompt: finalPrompt
      };
    }

    if (ch.type === "agnes") {
      var agnesEndpoint = buildChannelEndpoint(baseUrl);

      var agnesPayload = {
        model: model,
        prompt: finalPrompt,
        size: __APP.normalizeImageQuality(imageQuality),
        ratio: aspectRatio || "1:1"
      };
      agnesPayload.extra_body = { response_format: "url" };

      setStatus("生成中", "正在通过「" + ch.name + "」生成图片...");

      var agnesRes;
      try {
        agnesRes = await __APP.proxyFetch(agnesEndpoint, {
          method: "POST",
          signal: signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
          },
          body: JSON.stringify(agnesPayload)
        });
      } catch (networkError) {
        console.error("[generateImageChannel] agnes fetch 失败", networkError, agnesEndpoint);
        throw wrapFetchError(networkError, "「" + ch.name + "」图片生成", agnesEndpoint);
      }

      var agnesData;
      try {
        agnesData = await agnesRes.json();
      } catch (parseError) {
        throw new Error("通道「" + ch.name + "」返回的不是有效 JSON（状态码：" + agnesRes.status + "）。");
      }

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
            try { agnesErrDetail = JSON.stringify(agnesData).slice(0, 500); } catch (e) { agnesErrDetail = "未知错误"; }
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
      if (agnesImages.length === 0) {
        throw new Error("通道「" + ch.name + "」已返回，但没有拿到图片数据。");
      }

      return {
        model: model,
        text: "已使用 " + channelLabel + " · " + qualityMeta.label + " 完成图片生成，共 " + agnesImages.length + " 张图片。",
        images: agnesImages,
        finalPrompt: finalPrompt
      };
    }

    throw new Error("不支持的通道类型：" + ch.type);
  }

  async function generateImage(rawPrompt, aspectRatio, imageQuality, styleTemplateId, signal) {
    var model = elements.modelName.value || __APP.DEFAULT_MODEL;
    var finalPrompt = __APP.buildPrompt(rawPrompt, styleTemplateId);

    // 查找模型所属的动态生图通道
    var ch = __APP.getImageChannelByModel(model);
    if (ch) {
      return generateImageChannel(ch, rawPrompt, aspectRatio, imageQuality, styleTemplateId, signal);
    }

    // 当前模型没有可用通道
    var modelMeta = __APP.getModelMeta(model);
    var displayLabel = modelMeta.value === model ? modelMeta.label : model;
    throw new Error("当前模型「" + (displayLabel || model) + "」没有可用的生图通道。请先到设置页启用或配置对应通道。");
  }

  function getGenerationRunConfig() {
    var styleTemplateId = elements.styleTemplate.value;
    var styleTemplate = __APP.getStyleTemplate(styleTemplateId);
    return {
      aspectRatio: elements.aspectRatio.value,
      imageQuality: __APP.normalizeImageQuality(elements.imageQuality.value),
      imageQualityLabel: getImageQualityMeta(elements.imageQuality.value).label,
      styleTemplateId: styleTemplateId,
      styleTemplateLabel: styleTemplate.label,
      model: elements.modelName.value,
      mode: state.mode,
      modeLabel: __APP.MODE_META[state.mode].label,
      imageCount: Number(elements.imageCount.value) || 1
    };
  }

  function beginGenerationSession() {
    state.generating = true;
    state.abortController = new AbortController();
    // 给「开始创作」按钮加 loading 反馈：旋转图标叠加层由 CSS 的 ::before 实现
    if (elements.generateButton) {
      elements.generateButton.classList.add("is-loading");
      elements.generateButton.setAttribute("aria-busy", "true");
    }
    syncGenerationControls();
  }

  function finishGenerationSession() {
    state.generating = false;
    state.abortController = null;
    if (elements.generateButton) {
      elements.generateButton.classList.remove("is-loading");
      elements.generateButton.removeAttribute("aria-busy");
      // 文案由 syncGenerationControls -> getGenerateButtonLabel 恢复
    }
    syncGenerationControls();
  }

  function trimHistoryAndRefresh() {
    state.history = state.history.slice(-__APP.MAX_HISTORY);
    saveHistory();
    renderMessages();
    renderHistorySummary();
  }

  async function executePromptGeneration(rawPrompt, runConfig, options) {
    var generationSignal = state.abortController ? state.abortController.signal : null;
    var clearPromptOnSuccess = options && options.clearPromptOnSuccess;
    var generationStartedAt = Date.now();
    var displayPrompt = rawPrompt || "图片生成";
    var userMessage = {
      id: __APP.createId(),
      role: "user",
      text: displayPrompt,
      images: [],
      prompt: displayPrompt,
      rawPrompt: displayPrompt,
      aspectRatio: runConfig.aspectRatio,
      imageQuality: runConfig.imageQuality,
      imageQualityLabel: runConfig.imageQualityLabel,
      styleTemplateId: runConfig.styleTemplateId,
      styleTemplateLabel: runConfig.styleTemplateLabel,
      model: runConfig.model,
      mode: runConfig.mode,
      modeLabel: runConfig.modeLabel,
      imageCount: runConfig.imageCount,
      mediaType: runConfig.mediaType || "",
      time: Date.now()
    };

    var pendingMessage = {
      id: __APP.createId(),
      role: "assistant",
      text: "正在生成图片，请稍等...",
      images: [],
      prompt: displayPrompt,
      rawPrompt: displayPrompt,
      aspectRatio: runConfig.aspectRatio,
      imageQuality: runConfig.imageQuality,
      imageQualityLabel: runConfig.imageQualityLabel,
      styleTemplateId: runConfig.styleTemplateId,
      styleTemplateLabel: runConfig.styleTemplateLabel,
      model: runConfig.model,
      mode: runConfig.mode,
      modeLabel: runConfig.modeLabel,
      imageCount: runConfig.imageCount,
      mediaType: runConfig.mediaType || "",
      time: Date.now()
    };

    state.history.push(userMessage, pendingMessage);
    saveHistory();
    renderMessages();
    renderHistorySummary();

    try {
      var imageCount = Number(runConfig.imageCount) || 1;
      var result;

      if (imageCount <= 1) {
        // 单张生成：原有逻辑
        result = await generateImage(rawPrompt, runConfig.aspectRatio, runConfig.imageQuality, runConfig.styleTemplateId, generationSignal);
      } else {
        // 多张并行生成：同时请求 N 次，合并结果
        setStatus("生成中", "正在并行生成 " + imageCount + " 张图片，请稍等...");
        var generationPromises = [];
        for (var i = 0; i < imageCount; i += 1) {
          generationPromises.push(generateImage(rawPrompt, runConfig.aspectRatio, runConfig.imageQuality, runConfig.styleTemplateId, generationSignal));
        }
        var allResults = await Promise.all(generationPromises);
        var allImages = [];
        var allTexts = [];
        allResults.forEach(function (res) {
          if (Array.isArray(res.images)) {
            allImages = allImages.concat(res.images);
          }
          if (res.text && allTexts.indexOf(res.text) === -1) {
            allTexts.push(res.text);
          }
        });
        result = {
          model: allResults[0].model,
          text: allTexts.join("\n\n") || "已生成 " + allImages.length + " 张图片。",
          images: allImages,
          finalPrompt: allResults[0].finalPrompt
        };
      }
      var generationDurationSeconds = __APP.getElapsedSeconds(generationStartedAt);
      var baseRecord = {
        id: pendingMessage.id,
        prompt: result.finalPrompt,
        rawPrompt: displayPrompt,
        images: result.images,
        aspectRatio: runConfig.aspectRatio,
        imageQuality: runConfig.imageQuality,
        imageQualityLabel: runConfig.imageQualityLabel,
        styleTemplateId: runConfig.styleTemplateId,
        styleTemplateLabel: runConfig.styleTemplateLabel,
        model: runConfig.model,
        mode: runConfig.mode,
        modeLabel: runConfig.modeLabel,
        imageCount: runConfig.imageCount,
        mediaType: result.mediaType || runConfig.mediaType || "",
        time: Date.now(),
        generationDurationSeconds: generationDurationSeconds
      };

      var persistedRecord;
      var saveWarning = "";
      if (!Array.isArray(result.images) || result.images.length === 0) {
        persistedRecord = baseRecord;
      } else {
        try {
          persistedRecord = await saveRecordToServer(baseRecord, generationSignal);
        } catch (saveError) {
          if (saveError && saveError.name === "AbortError") {
            throw saveError;
          }
          appendLegacyGalleryRecord(baseRecord);
          persistedRecord = baseRecord;
          saveWarning = "\n\n本地目录写入失败，已临时保存在浏览器：" + saveError.message;
        }
      }

      var pendingIndex = state.history.findIndex(function (item) { return item.id === pendingMessage.id; });
      if (pendingIndex >= 0) {
        state.history[pendingIndex] = {
          id: pendingMessage.id,
          role: "assistant",
          text: result.text + " 耗时：" + __APP.formatDurationSeconds(generationDurationSeconds) + saveWarning,
          images: persistedRecord.images,
          prompt: persistedRecord.prompt,
          rawPrompt: persistedRecord.rawPrompt,
          aspectRatio: persistedRecord.aspectRatio || runConfig.aspectRatio,
          imageQuality: persistedRecord.imageQuality || runConfig.imageQuality,
          imageQualityLabel: persistedRecord.imageQualityLabel || runConfig.imageQualityLabel,
          styleTemplateId: persistedRecord.styleTemplateId || runConfig.styleTemplateId,
          styleTemplateLabel: persistedRecord.styleTemplateLabel || runConfig.styleTemplateLabel,
          model: runConfig.model,
          mode: persistedRecord.mode || runConfig.mode,
          modeLabel: persistedRecord.modeLabel || runConfig.modeLabel,
          imageCount: persistedRecord.imageCount || runConfig.imageCount,
          mediaType: persistedRecord.mediaType || result.mediaType || runConfig.mediaType || "",
          time: persistedRecord.time,
          generationDurationSeconds: generationDurationSeconds
        };
      }

      if (clearPromptOnSuccess) {
        elements.promptInput.value = "";
        persistDraft();
      }

      trimHistoryAndRefresh();
      return {
        status: saveWarning ? "partial" : "success",
        persistedRecord: persistedRecord,
        saveWarning: saveWarning,
        generationDurationSeconds: generationDurationSeconds
      };
    } catch (error) {
      var wasAborted = error && error.name === "AbortError";
      var pendingIndex = state.history.findIndex(function (item) { return item.id === pendingMessage.id; });
      if (pendingIndex >= 0) {
        state.history[pendingIndex] = {
          id: pendingMessage.id,
          role: "assistant",
          text: wasAborted
            ? "已停止：本次生图已取消，没有写入图片库。"
            : "创作失败：" + error.message,
          images: [],
          failed: !wasAborted,
          prompt: displayPrompt,
          rawPrompt: displayPrompt,
          aspectRatio: runConfig.aspectRatio,
          imageQuality: runConfig.imageQuality,
          imageQualityLabel: runConfig.imageQualityLabel,
          styleTemplateId: runConfig.styleTemplateId,
          styleTemplateLabel: runConfig.styleTemplateLabel,
          model: runConfig.model,
          mode: runConfig.mode,
          modeLabel: runConfig.modeLabel,
          time: Date.now()
        };
      }

      trimHistoryAndRefresh();
      return {
        status: wasAborted ? "aborted" : "error",
        error: error
      };
    }
  }

  function regenerateFailedMessage(message) {
    var rawPrompt = message.rawPrompt || message.prompt || "";
    if (!rawPrompt) {
      setStatus("失败", "找不到可重新生成的提示词。");
      return;
    }

    var runConfig = {
      aspectRatio: message.aspectRatio || "",
      imageQuality: message.imageQuality,
      imageQualityLabel: message.imageQualityLabel,
      styleTemplateId: message.styleTemplateId || "",
      styleTemplateLabel: message.styleTemplateLabel || "",
      model: message.model || elements.modelName.value,
      mode: message.mode || state.mode,
      modeLabel: message.modeLabel || "",
      imageCount: Number(message.imageCount) || 1,
      mediaType: message.mediaType || ""
    };

    beginGenerationSession();
    setStatus("生成中", "正在重新生成，请稍等...");

    executePromptGeneration(rawPrompt, runConfig, { clearPromptOnSuccess: false })
      .then(function (outcome) {
        if (outcome.status === "success" || outcome.status === "partial") {
          setStatus(
            "已完成",
            "重新生成成功，已写入本地图库 · " + outcome.persistedRecord.images.length + " 张图片"
          );
        } else if (outcome.status === "aborted") {
          setStatus("已停止", "重新生成已停止。");
        } else {
          setStatus("失败", outcome.error.message);
        }
      })
      .catch(function (error) {
        setStatus("失败", error && error.message ? error.message : "重新生成失败");
      })
      .finally(function () {
        finishGenerationSession();
      });
  }

  function markPendingBatchQueueAsStopped(startIndex) {
    for (var index = startIndex; index < state.batchQueue.length; index += 1) {
      if (state.batchQueue[index].status === "pending") {
        state.batchQueue[index].status = "stopped";
        state.batchQueue[index].note = "未执行";
      }
    }
  }

  // ==================== 生图排队系统 ====================

  /**
   * 将提示词加入排队队列
   * @param {string} rawPrompt 提示词文本
   */
  function addToQueue(rawPrompt) {
    var queueItem = {
      id: __APP.createId(),
      prompt: rawPrompt,
      runConfig: getGenerationRunConfig()
    };
    state.generationQueue.push(queueItem);
    setStatus(
      "已排队",
      "提示词「" + rawPrompt.slice(0, 30) + (rawPrompt.length > 30 ? "…" : "") + "」已加入排队，当前第 " + state.generationQueue.length + " 位。"
    );
    elements.promptInput.value = "";
    persistDraft();
    syncGenerationControls();
    elements.promptInput.focus();
  }

  /**
   * 渲染排队状态指示器 UI
   */
  function renderQueueStatus() {
    var queueBar = document.getElementById("queue-status-bar");
    if (!queueBar) return;
    var queueCount = state.generationQueue.length;
    if (queueCount === 0 && !state.generating) {
      queueBar.hidden = true;
      return;
    }
    queueBar.hidden = false;
    var countEl = queueBar.querySelector(".queue-count");
    var labelEl = queueBar.querySelector(".queue-label");
    if (countEl) {
      countEl.textContent = queueCount;
    }
    if (labelEl) {
      if (queueCount > 0) {
        labelEl.textContent = "排队中 · 等待 " + (QUEUE_DELAY_MS / 1000) + " 秒间隔";
      } else {
        labelEl.textContent = "生成中 · 可继续输入提示词排队";
      }
    }
    // 高亮脉冲动画
    if (queueCount > 0) {
      queueBar.classList.add("has-queue");
    } else {
      queueBar.classList.remove("has-queue");
    }
  }

  /**
   * 处理排队队列：依次生成队列中的每条提示词
   * 每条之间间隔 QUEUE_DELAY_MS 毫秒，防止频繁请求报错
   * 单条失败不会中断队列，自动跳过继续处理下一条
   */
  async function processGenerationQueue() {
    if (state.queueProcessing) return;
    state.queueProcessing = true;

    try {
      while (state.generationQueue.length > 0) {
        var queueItem = state.generationQueue.shift();
        renderQueueStatus();

        // 间隔等待，防止频繁请求
        setStatus(
          "排队间隔",
          "将在 " + (QUEUE_DELAY_MS / 1000) + " 秒后开始下一条生成（剩余 " + state.generationQueue.length + " 条排队）"
        );
        try {
          await abortableSleep(QUEUE_DELAY_MS, state.abortController ? state.abortController.signal : null);
        } catch (e) {
          // 被中止了，清空队列
          state.generationQueue = [];
          renderQueueStatus();
          return;
        }

        // 开始生成队列中的这条提示词
        beginGenerationSession();
        var runConfig = queueItem.runConfig;
        var imageCountHint = runConfig.imageCount > 1 ? " × " + runConfig.imageCount + " 张" : "";
        setStatus(
          "排队生成中",
          "排队任务 · " + runConfig.modeLabel + " · " + runConfig.aspectRatio + " · " + runConfig.imageQualityLabel + " · " + runConfig.styleTemplateLabel + imageCountHint + "（剩余 " + state.generationQueue.length + " 条）"
        );

        try {
          var outcome = await executePromptGeneration(queueItem.prompt, runConfig, { clearPromptOnSuccess: false });
          if (outcome.status === "success" || outcome.status === "partial") {
            setStatus(
              outcome.status === "partial" ? "部分完成" : "排队完成",
              "排队任务已完成 · " + outcome.persistedRecord.images.length + " 张图片 · 耗时 " + __APP.formatDurationSeconds(outcome.generationDurationSeconds) + (state.generationQueue.length > 0 ? " · 剩余 " + state.generationQueue.length + " 条" : "")
            );
          } else if (outcome.status === "aborted") {
            // 用户停止了，清空剩余队列
            state.generationQueue = [];
            setStatus("已停止", "排队生成已停止。");
            finishGenerationSession();
            return;
          } else {
            // 失败时不中断队列，记录错误并继续处理下一条
            var errMsg = (outcome.error && outcome.error.message) ? outcome.error.message : "未知错误";
            setStatus("失败", "排队任务失败：" + errMsg + "（剩余 " + state.generationQueue.length + " 条排队）");
          }
        } catch (innerError) {
          // 防止 executePromptGeneration 抛出未捕获异常导致队列中断
          var innerErrMsg = (innerError && innerError.message) ? innerError.message : "未知错误";
          setStatus("失败", "排队任务异常：" + innerErrMsg + "（剩余 " + state.generationQueue.length + " 条排队）");
        } finally {
          finishGenerationSession();
        }
      }
    } finally {
      // 无论如何都要重置队列处理状态，防止死锁
      state.queueProcessing = false;
      renderQueueStatus();
      if (state.generationQueue.length === 0) {
        setStatus("已完成", "所有排队任务已完成。");
      }
    }
  }

  async function startSingleGeneration(rawPrompt) {
    var runConfig = getGenerationRunConfig();
    beginGenerationSession();
    var imageCountHint = runConfig.imageCount > 1 ? " × " + runConfig.imageCount + " 张" : "";
    setStatus(
      "生成中",
      runConfig.modeLabel + " · " + runConfig.aspectRatio + " · " + runConfig.imageQualityLabel + " · " + runConfig.styleTemplateLabel + " · " + __APP.getModelMeta(runConfig.model).label + " · " + getRequestChannelLabel() + imageCountHint
    );

    try {
      var outcome = await executePromptGeneration(rawPrompt, runConfig, { clearPromptOnSuccess: true });
      if (outcome.status === "success" || outcome.status === "partial") {
        setStatus(
          outcome.status === "partial" ? "部分完成" : "已完成",
          outcome.status === "partial"
            ? "图片已生成，但本地目录写入失败，已退回浏览器缓存 · 耗时 " + __APP.formatDurationSeconds(outcome.generationDurationSeconds)
            : "已写入本地图库 · " + outcome.persistedRecord.images.length + " 张图片 · 耗时 " + __APP.formatDurationSeconds(outcome.generationDurationSeconds)
        );
      } else if (outcome.status === "aborted") {
        setStatus("已停止", "当前生图已停止，可以重新调整提示词后再试。");
        state.generationQueue = [];
        renderQueueStatus();
      } else {
        setStatus("失败", outcome.error.message);
      }
    } finally {
      finishGenerationSession();
    }

    // 生成完成后，检查是否有排队任务
    if (state.generationQueue.length > 0) {
      await processGenerationQueue();
    }
  }

  async function startBatchGeneration() {
    var prompts = __APP.parseBatchPrompts(elements.batchPromptInput.value);
    if (prompts.length === 0) {
      setStatus("待命", "先输入至少一段批量提示词，再开始批量生成。");
      elements.batchPromptInput.focus();
      return;
    }

    var runConfig = getGenerationRunConfig();
    state.batchQueue = __APP.createBatchQueueEntries(prompts);
    beginGenerationSession();
    renderBatchQueue();

    var completedCount = 0;
    var failedCount = 0;

    try {
      for (var index = 0; index < state.batchQueue.length; index += 1) {
        var entry = state.batchQueue[index];
        entry.status = "running";
        entry.note = "第 " + (index + 1) + " / " + state.batchQueue.length + " 条";
        renderBatchQueue(entry.id);
        setStatus(
          "批量生成中",
          "第 " + (index + 1) + " / " + state.batchQueue.length + " 条 · " + runConfig.modeLabel + " · " + runConfig.aspectRatio + " · " + runConfig.imageQualityLabel + " · " + runConfig.styleTemplateLabel
        );

        var outcome = await executePromptGeneration(entry.prompt, runConfig, { clearPromptOnSuccess: false });
        if (outcome.status === "success" || outcome.status === "partial") {
          entry.status = "success";
          entry.note = outcome.status === "partial"
            ? "已生成，目录写入失败 · 耗时 " + __APP.formatDurationSeconds(outcome.generationDurationSeconds)
            : "已完成 · 耗时 " + __APP.formatDurationSeconds(outcome.generationDurationSeconds);
          completedCount += 1;
        } else if (outcome.status === "aborted") {
          entry.status = "stopped";
          entry.note = "当前任务已停止";
          markPendingBatchQueueAsStopped(index + 1);
          renderBatchQueue();
          setStatus("已停止", "批量生成已停止，已完成 " + completedCount + " 条。");
          return;
        } else {
          entry.status = "error";
          entry.note = outcome.error.message;
          failedCount += 1;
        }

        var nextEntry = state.batchQueue[index + 1];
        renderBatchQueue(nextEntry ? nextEntry.id : entry.id);

        if (index < state.batchQueue.length - 1) {
          var delayMs = __APP.BATCH_DELAY_MIN_MS + Math.floor(Math.random() * 1000);
          setStatus("批量等待", "第 " + (index + 1) + " / " + state.batchQueue.length + " 条已结束，" + (delayMs / 1000).toFixed(1) + " 秒后继续下一条。");
          await abortableSleep(delayMs, state.abortController.signal);
        }
      }

      setStatus("批量完成", "共完成 " + completedCount + " 条，失败 " + failedCount + " 条。每条耗时已显示在批量队列和生成记录中。");
    } catch (error) {
      if (error && error.name === "AbortError") {
        markPendingBatchQueueAsStopped(0);
        renderBatchQueue();
        setStatus("已停止", "批量生成已停止，已完成 " + completedCount + " 条。");
      } else {
        setStatus("失败", error && error.message ? error.message : "批量生成失败");
      }
    } finally {
      finishGenerationSession();
      renderBatchQueue();
    }
  }

  async function onSubmit(event) {
    event.preventDefault();

    persistDraft();
    persistBatchDraft();
    persistAspectRatio();
    persistImageQuality();
    persistStyleTemplate();
    persistMode();
    persistTaskMode();
    persistModel();

    if (state.taskMode === "batch") {
      if (state.generating) {
        setStatus("待命", "批量模式下暂不支持排队，请等待当前生成完成。");
        return;
      }
      await startBatchGeneration();
      return;
    }

    var rawPrompt = elements.promptInput.value.trim();
    if (!rawPrompt) {
      setStatus("待命", "先写一段提示词再开始创作。");
      elements.promptInput.focus();
      return;
    }

    // 如果正在生成中，将提示词加入排队队列
    if (state.generating) {
      addToQueue(rawPrompt);
      return;
    }

    await startSingleGeneration(rawPrompt);
  }

  function bindEvents() {

    if (elements.togglePreviewPanel) {
      elements.togglePreviewPanel.addEventListener("click", function () {
        var collapsed = !(elements.previewPanel && elements.previewPanel.classList.contains("is-collapsed"));
        setPreviewPanelCollapsed(collapsed);
      });
    }

    elements.modelName.addEventListener("change", function () {
      persistModel();
      syncModelHelpText();
      syncApiFields();
    });

    elements.aspectRatio.addEventListener("change", persistAspectRatio);
    elements.imageQuality.addEventListener("change", persistImageQuality);
    elements.styleTemplate.addEventListener("change", persistStyleTemplate);
    elements.imageCount.addEventListener("change", persistImageCount);
    elements.promptInput.addEventListener("input", persistDraft);
    elements.promptInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        elements.composer.requestSubmit();
      }
    });
    elements.batchPromptInput.addEventListener("input", function () {
      persistBatchDraft();
      if (!state.generating) {
        state.batchQueue = [];
        renderBatchQueue();
      }
      updateTemplatePreview();
    });
    elements.batchPromptInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        elements.composer.requestSubmit();
      }
    });
    elements.clearPrompt.addEventListener("click", clearSinglePrompt);
    if (elements.optimizePromptButton) {
      elements.optimizePromptButton.addEventListener("click", optimizePrompt);
    }
    elements.clearBatchPrompts.addEventListener("click", function () {
      clearBatchPrompts();
    });

    if (elements.applyTemplate && elements.batchPromptInput && elements.templateValues) {
      elements.applyTemplate.addEventListener("click", function () {
        var template = elements.batchPromptInput.value.trim();
        var valuesText = elements.templateValues.value.trim();
        if (!template) {
          setStatus("待命", "先在批量提示词输入框中写好模板，再点「填充到输入框」。");
          elements.batchPromptInput.focus();
          return;
        }
        if (!valuesText) {
          setStatus("待命", "先在变量值框中填入每行的变量值。");
          elements.templateValues.focus();
          return;
        }
        var results = __APP.expandTemplateVars(template, valuesText);
        if (results.length === 0) {
          return;
        }
        elements.batchPromptInput.value = results.join("\n\n");
        persistBatchDraft();
        state.batchQueue = [];
        renderBatchQueue();
        updateTemplatePreview();
        setStatus("待命", "已展开 " + results.length + " 条提示词。检查无误后点击「开始批量」。");
      });
    }
    if (elements.templateValues) {
      elements.templateValues.addEventListener("input", updateTemplatePreview);
    }

    elements.modeButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setMode(button.dataset.mode);
      });
    });
    elements.taskModeButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setTaskMode(button.dataset.taskMode);
      });
    });

    elements.stopGenerateButton.addEventListener("click", stopCurrentGeneration);
    elements.randomGenerateButton.addEventListener("click", startRandomGeneration);

    elements.clearHistory.addEventListener("click", function () {
      resetConversation("记录已清空，准备新的创作。图片库仍保留。");
    });

    elements.clearChat.addEventListener("click", function () {
      resetConversation("对话已清空，可以开始新的生图会话。图片库仍保留。");
    });

    if (elements.lightbox) {
      elements.lightbox.addEventListener("click", function (event) {
        if (event.target && event.target.dataset.lightboxClose === "true") {
          closePreviewLightbox();
        }
      });
    }
    if (elements.lightboxClose) {
      elements.lightboxClose.addEventListener("click", closePreviewLightbox);
    }
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closePreviewLightbox();
      }
    });

    window.addEventListener("beforeunload", function (event) {
      if (state.generating) {
        event.preventDefault();
      }
    });
    document.querySelectorAll(".nav-link, .ghost-link").forEach(function (link) {
      link.addEventListener("click", function (event) {
        if (state.generating) {
          var confirmed = window.confirm("正在生成图片中，离开后当前生成会被中断。确定离开吗？");
          if (!confirmed) {
            event.preventDefault();
          }
        }
      });
    });

    elements.composer.addEventListener("submit", onSubmit);

    // ======== 账号系统事件绑定 ========
    // 顶部账号按钮
    elements.accountUserBtn.addEventListener("click", openAccountModal);

    // 关闭弹窗
    elements.accountModalClose.addEventListener("click", closeAccountModal);
    elements.accountModalOverlay.addEventListener("click", function (event) {
      if (event.target === elements.accountModalOverlay) {
        closeAccountModal();
      }
    });

    // 切换面板
    elements.switchToRegister.addEventListener("click", function () {
      showAccountPanel("register");
    });
    elements.switchToLogin.addEventListener("click", function () {
      showAccountPanel("login");
    });

    // 注册
    elements.registerSubmit.addEventListener("click", handleRegister);
    elements.registerPassword.addEventListener("keydown", function (event) {
      if (event.key === "Enter") handleRegister();
    });

    // 登录
    elements.loginSubmit.addEventListener("click", handleLogin);
    elements.loginPassword.addEventListener("keydown", function (event) {
      if (event.key === "Enter") handleLogin();
    });

    // 个人中心
    elements.profileSave.addEventListener("click", handleProfileSave);
    elements.logoutBtn.addEventListener("click", handleLogout);

    // ESC 关闭弹窗
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !elements.accountModalOverlay.hidden) {
        closeAccountModal();
      }
    });

    /**
     * 用户从设置页返回或切回首页时，重新拉取最新通道配置并校验当前模型
     * 避免在设置页禁用/删除通道后，首页仍使用已失效的模型导致请求发错
     */
    function refreshModelOptionsOnReturn() {
      // renderSelectOptions() 重渲染 innerHTML 后所有 select 值会被重置为第一个选项，
      // 必须在调用前保存全部当前值，调用后再恢复
      var previousModel = elements.modelName.value;
      var previousAspectRatio = elements.aspectRatio.value;
      var previousImageQuality = elements.imageQuality.value;
      var previousStyleTemplate = elements.styleTemplate.value;
      var previousImageCount = elements.imageCount.value;

      renderSelectOptions();

      // 恢复 modelName（需要校验通道是否仍然可用）
      var validModel = normalizeCurrentModel(previousModel);
      elements.modelName.value = validModel;

      // 恢复其余四个 select 的值（用户之前选了什么就保持什么）
      elements.aspectRatio.value = previousAspectRatio;
      elements.imageQuality.value = previousImageQuality;
      elements.styleTemplate.value = previousStyleTemplate;
      elements.imageCount.value = previousImageCount;
      if (previousModel !== validModel) {
        persistModel();
        syncModelHelpText();
      } else {
        // 模型未变，但 renderSelectOptions 已重置 select 值，需要恢复帮助文案
        syncModelHelpText();
      }
      syncApiFields();
      if (previousModel !== elements.modelName.value) {
        console.log("[refreshModelOptionsOnReturn] 当前模型从 " + previousModel + " 切换为 " + elements.modelName.value);
      }
    }

    window.addEventListener("pageshow", function (event) {
      // pageshow 在首次加载和从 bfcache 恢复时都会触发，需排除正在生成的情况
      if (!state.generating) {
        refreshModelOptionsOnReturn();
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && !state.generating) {
        refreshModelOptionsOnReturn();
      }
    });

    /**
     * 监听 localStorage 中通道配置的变化（设置页保存时会触发）
     * 这样即使用户通过 target="_blank" 打开设置页，保存后首页也能自动刷新模型列表
     */
    window.addEventListener("storage", function (event) {
      if (event.key === __APP.STORAGE_KEYS.imageChannels && !state.generating) {
        console.log("[storage] imageChannels 已更新，刷新模型列表");
        refreshModelOptionsOnReturn();
      }
    });
  }

  // ============================================================
  //  模拟账号系统
  // ============================================================

  /**
   * 从 localStorage 读取账号注册信息
   * @returns {Object|null} 账号对象 { nickname, email, password, createdAt } 或 null
   */
  function getStoredAccount() {
    try {
      var raw = window.localStorage.getItem(__APP.STORAGE_KEYS.account);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /** 保存账号注册信息到 localStorage */
  function saveStoredAccount(account) {
    window.localStorage.setItem(__APP.STORAGE_KEYS.account, JSON.stringify(account));
  }

  /** 检查当前是否处于登录状态 */
  function isLoggedIn() {
    return state.currentAccount !== null;
  }

  /**
   * 获取用户昵称的首字作为头像文字
   * @param {string} nickname
   * @returns {string} 首字
   */
  function getAvatarChar(nickname) {
    return nickname ? nickname.charAt(0).toUpperCase() : "?";
  }

  /**
   * 更新顶部账号按钮的 UI
   */
  function renderAccountUI() {
    var account = state.currentAccount;
    if (account) {
      elements.accountAvatar.textContent = getAvatarChar(account.nickname);
      elements.accountNickname.textContent = account.nickname;
      elements.accountUserBtn.title = "点击管理账号";
    } else {
      elements.accountAvatar.textContent = "?";
      elements.accountNickname.textContent = "登录";
      elements.accountUserBtn.title = "点击登录或注册";
    }
  }

  /**
   * 重新渲染所有消息（用于昵称变更后刷新对话区的角色名）
   */
  function reRenderMessages() {
    renderMessages();
    renderHistorySummary();
  }

  /**
   * 获取当前用户在对话中显示的名称
   * @returns {string} 昵称或 "你"
   */
  function getUserDisplayName() {
    return state.currentAccount ? state.currentAccount.nickname : "你";
  }

  /**
   * 切换弹窗面板
   * @param {string} panelId - "login" | "register" | "profile"
   */
  function showAccountPanel(panelId) {
    elements.loginPanel.hidden = panelId !== "login";
    elements.registerPanel.hidden = panelId !== "register";
    elements.profilePanel.hidden = panelId !== "profile";
    // 清空错误提示
    if (elements.loginError) elements.loginError.hidden = true;
    if (elements.registerError) elements.registerError.hidden = true;
    if (elements.profileError) elements.profileError.hidden = true;
  }

  /** 打开账号弹窗 */
  function openAccountModal() {
    if (isLoggedIn()) {
      // 已登录 → 显示个人中心
      var account = state.currentAccount;
      elements.profileNicknameDisp.textContent = account.nickname;
      elements.profileEmailDisp.textContent = account.email;
      elements.profileAvatar.textContent = getAvatarChar(account.nickname);
      elements.profileNickname.value = account.nickname;
      elements.profilePassword.value = "";
      showAccountPanel("profile");
    } else {
      // 未登录 → 显示登录
      elements.loginEmail.value = "";
      elements.loginPassword.value = "";
      showAccountPanel("login");
    }
    elements.accountModalOverlay.hidden = false;
  }

  /** 关闭账号弹窗 */
  function closeAccountModal() {
    elements.accountModalOverlay.hidden = true;
  }

  /** 注册逻辑 */
  function handleRegister() {
    var nickname = (elements.registerNickname.value || "").trim();
    var email = (elements.registerEmail.value || "").trim();
    var password = elements.registerPassword.value;

    // 校验
    if (!nickname) {
      elements.registerError.textContent = "请输入昵称";
      elements.registerError.hidden = false;
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      elements.registerError.textContent = "请输入有效的邮箱地址";
      elements.registerError.hidden = false;
      return;
    }
    if (!password || password.length < 6) {
      elements.registerError.textContent = "密码至少需要 6 位";
      elements.registerError.hidden = false;
      return;
    }

    // 检查邮箱是否已被注册
    var existing = getStoredAccount();
    if (existing && existing.email === email) {
      elements.registerError.textContent = "该邮箱已被注册，请直接登录";
      elements.registerError.hidden = false;
      return;
    }

    var account = {
      nickname: nickname,
      email: email,
      password: password,
      createdAt: Date.now()
    };
    saveStoredAccount(account);
    state.currentAccount = account;
    renderAccountUI();
    reRenderMessages();
    closeAccountModal();
  }

  /** 登录逻辑 */
  function handleLogin() {
    var email = (elements.loginEmail.value || "").trim();
    var password = elements.loginPassword.value;

    if (!email) {
      elements.loginError.textContent = "请输入邮箱";
      elements.loginError.hidden = false;
      return;
    }
    if (!password) {
      elements.loginError.textContent = "请输入密码";
      elements.loginError.hidden = false;
      return;
    }

    var account = getStoredAccount();
    if (!account) {
      elements.loginError.textContent = "账号不存在，请先注册";
      elements.loginError.hidden = false;
      return;
    }
    if (account.email !== email) {
      elements.loginError.textContent = "邮箱不正确";
      elements.loginError.hidden = false;
      return;
    }
    if (account.password !== password) {
      elements.loginError.textContent = "密码不正确";
      elements.loginError.hidden = false;
      return;
    }

    state.currentAccount = account;
    renderAccountUI();
    reRenderMessages();
    closeAccountModal();
  }

  /** 退出登录（保留 localStorage 中的注册数据，只清当前会话状态） */
  function handleLogout() {
    state.currentAccount = null;
    renderAccountUI();
    reRenderMessages();
    closeAccountModal();
  }

  /** 保存个人资料修改 */
  function handleProfileSave() {
    var account = state.currentAccount;
    if (!account) return;

    var newNickname = (elements.profileNickname.value || "").trim();
    var newPassword = elements.profilePassword.value;

    if (!newNickname) {
      elements.profileError.textContent = "昵称不能为空";
      elements.profileError.hidden = false;
      return;
    }
    if (newPassword && newPassword.length < 6) {
      elements.profileError.textContent = "新密码至少需要 6 位";
      elements.profileError.hidden = false;
      return;
    }

    account.nickname = newNickname;
    if (newPassword) {
      account.password = newPassword;
    }
    saveStoredAccount(account);
    renderAccountUI();
    reRenderMessages();
    closeAccountModal();
  }

  function init() {
    renderSelectOptions();
    var storedModel = __APP.normalizeModelValue(window.localStorage.getItem(__APP.STORAGE_KEYS.model) || __APP.DEFAULT_MODEL);
    var initialModel = __APP.getModelOptions().some(function (item) { return item.value === storedModel; }) ? storedModel : normalizeCurrentModel(storedModel);
    elements.modelName.value = initialModel;
    persistModel();

    elements.promptInput.value = window.localStorage.getItem(__APP.STORAGE_KEYS.draft) || "";
    elements.batchPromptInput.value = window.localStorage.getItem(__APP.STORAGE_KEYS.batchDraft) || "";
    elements.aspectRatio.value = window.localStorage.getItem(__APP.STORAGE_KEYS.aspectRatio) || "1:1";
    elements.imageQuality.value = __APP.normalizeImageQuality(window.localStorage.getItem(__APP.STORAGE_KEYS.imageQuality) || "2K");
    elements.styleTemplate.value = window.localStorage.getItem(__APP.STORAGE_KEYS.styleTemplate) || "none";
    elements.imageCount.value = window.localStorage.getItem(__APP.STORAGE_KEYS.imageCount) || "1";

    if (!Array.isArray(state.history) || state.history.length === 0) {
      state.history = [createIntroMessage("这里会保存你的生成记录。先输入 API Key，再写提示词开始第一轮创作。")];
    }

    syncModelHelpText();
    syncApiFields();
    setMode(state.mode);
    setTaskMode(state.taskMode);
    initPreviewPanelCollapse();
    initResizeHandle();
    initVerticalResizeHandle();
    syncGenerationControls();
    renderMessages();
    renderHistorySummary();
    bindEvents();

    if (window.location.protocol === "file:") {
      setStatus("待命", "请通过 start.bat 启动工具箱，这样图片才能自动写入本地电脑。");
      return;
    }

    // API Key 统一从动态生图通道读取，不再按旧分类 key 区分
    var hasApiKey = getStoredApiKey().length > 0;
    setStatus(
      hasApiKey ? "已连接" : "待命",
      hasApiKey
        ? "API Key 与" + getRequestChannelLabel() + "已就绪，可以开始创作"
        : "先填写 API Key，再输入提示词"
    );

    // 初始化账号系统：如果 localStorage 中已有账号数据，自动恢复登录状态
    var storedAccount = getStoredAccount();
    if (storedAccount && storedAccount.email && storedAccount.password) {
      state.currentAccount = storedAccount;
    }
    renderAccountUI();
  }

  init();
})();
