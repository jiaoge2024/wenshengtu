(function () {
  const ALL_CATEGORY = "全部";
  const FAVORITE_CATEGORY = "收藏";
  const DEFAULT_CATEGORY = "未分类";
  const EMPTY_MESSAGE = "还没有提示词。点击「新增提示词」开始建立你的提示词库，或在生成记录中点击「收藏提示词」直接收藏。";

  const elements = {
    grid: document.getElementById("prompts-grid"),
    search: document.getElementById("prompt-search"),
    chips: document.getElementById("category-chips"),
    addButton: document.getElementById("add-prompt"),
    exportButton: document.getElementById("export-prompts"),
    importButton: document.getElementById("import-prompts"),
    importFile: document.getElementById("import-prompts-file"),
    modal: document.getElementById("prompt-modal"),
    modalTitle: document.getElementById("prompt-modal-title"),
    modalClose: document.getElementById("prompt-modal-close"),
    form: document.getElementById("prompt-form"),
    promptId: document.getElementById("prompt-id"),
    promptName: document.getElementById("prompt-name"),
    tagInputWrap: document.getElementById("tag-input-wrap"),
    tagChips: document.getElementById("tag-chips"),
    tagTextInput: document.getElementById("prompt-category-input"),
    promptContent: document.getElementById("prompt-content"),
    categoryList: document.getElementById("category-list"),
    template: document.getElementById("prompt-card-template")
  };

  const state = {
    currentCategory: ALL_CATEGORY,
    searchQuery: "",
    tags: [] // 当前弹窗中已添加的分类标签
  };

  /**
   * 将文本复制到剪贴板
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copyText(text) {
    if (!text) {
      return false;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.error("[copyText] 剪贴板写入失败", error);
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      return copied;
    } catch (error) {
      console.error("[copyText] fallback 复制失败", error);
      return false;
    }
  }

  /**
   * 从 localStorage 加载全部提示词
   * @returns {Array}
   */
  function loadPrompts() {
    return __APP.getPromptLibrary();
  }

  /**
   * 获取用于分类筛选和候选列表的分类集合
   * @returns {Array<string>}
   */
  function getAllCategories() {
    const fromLibrary = __APP.getPromptLibraryCategories();
    const defaults = Array.isArray(__APP.PROMPT_LIBRARY_DEFAULT_CATEGORIES)
      ? __APP.PROMPT_LIBRARY_DEFAULT_CATEGORIES
      : [];
    const combined = defaults.concat(fromLibrary);
    return Array.from(new Set(combined))
      .filter(Boolean)
      .sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
  }

  /**
   * 计算某个分类下的提示词数量
   * @param {Array} prompts
   * @param {string} category
   * @returns {number}
   */
  function getCategoryCount(prompts, category) {
    if (category === FAVORITE_CATEGORY) {
      return prompts.filter(function (item) { return item.isFavorite; }).length;
    }
    if (category === ALL_CATEGORY) {
      return prompts.length;
    }
    return prompts.filter(function (item) {
      return __APP.matchesCategory(item, category);
    }).length;
  }

  /**
   * 渲染分类筛选 chips
   */
  function renderCategories() {
    const prompts = loadPrompts();
    const categories = getAllCategories().filter(function (cat) {
      if (cat === ALL_CATEGORY || cat === FAVORITE_CATEGORY) {
        return false;
      }
      // 只显示有提示词的分类，避免空分类占用空间
      return getCategoryCount(prompts, cat) > 0;
    });

    elements.chips.innerHTML = "";

    // 全部
    const allChip = createChip(ALL_CATEGORY, getCategoryCount(prompts, ALL_CATEGORY), state.currentCategory === ALL_CATEGORY);
    elements.chips.appendChild(allChip);

    // 收藏
    const favoriteChip = createChip(FAVORITE_CATEGORY, getCategoryCount(prompts, FAVORITE_CATEGORY), state.currentCategory === FAVORITE_CATEGORY);
    elements.chips.appendChild(favoriteChip);

    // 各分类
    categories.forEach(function (category) {
      const chip = createChip(category, getCategoryCount(prompts, category), state.currentCategory === category);
      elements.chips.appendChild(chip);
    });

    // 更新 datalist
    elements.categoryList.innerHTML = categories.map(function (category) {
      return "<option value=\"" + category + "\"></option>";
    }).join("");
  }

  /**
   * 创建一个分类 chip 按钮
   * @param {string} category
   * @param {number} count
   * @param {boolean} isActive
   * @returns {HTMLButtonElement}
   */
  function createChip(category, count, isActive) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-chip" + (isActive ? " is-active" : "");
    button.dataset.category = category;
    button.textContent = category + " ";
    const countSpan = document.createElement("span");
    countSpan.className = "chip-count";
    countSpan.textContent = String(count);
    button.appendChild(countSpan);
    button.addEventListener("click", function () {
      state.currentCategory = category;
      renderCategories();
      renderCards();
    });
    return button;
  }

  /**
   * 渲染提示词卡片网格
   */
  function renderCards() {
    const filtered = __APP.filterPromptLibrary({
      query: state.searchQuery,
      category: state.currentCategory
    });

    elements.grid.innerHTML = "";

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel empty-state";
      empty.textContent = EMPTY_MESSAGE;
      elements.grid.appendChild(empty);
      return;
    }

    filtered.forEach(function (prompt) {
      const fragment = elements.template.content.cloneNode(true);
      const card = fragment.querySelector(".prompt-card");
      const title = fragment.querySelector(".prompt-card-title");
      const text = fragment.querySelector(".prompt-card-text");
      const categoriesContainer = fragment.querySelector(".prompt-card-categories");
      const favoriteBtn = fragment.querySelector(".prompt-favorite");
      const copyBtn = fragment.querySelector(".copy-prompt-button");
      const editBtn = fragment.querySelector(".edit-prompt-button");
      const deleteBtn = fragment.querySelector(".delete-prompt-button");

      card.dataset.promptId = prompt.id;
      title.textContent = prompt.name || "未命名提示词";
      text.textContent = prompt.content || "";

      // 渲染多分类标签
      var cats = __APP.getItemCategories(prompt);
      categoriesContainer.innerHTML = "";
      cats.forEach(function (cat) {
        var pill = document.createElement("span");
        pill.className = "meta-pill";
        pill.textContent = cat;
        categoriesContainer.appendChild(pill);
      });

      favoriteBtn.classList.toggle("is-active", Boolean(prompt.isFavorite));
      favoriteBtn.setAttribute("aria-pressed", String(Boolean(prompt.isFavorite)));

      favoriteBtn.addEventListener("click", function () {
        toggleFavorite(prompt.id, favoriteBtn);
      });

      copyBtn.addEventListener("click", async function () {
        const success = await copyText(prompt.content);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = success ? "已复制" : "复制失败";
        window.setTimeout(function () {
          copyBtn.textContent = originalText;
        }, 1200);
      });

      editBtn.addEventListener("click", function () {
        openModal(prompt);
      });

      deleteBtn.addEventListener("click", function () {
        deletePrompt(prompt.id);
      });

      elements.grid.appendChild(fragment);
    });
  }

  /**
   * 切换提示词收藏状态
   * @param {string} id
   * @param {HTMLButtonElement} button
   */
  function toggleFavorite(id, button) {
    try {
      const item = __APP.togglePromptFavorite(id);
      if (!item) {
        return;
      }
      button.classList.toggle("is-active", item.isFavorite);
      button.setAttribute("aria-pressed", String(item.isFavorite));
      renderCategories();
    } catch (error) {
      console.error("[toggleFavorite] 收藏切换失败", error);
      window.alert("收藏切换失败：" + (error && error.message ? error.message : "未知错误"));
    }
  }

  /**
   * 删除提示词
   * @param {string} id
   */
  function deletePrompt(id) {
    const item = __APP.getPromptLibrary().find(function (p) { return p.id === id; });
    const name = item ? item.name : "这条提示词";
    if (!window.confirm("确定删除「" + name + "」吗？删除后不可恢复。")) {
      return;
    }

    try {
      __APP.deletePromptFromLibrary(id);
      renderCategories();
      renderCards();
    } catch (error) {
      console.error("[deletePrompt] 删除失败", error);
      window.alert("删除失败：" + (error && error.message ? error.message : "未知错误"));
    }
  }

  /**
   * 渲染标签 chips 到弹窗输入区
   */
  function renderTagChips() {
    if (!elements.tagChips) return;
    elements.tagChips.innerHTML = "";
    state.tags.forEach(function (tag, index) {
      var chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = tag;

      var removeBtn = document.createElement("button");
      removeBtn.className = "tag-chip-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.setAttribute("aria-label", "移除标签 " + tag);
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        removeTag(index);
      });

      chip.appendChild(removeBtn);
      elements.tagChips.appendChild(chip);
    });
  }

  /**
   * 添加一个标签（去重、去空白）
   * @param {string} raw
   */
  function addTag(raw) {
    var value = String(raw || "").replace(/[,，;；\s]+/g, "").trim();
    if (!value) return;
    if (state.tags.indexOf(value) !== -1) return;
    state.tags.push(value);
    renderTagChips();
  }

  /**
   * 移除指定位置的标签
   * @param {number} index
   */
  function removeTag(index) {
    if (index < 0 || index >= state.tags.length) return;
    state.tags.splice(index, 1);
    renderTagChips();
  }

  /**
   * 清空所有标签
   */
  function clearTags() {
    state.tags = [];
    renderTagChips();
  }

  /**
   * 处理标签输入框的键盘事件
   * @param {KeyboardEvent} event
   */
  function handleTagInputKeydown(event) {
    var input = elements.tagTextInput;
    if (!input) return;

    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(input.value);
      input.value = "";
      return;
    }

    if (event.key === "Backspace" && input.value === "" && state.tags.length > 0) {
      event.preventDefault();
      removeTag(state.tags.length - 1);
      return;
    }
  }

  /**
   * 处理标签输入框失焦（把当前输入内容转为标签）
   */
  function handleTagInputBlur() {
    var input = elements.tagTextInput;
    if (!input) return;
    if (input.value.trim()) {
      addTag(input.value);
      input.value = "";
    }
  }

  /**
   * 点击标签容器外层时聚焦输入框
   */
  function handleTagWrapClick(event) {
    if (event.target === elements.tagInputWrap || event.target === elements.tagChips) {
      if (elements.tagTextInput) {
        elements.tagTextInput.focus();
      }
    }
  }

  /**
   * 打开新增/编辑弹窗
   * @param {Object} [prompt]
   */
  function openModal(prompt) {
    clearTags();

    if (prompt && prompt.id) {
      elements.modalTitle.textContent = "编辑提示词";
      elements.promptId.value = prompt.id;
      elements.promptName.value = prompt.name || "";
      elements.promptContent.value = prompt.content || "";
      // 加载已有分类标签
      var cats = __APP.getItemCategories(prompt);
      cats.forEach(function (c) { addTag(c); });
    } else {
      elements.modalTitle.textContent = "新增提示词";
      elements.promptId.value = "";
      elements.promptName.value = "";
      elements.promptContent.value = "";
      // 如果当前在某个具体分类下，预填该标签
      if (state.currentCategory !== ALL_CATEGORY && state.currentCategory !== FAVORITE_CATEGORY) {
        addTag(state.currentCategory);
      }
    }

    elements.modal.hidden = false;
    elements.promptName.focus();
  }

  /**
   * 关闭弹窗
   */
  function closeModal() {
    elements.modal.hidden = true;
    elements.form.reset();
    elements.promptId.value = "";
    clearTags();
    if (elements.tagTextInput) {
      elements.tagTextInput.value = "";
    }
  }

  /**
   * 保存提示词（新增或更新）
   * @param {Event} event
   */
  function handleSave(event) {
    event.preventDefault();

    const id = elements.promptId.value.trim();
    const name = elements.promptName.value.trim();
    const content = elements.promptContent.value.trim();

    if (!name) {
      window.alert("请输入提示词短名称");
      elements.promptName.focus();
      return;
    }
    if (!content) {
      window.alert("请输入提示词内容");
      elements.promptContent.focus();
      return;
    }

    try {
      if (id) {
        __APP.updatePromptInLibrary(id, { name: name, categories: state.tags, content: content });
      } else {
        __APP.addPromptToLibrary({ name: name, categories: state.tags, content: content });
      }
      closeModal();
      renderCategories();
      renderCards();
    } catch (error) {
      console.error("[handleSave] 保存失败", error);
      window.alert("保存失败：" + (error && error.message ? error.message : "未知错误"));
    }
  }

  /**
   * 搜索输入处理
   */
  function handleSearch() {
    state.searchQuery = elements.search.value.trim();
    renderCards();
  }

  /**
   * 导出当前提示词库为本地 JSON 文件
   */
  function handleExport() {
    try {
      const library = __APP.getPromptLibrary();
      if (!Array.isArray(library) || library.length === 0) {
        window.alert("当前提示词库为空，没有可导出的内容。");
        return;
      }
      __APP.downloadPromptLibrary();
      console.log("[handleExport] 已导出 " + library.length + " 条提示词");
    } catch (error) {
      console.error("[handleExport] 导出失败", error);
      window.alert("导出失败：" + (error && error.message ? error.message : "未知错误"));
    }
  }

  /**
   * 处理选中的 JSON 文件，解析并按用户选择合并或替换到当前库
   * @param {File} file
   */
  function handleImportFile(file) {
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = function (event) {
      try {
        const text = String(event.target && event.target.result || "");
        const incoming = __APP.parsePromptLibraryImport(text);
        const mode = window.confirm(
          "检测到 " + incoming.length + " 条提示词。\n\n" +
          "点击「确定」= 合并到当前库（已有 ID 会被覆盖，新增追加在前面）。\n" +
          "点击「取消」= 替换模式（清空当前库再导入，适合在新电脑首次使用）。"
        ) ? "merge" : "replace";
        const result = __APP.mergePromptLibrary(incoming, { mode: mode });
        console.log("[handleImport] 导入完成", result);
        window.alert(
          "导入完成。\n新增：" + result.added + " 条\n更新：" + result.updated + " 条\n当前共：" + result.total + " 条"
        );
        renderCategories();
        renderCards();
      } catch (error) {
        console.error("[handleImport] 导入失败", error);
        window.alert("导入失败：" + (error && error.message ? error.message : "未知错误"));
      }
    };
    reader.onerror = function () {
      console.error("[handleImport] 文件读取失败", reader.error);
      window.alert("文件读取失败");
    };
    reader.readAsText(file, "utf-8");
  }

  function bindEvents() {
    elements.addButton.addEventListener("click", function () {
      openModal();
    });

    // 导出按钮：直接触发本地下载
    if (elements.exportButton) {
      elements.exportButton.addEventListener("click", handleExport);
    }

    // 导入按钮：点击后通过隐藏的 file input 选择 JSON 文件
    if (elements.importButton && elements.importFile) {
      elements.importButton.addEventListener("click", function () {
        elements.importFile.value = ""; // 重置以便选择同名文件
        elements.importFile.click();
      });
      elements.importFile.addEventListener("change", function (event) {
        const file = event.target.files && event.target.files[0];
        handleImportFile(file);
      });
    }

    elements.modalClose.addEventListener("click", closeModal);
    elements.modal.addEventListener("click", function (event) {
      if (event.target === elements.modal || event.target.dataset.modalClose === "true") {
        closeModal();
      }
    });

    elements.form.addEventListener("submit", handleSave);

    elements.search.addEventListener("input", function () {
      window.clearTimeout(elements.search.__searchTimer);
      elements.search.__searchTimer = window.setTimeout(handleSearch, 180);
    });

    // 标签输入框事件
    if (elements.tagTextInput) {
      elements.tagTextInput.addEventListener("keydown", handleTagInputKeydown);
      elements.tagTextInput.addEventListener("blur", handleTagInputBlur);
    }
    if (elements.tagInputWrap) {
      elements.tagInputWrap.addEventListener("click", handleTagWrapClick);
    }

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !elements.modal.hidden) {
        closeModal();
      }
    });
  }

  function init() {
    renderCategories();
    renderCards();
    bindEvents();
  }

  init();
})();
