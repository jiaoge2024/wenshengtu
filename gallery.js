(function () {
  const API_ENDPOINT = "/api/image-studio/gallery";
  const DELETE_ENDPOINT = "/api/image-studio/delete";
  const GALLERY_STORAGE_KEY = "jiaoge-ai-toolbox:image-gallery-v1";
  const HISTORY_STORAGE_KEY = "jiaoge-ai-toolbox:image-history-v1";
  const ALL_RATIOS_LABEL = "全部比例";
  const FALLBACK_MESSAGE = "还没有可展示的图片。先回到图生图长 · AI创作台生成几张图。";

  const elements = {
    masonry: document.getElementById("masonry"),
    recordCount: document.getElementById("record-count"),
    imageCount: document.getElementById("image-count"),
    latestTime: document.getElementById("latest-time"),
    filter: document.getElementById("gallery-filter"),
    refresh: document.getElementById("refresh-gallery"),
    template: document.getElementById("gallery-card-template"),
    lightbox: document.getElementById("gallery-lightbox"),
    lightboxImage: document.getElementById("lightbox-image"),
    lightboxCaption: document.getElementById("lightbox-caption"),
    lightboxClose: document.getElementById("lightbox-close"),
    selectionSummary: document.getElementById("selection-summary"),
    selectVisibleRecords: document.getElementById("select-visible-records"),
    clearSelection: document.getElementById("clear-selection"),
    deleteSelectedRecords: document.getElementById("delete-selected-records")
  };

  const state = {
    records: [],
    selectedRecordIds: new Set()
  };

  let resizeTimer = null;

  function normalizeRecordId(value) {
    return String(value || "").trim();
  }

  function getRecordId(record) {
    return normalizeRecordId(record && record.id);
  }

  function formatTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return "-";
    }
    return new Date(timestamp).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDurationSeconds(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) {
      return "";
    }
    return `${value.toFixed(1).replace(/\.0$/, "")} 秒`;
  }

  function parseStorage(key) {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function writeStorage(key, records) {
    try {
      window.localStorage.setItem(key, JSON.stringify(records));
    } catch (error) {
    }
  }

  async function loadServerRecords() {
    if (window.location.protocol === "file:") {
      return null;
    }

    try {
      const response = await fetch(API_ENDPOINT, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        return null;
      }
      return Array.isArray(data.records) ? data.records : [];
    } catch (error) {
      return null;
    }
  }

  async function getImageRecords() {
    const serverRecords = await loadServerRecords();
    if (serverRecords) {
      const localRecords = parseStorage(GALLERY_STORAGE_KEY).slice().reverse();
      const seenIds = new Set(serverRecords.map((item) => getRecordId(item)).filter(Boolean));
      const missingLocalRecords = localRecords.filter((item) => {
        const recordId = getRecordId(item);
        return recordId && !seenIds.has(recordId);
      });
      return serverRecords.concat(missingLocalRecords);
    }

    const legacyGallery = parseStorage(GALLERY_STORAGE_KEY);
    if (legacyGallery.length > 0) {
      return legacyGallery.slice().reverse();
    }

    return parseStorage(HISTORY_STORAGE_KEY)
      .filter((item) => Array.isArray(item.images) && item.images.length > 0)
      .slice()
      .reverse();
  }

  function removeRecordsFromLocalStorage(recordIds) {
    const idSet = new Set(recordIds.map(normalizeRecordId).filter(Boolean));
    if (idSet.size === 0) {
      return;
    }

    [GALLERY_STORAGE_KEY, HISTORY_STORAGE_KEY].forEach((key) => {
      const records = parseStorage(key);
      const next = records.filter((item) => !idSet.has(normalizeRecordId(item && item.id)));
      if (next.length !== records.length) {
        writeStorage(key, next);
      }
    });
  }

  async function requestDeleteRecordIds(recordIds) {
    const normalizedIds = Array.from(new Set(recordIds.map(normalizeRecordId).filter(Boolean)));
    if (normalizedIds.length === 0) {
      return { removedIds: [] };
    }

    if (window.location.protocol === "file:") {
      removeRecordsFromLocalStorage(normalizedIds);
      return { removedIds: normalizedIds };
    }

    const response = await fetch(DELETE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: normalizedIds })
    });
    const data = await response.json().catch(function () {
      return null;
    });
    if (!response.ok || !data || !data.ok) {
      if (response.status === 404 || response.status === 405) {
        throw new Error("本地服务还是旧版本，缺少图片记录删除接口。请重新双击 start.bat 启动。");
      }
      throw new Error(data && data.error ? data.error : `删除记录失败（${response.status} ${response.statusText}）`);
    }

    removeRecordsFromLocalStorage(normalizedIds);
    return data;
  }

  async function deleteRecord(recordId) {
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedId) {
      return;
    }

    const shouldDelete = window.confirm("确定只删除这条记录吗？本地图片文件会保留。");
    if (!shouldDelete) {
      return;
    }

    try {
      await requestDeleteRecordIds([normalizedId]);
      state.selectedRecordIds.delete(normalizedId);
      await renderCards();
    } catch (error) {
      window.alert(error && error.message ? error.message : "删除记录失败");
    }
  }

  async function deleteSelectedRecords() {
    const selectedIds = Array.from(state.selectedRecordIds);
    if (selectedIds.length === 0) {
      return;
    }

    const shouldDelete = window.confirm(`确定批量删除已选中的 ${selectedIds.length} 条记录吗？本地图片文件会保留。`);
    if (!shouldDelete) {
      return;
    }

    try {
      await requestDeleteRecordIds(selectedIds);
      state.selectedRecordIds.clear();
      await renderCards();
    } catch (error) {
      window.alert(error && error.message ? error.message : "批量删除记录失败");
    }
  }

  function getAspectOptions(records) {
    const values = Array.from(new Set(records.map((item) => item.aspectRatio).filter(Boolean)));
    return [ALL_RATIOS_LABEL].concat(values);
  }

  function getVisibleRecords() {
    const filterValue = elements.filter.value || ALL_RATIOS_LABEL;
    return filterValue === ALL_RATIOS_LABEL
      ? state.records.slice()
      : state.records.filter((item) => item.aspectRatio === filterValue);
  }

  function pruneSelection(records) {
    const validIds = new Set(records.map(getRecordId).filter(Boolean));
    state.selectedRecordIds = new Set(Array.from(state.selectedRecordIds).filter((id) => validIds.has(id)));
  }

  function renderFilter(records) {
    const options = getAspectOptions(records);
    const current = elements.filter.value || ALL_RATIOS_LABEL;
    elements.filter.innerHTML = options.map((value) => `<option value="${value}">${value}</option>`).join("");
    elements.filter.value = options.includes(current) ? current : ALL_RATIOS_LABEL;
  }

  function renderStats(records) {
    const imageCount = records.reduce((total, item) => total + item.images.length, 0);
    elements.recordCount.textContent = String(records.length);
    elements.imageCount.textContent = String(imageCount);
    elements.latestTime.textContent = records.length > 0 ? formatTime(records[0].time) : "-";
  }

  function updateSelectionSummary(visibleRecords) {
    const visibleIds = new Set(visibleRecords.map(getRecordId).filter(Boolean));
    let visibleSelectedCount = 0;
    state.selectedRecordIds.forEach((id) => {
      if (visibleIds.has(id)) {
        visibleSelectedCount += 1;
      }
    });

    if (state.selectedRecordIds.size === 0) {
      elements.selectionSummary.textContent = "未选中记录";
    } else if (state.selectedRecordIds.size === visibleSelectedCount) {
      elements.selectionSummary.textContent = `已选 ${state.selectedRecordIds.size} 条记录`;
    } else {
      elements.selectionSummary.textContent = `当前筛选已选 ${visibleSelectedCount} / ${state.selectedRecordIds.size} 条记录`;
    }

    elements.selectVisibleRecords.disabled = visibleRecords.length === 0;
    elements.clearSelection.disabled = state.selectedRecordIds.size === 0;
    elements.deleteSelectedRecords.disabled = state.selectedRecordIds.size === 0;
  }

  function syncSelectionCheckboxes(recordId) {
    elements.masonry.querySelectorAll(".record-select").forEach((input) => {
      if (recordId && input.dataset.recordId !== recordId) {
        return;
      }
      const selected = state.selectedRecordIds.has(input.dataset.recordId);
      input.checked = selected;
      const card = input.closest(".gallery-card");
      if (card) {
        card.classList.toggle("is-selected", selected);
      }
    });
  }

  function setRecordSelected(recordId, selected) {
    const normalizedId = normalizeRecordId(recordId);
    if (!normalizedId) {
      return;
    }

    if (selected) {
      state.selectedRecordIds.add(normalizedId);
    } else {
      state.selectedRecordIds.delete(normalizedId);
    }

    syncSelectionCheckboxes(normalizedId);
    updateSelectionSummary(getVisibleRecords());
  }

  function selectVisibleRecords() {
    getVisibleRecords().forEach((record) => {
      const recordId = getRecordId(record);
      if (recordId) {
        state.selectedRecordIds.add(recordId);
      }
    });
    syncSelectionCheckboxes();
    updateSelectionSummary(getVisibleRecords());
  }

  function clearSelection() {
    state.selectedRecordIds.clear();
    syncSelectionCheckboxes();
    updateSelectionSummary(getVisibleRecords());
  }

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
      return false;
    }
  }

  function getPromptText(record) {
    return record.rawPrompt || record.prompt || "未命名提示词";
  }

  function openLightbox(src, alt, caption) {
    elements.lightboxImage.src = src;
    elements.lightboxImage.alt = alt || "放大预览图片";
    elements.lightboxCaption.textContent = caption || "";
    elements.lightbox.hidden = false;
    document.body.classList.add("lightbox-open");
    elements.lightboxClose.focus();
  }

  function closeLightbox() {
    if (elements.lightbox.hidden) {
      return;
    }

    elements.lightbox.hidden = true;
    document.body.classList.remove("lightbox-open");
    elements.lightboxImage.removeAttribute("src");
    elements.lightboxImage.alt = "";
    elements.lightboxCaption.textContent = "";
  }

  function syncPromptToggle(card) {
    const title = card.querySelector(".gallery-title");
    const toggle = card.querySelector(".prompt-toggle");
    if (!title || !toggle) {
      return;
    }

    const wasExpanded = card.dataset.promptExpanded === "true";
    title.classList.remove("is-expanded");
    toggle.hidden = true;
    toggle.textContent = "展开";

    const isOverflowing = title.scrollHeight > title.clientHeight + 2;
    if (!isOverflowing) {
      card.dataset.promptExpanded = "false";
      return;
    }

    toggle.hidden = false;
    if (wasExpanded) {
      title.classList.add("is-expanded");
      toggle.textContent = "收起";
    }
  }

  function syncAllPromptToggles() {
    elements.masonry.querySelectorAll(".gallery-card").forEach(syncPromptToggle);
  }

  async function renderCards() {
    state.records = await getImageRecords();
    pruneSelection(state.records);
    renderFilter(state.records);
    renderStats(state.records);

    const visibleRecords = getVisibleRecords();
    elements.masonry.innerHTML = "";
    updateSelectionSummary(visibleRecords);

    if (visibleRecords.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel empty-state";
      empty.textContent = FALLBACK_MESSAGE;
      elements.masonry.appendChild(empty);
      return;
    }

    visibleRecords.forEach((record) => {
      const recordId = getRecordId(record);
      record.images.forEach((src, index) => {
        const fragment = elements.template.content.cloneNode(true);
        const card = fragment.querySelector(".gallery-card");
        const image = fragment.querySelector(".gallery-image");
        const ratio = fragment.querySelector(".ratio-pill");
        const style = fragment.querySelector(".style-pill");
        const title = fragment.querySelector(".gallery-title");
        const time = fragment.querySelector(".gallery-time");
        const download = fragment.querySelector(".download-link");
        const copyPrompt = fragment.querySelector(".copy-prompt-button");
        const deleteRecordButton = fragment.querySelector(".delete-record-button");
        const editButton = fragment.querySelector(".edit-image-button");
        const promptToggle = fragment.querySelector(".prompt-toggle");
        const recordSelect = fragment.querySelector(".record-select");
        const promptText = getPromptText(record);
        const selected = state.selectedRecordIds.has(recordId);

        card.dataset.recordId = recordId;
        card.dataset.promptExpanded = "false";
        card.classList.toggle("is-selected", selected);
        image.src = src;
        image.alt = promptText || `生成图片 ${index + 1}`;
        image.addEventListener("click", function () {
          openLightbox(src, image.alt, promptText);
        });
        ratio.textContent = record.aspectRatio || "未记录比例";
        style.textContent = record.styleTemplateLabel || "未记录风格";
        title.textContent = promptText;
        time.textContent = record.generationDurationSeconds != null
          ? `${formatTime(record.time)} · 耗时 ${formatDurationSeconds(record.generationDurationSeconds)}`
          : formatTime(record.time);
        download.href = src;
        download.download = `image-studio-gallery-${recordId || "record"}-${index + 1}.png`;
        recordSelect.dataset.recordId = recordId;
        recordSelect.checked = selected;
        recordSelect.addEventListener("change", function () {
          setRecordSelected(recordId, recordSelect.checked);
        });

        promptToggle.addEventListener("click", function () {
          const expanded = !title.classList.contains("is-expanded");
          card.dataset.promptExpanded = expanded ? "true" : "false";
          title.classList.toggle("is-expanded", expanded);
          promptToggle.textContent = expanded ? "收起" : "展开";
        });

        copyPrompt.addEventListener("click", async function () {
          const success = await copyText(promptText);
          const originalText = copyPrompt.textContent;
          copyPrompt.textContent = success ? "已复制" : "复制失败";
          window.setTimeout(function () {
            copyPrompt.textContent = originalText;
          }, 1200);
        });

        deleteRecordButton.addEventListener("click", async function () {
          await deleteRecord(recordId);
        });

        editButton.addEventListener("click", function () {
          window.localStorage.setItem("jiaoge-ai-toolbox:pending-edit-src", src);
          window.location.href = "./index.html";
        });

        elements.masonry.appendChild(fragment);
        window.requestAnimationFrame(function () {
          syncPromptToggle(card);
        });
      });
    });
  }

  elements.filter.addEventListener("change", function () {
    renderCards();
  });

  elements.refresh.addEventListener("click", function () {
    renderCards();
  });

  elements.selectVisibleRecords.addEventListener("click", function () {
    selectVisibleRecords();
  });

  elements.clearSelection.addEventListener("click", function () {
    clearSelection();
  });

  elements.deleteSelectedRecords.addEventListener("click", async function () {
    await deleteSelectedRecords();
  });

  elements.lightbox.addEventListener("click", function (event) {
    if (event.target === elements.lightbox || event.target.classList.contains("lightbox-backdrop")) {
      closeLightbox();
    }
  });

  elements.lightboxClose.addEventListener("click", function () {
    closeLightbox();
  });

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeLightbox();
    }
  });

  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(syncAllPromptToggles, 120);
  });

  renderCards();
})();
