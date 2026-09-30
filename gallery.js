(function () {
  const API_ENDPOINT = "/api/image-studio/gallery";
  const DELETE_ENDPOINT = "/api/image-studio/delete";
  // localStorage 键（与 app-config.js 中的 STORAGE_KEYS 保持一致，使用通用命名空间）
  const GALLERY_STORAGE_KEY = "image-studio:image-gallery-v1";
  const HISTORY_STORAGE_KEY = "image-studio:image-history-v1";
  const ALL_RATIOS_LABEL = "全部比例";
  const FALLBACK_MESSAGE = "还没有可展示的图片。先回到图生图长 · AI创作台生成几张图。";

  const elements = {
    masonry: document.getElementById("masonry"),
    recordCount: document.getElementById("record-count"),
    imageCount: document.getElementById("image-count"),
    latestTime: document.getElementById("latest-time"),
    filter: document.getElementById("gallery-filter"),
    search: document.getElementById("gallery-search"),
    tagStatus: document.getElementById("tag-status"),
    refresh: document.getElementById("refresh-gallery"),
    openFolder: document.getElementById("open-local-folder"),
    template: document.getElementById("gallery-card-template"),
    lightbox: document.getElementById("gallery-lightbox"),
    lightboxImage: document.getElementById("lightbox-image"),
    lightboxCaption: document.getElementById("lightbox-caption"),
    lightboxClose: document.getElementById("lightbox-close"),
    selectionSummary: document.getElementById("selection-summary"),
    selectVisibleRecords: document.getElementById("select-visible-records"),
    clearSelection: document.getElementById("clear-selection"),
    deleteSelectedRecords: document.getElementById("delete-selected-records"),
    exportPdfSelected: document.getElementById("export-pdf-selected"),
    pdfUploadInput: document.getElementById("pdf-upload-input"),
    pdfUploadTrigger: document.getElementById("pdf-upload-trigger"),
    pdfExportBtn: document.getElementById("pdf-export-btn"),
    pdfClearBtn: document.getElementById("pdf-clear-btn"),
    pdfUploadThumbs: document.getElementById("pdf-upload-thumbs")
  };

  const state = {
    records: [],
    selectedRecordIds: new Set(),
    uploadedFiles: [],
    searchQuery: "",
    taggingBusy: false
  };

  // 每打完多少张标签就刷新一次卡片，避免大批量打标签时长时间不更新界面
  const TAG_RENDER_INTERVAL = 4;

  /**
   * 更新工具栏上的标签状态文字（如「AI 打标签中 2/10…」）
   * @param {string} text 状态文字，空串表示隐藏
   */
  function setTagStatus(text) {
    if (!elements.tagStatus) {
      return;
    }
    elements.tagStatus.textContent = text;
    elements.tagStatus.hidden = !text;
  }

  /**
   * 自动打标签：遍历还没有 tags 的记录，逐张调用「AI 助手模型」（需支持视觉）
   * 生成中文标签并持久化（服务端接口优先，失败回退 localStorage）
   */
  async function autoTagRecords() {
    if (state.taggingBusy) {
      return;
    }
    if (!window.__APP || typeof window.__APP.requestImageTags !== "function") {
      return;
    }
    const untagged = state.records.filter(
      (record) => !Array.isArray(record.tags) && getRecordId(record) && Array.isArray(record.images) && record.images[0]
    );
    if (untagged.length === 0) {
      return;
    }

    state.taggingBusy = true;
    let completed = 0;
    try {
      for (const record of untagged) {
        setTagStatus(`AI 打标签中 ${completed + 1}/${untagged.length}…`);
        try {
          const tags = await window.__APP.requestImageTags(record.images[0]);
          record.tags = tags;
          await window.__APP.updateGalleryRecordTags(getRecordId(record), tags);
        } catch (error) {
          console.warn("[gallery] 自动打标签失败", getRecordId(record), error);
          record.tags = [];
          // 助手模型未配置时直接中止整批，避免每张图都白等一次接口
          if (/未配置|API Key|模型名/.test(error && error.message)) {
            setTagStatus("自动打标签未启用：请先到设置页配置「AI 助手模型」");
            window.setTimeout(() => setTagStatus(""), 4000);
            return;
          }
        }
        completed += 1;
        if (completed % TAG_RENDER_INTERVAL === 0) {
          await renderCards();
        }
      }
      if (completed > 0) {
        setTagStatus(`已为 ${completed} 张图片打好标签 ✓`);
        window.setTimeout(() => setTagStatus(""), 2500);
      }
    } finally {
      state.taggingBusy = false;
      await renderCards();
    }
  }

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
      // 向后兼容：若新键不存在，尝试旧键（jiaoge-ai-toolbox:），并自动迁移到新键
      let raw = window.localStorage.getItem(key);
      if (raw === null && key.indexOf("image-studio:") === 0) {
        const legacyKey = "jiaoge-ai-toolbox:" + key.substring("image-studio:".length);
        raw = window.localStorage.getItem(legacyKey);
        if (raw !== null) {
          try { window.localStorage.setItem(key, raw); window.localStorage.removeItem(legacyKey); } catch (e) { /* ignore */ }
        }
      }
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

  /**
   * 判断记录是否命中搜索关键词：匹配标签、提示词、风格、模式、模型等字段
   * @param {Object} record 图库记录
   * @param {string} query 已转小写的关键词（空串视为命中）
   */
  function matchesSearch(record, query) {
    if (!query) {
      return true;
    }
    const parts = [];
    if (Array.isArray(record.tags) && record.tags.length > 0) {
      parts.push(record.tags.join(" "));
    }
    ["prompt", "rawPrompt", "styleTemplateLabel", "modeLabel", "model", "aspectRatio"].forEach((key) => {
      const value = record[key];
      if (typeof value === "string" && value) {
        parts.push(value);
      }
    });
    return parts.join(" ").toLowerCase().indexOf(query) !== -1;
  }

  function getVisibleRecords() {
    const filterValue = elements.filter.value || ALL_RATIOS_LABEL;
    const query = (state.searchQuery || "").trim().toLowerCase();
    return state.records.filter((item) => {
      if (filterValue !== ALL_RATIOS_LABEL && item.aspectRatio !== filterValue) {
        return false;
      }
      return matchesSearch(item, query);
    });
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

  // 选中提示弹出的自动隐藏计时器与上次选中数量（用于跳过页面初始渲染时的无意义提示）
  let selectionToastTimer = null;
  let lastSelectionCount = 0;

  /**
   * 以浮动轻提示短暂展示选中状态，不占用工具栏版面
   * @param {string} text 提示文字
   */
  function showSelectionToast(text) {
    if (!elements.selectionSummary) {
      return;
    }
    elements.selectionSummary.textContent = text;
    elements.selectionSummary.hidden = false;
    // 下一帧再加可见类，保证从隐藏到显示的过渡动画生效
    requestAnimationFrame(() => elements.selectionSummary.classList.add("is-visible"));
    clearTimeout(selectionToastTimer);
    selectionToastTimer = setTimeout(() => {
      elements.selectionSummary.classList.remove("is-visible");
      setTimeout(() => {
        elements.selectionSummary.hidden = true;
      }, 220);
    }, 2000);
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
      // 仅在「有选中 → 清空」时提示，避免页面初始渲染就弹出
      if (lastSelectionCount > 0) {
        showSelectionToast("已清空选择");
      }
    } else if (state.selectedRecordIds.size === visibleSelectedCount) {
      showSelectionToast(`已选 ${state.selectedRecordIds.size} 条记录`);
    } else {
      showSelectionToast(`当前筛选已选 ${visibleSelectedCount} / ${state.selectedRecordIds.size} 条记录`);
    }
    lastSelectionCount = state.selectedRecordIds.size;

    elements.selectVisibleRecords.disabled = visibleRecords.length === 0;
    elements.clearSelection.disabled = state.selectedRecordIds.size === 0;
    elements.deleteSelectedRecords.disabled = state.selectedRecordIds.size === 0;
    elements.exportPdfSelected.disabled = state.selectedRecordIds.size === 0;
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

  // ---- PDF 导出（纯前端实现，无需额外依赖，可离线使用） ----

  const PDF_MAX_PAGE_PT = 720; // 每页较长边对应的点（约 10 英寸）

  function encodeText(text) {
    return new TextEncoder().encode(text);
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      result.set(part, offset);
      offset += part.length;
    });
    return result;
  }

  // 将多个 JPEG 图片各自作为一页，组装成一个 PDF Blob
  function buildPdfBlob(jpegs) {
    const pageInfos = jpegs.map((jpeg) => {
      const scale = PDF_MAX_PAGE_PT / Math.max(jpeg.width, jpeg.height);
      const pw = Math.max(1, Math.round(jpeg.width * scale));
      const ph = Math.max(1, Math.round(jpeg.height * scale));
      return { pw, ph };
    });

    // 对象 1：Catalog；对象 2：Pages
    const objects = [];
    objects.push({
      content: encodeText("<< /Type /Catalog /Pages 2 0 R >>")
    });
    const kids = pageInfos.map((page, i) => `${3 + i * 3} 0 R`).join(" ");
    objects.push({
      content: encodeText(`<< /Type /Pages /Count ${pageInfos.length} /Kids [${kids}] >>`)
    });

    // 每个图片依次生成 Page / 图片 XObject / Content stream 三个对象
    pageInfos.forEach((page, i) => {
      const pageObjectId = 3 + i * 3;
      const imageObjectId = pageObjectId + 1;
      const contentObjectId = pageObjectId + 2;
      const jpeg = jpegs[i];

      objects.push({
        content: encodeText(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.pw} ${page.ph}] ` +
            `/Resources << /XObject << /Im${i} ${imageObjectId} 0 R >> >> ` +
            `/Contents ${contentObjectId} 0 R >>`
        )
      });

      const imgHeader = `<< /Type /XObject /Subtype /Image /Width ${jpeg.width} /Height ${jpeg.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.bytes.length} >>\nstream\n`;
      objects.push({
        content: concatBytes([encodeText(imgHeader), jpeg.bytes, encodeText("\nendstream")])
      });

      const streamText = `q\n${page.pw} 0 0 ${page.ph} 0 0 cm\n/Im${i} Do\nQ\n`;
      objects.push({
        content: encodeText(`<< /Length ${encodeText(streamText).length} >>\nstream\n${streamText}endstream`)
      });
    });

    // 组装 PDF：头部 + 对象 + xref + trailer
    const chunks = [];
    const offsets = [];
    let total = 0;
    const push = (data) => {
      const bytes = typeof data === "string" ? encodeText(data) : data;
      chunks.push(bytes);
      total += bytes.length;
    };

    push("%PDF-1.4\n");
    objects.forEach((obj, index) => {
      offsets.push(total);
      const prefix = `${index + 1} 0 obj\n`;
      push(prefix);
      push(obj.content);
      push("\nendobj\n");
    });
    const xrefStart = total;
    push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    offsets.forEach((offset) => {
      push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    });
    push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    return new Blob(chunks, { type: "application/pdf" });
  }

  // 从图片源（同源 URL 或 dataURL）推断 MIME 类型，空串表示无法识别
  function getImageMimeFromSrc(src) {
    const value = String(src || "");
    const dataUrlMatch = value.match(/^data:([^;,]+);base64,/);
    if (dataUrlMatch) {
      return String(dataUrlMatch[1]).toLowerCase();
    }
    const extMatch = value.toLowerCase().match(/\.(jpe?g|png|webp|gif|bmp)(\?|#|$)/);
    if (extMatch) {
      const ext = extMatch[1];
      if (ext === "jpg" || ext === "jpeg") {
        return "image/jpeg";
      }
      if (ext === "png") {
        return "image/png";
      }
      if (ext === "webp") {
        return "image/webp";
      }
      if (ext === "gif") {
        return "image/gif";
      }
      if (ext === "bmp") {
        return "image/bmp";
      }
    }
    return "";
  }

  function isJpegMime(mime) {
    return mime === "image/jpeg" || mime === "image/jpg";
  }

  // 获取图片源的原始字节（dataURL 直接解码，URL 则 fetch）
  function fetchRawBytes(src) {
    return new Promise((resolve, reject) => {
      if (/^data:/i.test(src)) {
        const base64 = String(src).split(",")[1];
        try {
          const binary = window.atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          resolve(bytes);
        } catch (error) {
          reject(error);
        }
        return;
      }
      fetch(src)
        .then(function (response) {
          if (!response.ok) {
            throw new Error("获取图片失败：" + response.status);
          }
          return response.arrayBuffer();
        })
        .then(function (arrayBuffer) {
          resolve(new Uint8Array(arrayBuffer));
        })
        .catch(reject);
    });
  }

  // 将图片源转为 JPEG 字节 + 尺寸。
  // 保真策略：原图若是 JPEG 直接复用原始字节（零有损压缩）；
  // 其余格式（PNG/WebP 等）经 canvas 高质量（0.95）转 JPEG，分辨率保持不变。
  function loadImageToJpeg(src) {
    return new Promise((resolve, reject) => {
      const mime = getImageMimeFromSrc(src);
      const isJpeg = isJpegMime(mime);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;

        function finish(bytes) {
          resolve({ bytes, width, height });
        }

        function reencodeToJpeg() {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
            const base64 = dataUrl.split(",")[1];
            const binary = window.atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
              bytes[i] = binary.charCodeAt(i);
            }
            finish(bytes);
          } catch (error) {
            reject(error);
          }
        }

        if (isJpeg) {
          // 原图已是 JPEG：直接复用原始字节，避免二次有损压缩
          fetchRawBytes(__APP.safeImageUrl ? __APP.safeImageUrl(src) : src).then(finish).catch(reencodeToJpeg);
        } else {
          reencodeToJpeg();
        }
      };
      img.onerror = function () {
        reject(new Error("图片加载失败"));
      };
      img.src = __APP.safeImageUrl ? __APP.safeImageUrl(src) : src;
    });
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function exportImagesToPdf(sources, filename) {
    const jpegs = [];
    for (const src of sources) {
      jpegs.push(await loadImageToJpeg(src));
    }
    const blob = buildPdfBlob(jpegs);
    triggerBlobDownload(blob, filename);
  }

  async function exportSelectedToPdf() {
    const selectedIds = state.selectedRecordIds;
    if (selectedIds.size === 0) {
      window.alert("请先选择要导出的记录（图片）。");
      return;
    }

    const sources = [];
    state.records.forEach((record) => {
      if (selectedIds.has(getRecordId(record))) {
        record.images.forEach((src) => sources.push(src));
      }
    });

    if (sources.length === 0) {
      window.alert("选中的记录中没有可导出的图片。");
      return;
    }

    const originalText = elements.exportPdfSelected.textContent;
    elements.exportPdfSelected.disabled = true;
    elements.exportPdfSelected.textContent = "导出中…";
    try {
      await exportImagesToPdf(sources, `image-studio-${Date.now()}.pdf`);
    } catch (error) {
      const message = error && error.message ? error.message : "导出 PDF 失败";
      window.alert("导出 PDF 失败：请在通过 start.bat 启动的本地服务中打开本页后重试。原因：" + message);
    } finally {
      elements.exportPdfSelected.textContent = originalText;
      elements.exportPdfSelected.disabled = selectedIds.size === 0;
    }
  }

  // ---- 上传图片转 PDF ----

  function getDateStamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function setUploadControlsState() {
    const hasFiles = state.uploadedFiles.length > 0;
    elements.pdfExportBtn.disabled = !hasFiles;
    elements.pdfClearBtn.disabled = !hasFiles;
  }

  function renderUploadThumbs() {
    elements.pdfUploadThumbs.innerHTML = "";
    state.uploadedFiles.forEach((item, index) => {
      const thumb = document.createElement("div");
      thumb.className = "pdf-thumb";
      const img = document.createElement("img");
      img.src = item.preview;
      img.alt = item.name || `图片 ${index + 1}`;
      const remove = document.createElement("button");
      remove.className = "pdf-thumb-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "移除";
      remove.setAttribute("aria-label", "移除该图片");
      remove.addEventListener("click", function () {
        state.uploadedFiles.splice(index, 1);
        renderUploadThumbs();
        setUploadControlsState();
      });
      thumb.appendChild(img);
      thumb.appendChild(remove);
      elements.pdfUploadThumbs.appendChild(thumb);
    });
    setUploadControlsState();
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error("读取图片失败"));
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleUploadFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && file.type && file.type.indexOf("image/") === 0);
    if (files.length === 0) {
      return;
    }
    for (const file of files) {
      try {
        const preview = await fileToDataUrl(file);
        state.uploadedFiles.push({ name: file.name, file, preview });
      } catch (error) {
        // 跳过无法读取的文件
      }
    }
    elements.pdfUploadInput.value = "";
    renderUploadThumbs();
  }

  async function exportUploadedToPdf() {
    if (state.uploadedFiles.length === 0) {
      return;
    }

    const originalText = elements.pdfExportBtn.textContent;
    elements.pdfExportBtn.disabled = true;
    elements.pdfExportBtn.textContent = "导出中…";
    try {
      const sources = [];
      for (const item of state.uploadedFiles) {
        const jpeg = await loadImageToJpeg(item.preview);
        sources.push(jpeg);
      }
      const blob = buildPdfBlob(sources);
      triggerBlobDownload(blob, `图片转PDF-${getDateStamp()}.pdf`);
    } catch (error) {
      const message = error && error.message ? error.message : "导出 PDF 失败";
      window.alert("导出 PDF 失败：" + message);
    } finally {
      elements.pdfExportBtn.textContent = originalText;
      setUploadControlsState();
    }
  }

  function clearUploaded() {
    state.uploadedFiles = [];
    elements.pdfUploadInput.value = "";
    renderUploadThumbs();
  }

  function openLightbox(src, alt, caption) {
    elements.lightboxImage.src = __APP.safeImageUrl ? __APP.safeImageUrl(src) : src;
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
        const exportPdfButton = fragment.querySelector(".export-pdf-button");
        const promptToggle = fragment.querySelector(".prompt-toggle");
        const recordSelect = fragment.querySelector(".record-select");
        const promptText = getPromptText(record);
        const selected = state.selectedRecordIds.has(recordId);

        card.dataset.recordId = recordId;
        card.dataset.promptExpanded = "false";
        card.classList.toggle("is-selected", selected);
        image.src = __APP.safeImageUrl ? __APP.safeImageUrl(src) : src;
        image.alt = promptText || `生成图片 ${index + 1}`;
        image.addEventListener("click", function () {
          openLightbox(src, image.alt, promptText);
        });
        ratio.textContent = record.aspectRatio || "未记录比例";
        style.textContent = record.styleTemplateLabel || "未记录风格";
        title.textContent = promptText;

        // 标签胶囊：点一下即作为关键词搜索
        const tagsWrap = fragment.querySelector(".gallery-tags");
        if (tagsWrap && Array.isArray(record.tags) && record.tags.length > 0) {
          tagsWrap.hidden = false;
          record.tags.forEach((tag) => {
            const pill = document.createElement("button");
            pill.type = "button";
            pill.className = "tag-pill";
            pill.textContent = tag;
            pill.title = `点击筛选「${tag}」`;
            pill.addEventListener("click", function () {
              elements.search.value = tag;
              state.searchQuery = tag;
              renderCards();
            });
            tagsWrap.appendChild(pill);
          });
        }

        time.textContent = record.generationDurationSeconds != null
          ? `${formatTime(record.time)} · 耗时 ${formatDurationSeconds(record.generationDurationSeconds)}`
          : formatTime(record.time);
        download.href = __APP.safeImageUrl ? __APP.safeImageUrl(src) : src;
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

        exportPdfButton.addEventListener("click", async function () {
          const originalText = exportPdfButton.textContent;
          exportPdfButton.disabled = true;
          exportPdfButton.textContent = "导出中…";
          try {
            await exportImagesToPdf([src], `image-studio-${recordId || "image"}-${index + 1}.pdf`);
          } catch (error) {
            const message = error && error.message ? error.message : "导出 PDF 失败";
            window.alert("导出 PDF 失败：请在通过 start.bat 启动的本地服务中打开本页后重试。原因：" + message);
          } finally {
            exportPdfButton.textContent = originalText;
            exportPdfButton.disabled = false;
          }
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

  // 搜索框：输入防抖后按关键词过滤（匹配标签、提示词等）
  let searchTimer = null;
  elements.search.addEventListener("input", function () {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      state.searchQuery = elements.search.value || "";
      renderCards();
    }, 250);
  });

  elements.refresh.addEventListener("click", function () {
    renderCards().then(function () {
      autoTagRecords();
    });
  });

  // 打开本地图库文件夹：调用本地服务的 API，用系统文件管理器打开 generated-images 目录
  elements.openFolder.addEventListener("click", async function () {
    const button = elements.openFolder;
    button.disabled = true;
    button.textContent = "正在打开...";
    try {
      const response = await fetch("/api/image-studio/open-folder", { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `请求失败（${response.status}）`);
      }
      button.textContent = "已打开 ✓";
      setTimeout(() => {
        button.textContent = "打开本地图库";
      }, 2000);
    } catch (error) {
      console.error("[gallery] 打开本地图库失败", error);
      button.textContent = "打开本地图库";
      window.alert("打开本地图库失败：" + (error && error.message ? error.message : "未知错误") + "\n请确认本地服务（start.bat）正在运行。");
    } finally {
      button.disabled = false;
    }
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

  elements.exportPdfSelected.addEventListener("click", async function () {
    await exportSelectedToPdf();
  });

  elements.pdfUploadTrigger.addEventListener("click", function () {
    elements.pdfUploadInput.click();
  });

  elements.pdfUploadInput.addEventListener("change", function () {
    handleUploadFiles(elements.pdfUploadInput.files);
  });

  elements.pdfExportBtn.addEventListener("click", async function () {
    await exportUploadedToPdf();
  });

  elements.pdfClearBtn.addEventListener("click", function () {
    clearUploaded();
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

  // 首次渲染完成后，自动为历史图片补打标签（已配置助手模型时）
  renderCards().then(function () {
    autoTagRecords();
  });
})();
