/**
 * 全局侧边导航栏（Breathing Rail）
 *
 * 默认以紧凑图标栏显示；鼠标移入或键盘聚焦时展开名称；
 * 用户可固定展开状态，选择会保存在当前浏览器中。
 */
(function () {
  "use strict";

  var PIN_STORAGE_KEY = "image-studio:rail-pinned-v1";
  var NAV_ITEMS = [
    {
      href: "./index.html",
      page: "index.html",
      label: "创作台",
      description: "文生图与批量生成",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>'
    },
    {
      href: "./img2img.html",
      page: "img2img.html",
      label: "图生图",
      description: "改图、合成与反推",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3.5 17l4.5-4 3.5 3 4-4.5 5 5.5"/></svg>'
    },
    {
      href: "./xhs.html",
      page: "xhs.html",
      label: "小红书创作",
      description: "图文笔记一键成稿",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12h7M9 15.5h7"/></svg>'
    },
    {
      href: "./article.html",
      page: "article.html",
      label: "文章配图",
      description: "一篇文章配一组插图",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M7.5 9h6M7.5 12.5h9M7.5 16h4"/><circle cx="16.2" cy="8.2" r="1.6"/></svg>'
    },
    {
      href: "./gallery.html",
      page: "gallery.html",
      label: "图片库",
      description: "作品与标签检索",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>'
    },
    {
      href: "./prompts.html",
      page: "prompts.html",
      label: "提示词库",
      description: "收藏、查找与复用",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-3.5-5.5 3.5z"/></svg>'
    },
    {
      href: "./settings.html",
      page: "settings.html",
      label: "通道设置",
      description: "模型与接口配置",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="1.9" fill="rgba(255,250,242,0.9)"/><circle cx="15" cy="12" r="1.9" fill="rgba(255,250,242,0.9)"/><circle cx="8" cy="17" r="1.9" fill="rgba(255,250,242,0.9)"/></svg>'
    },
    {
      href: "./help.html",
      page: "help.html",
      label: "使用说明",
      description: "功能指南与帮助",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.9c-.7.3-1 .8-1 1.6"/><circle cx="12" cy="16.8" r="0.4" fill="currentColor"/></svg>'
    }
  ];

  /** 获取当前页面文件名，目录首页统一视为 index.html。 */
  function currentPage() {
    var segments = window.location.pathname.split("/").filter(Boolean);
    var last = segments.length > 0 ? segments[segments.length - 1] : "index.html";
    return last.indexOf(".") === -1 ? "index.html" : String(last).toLowerCase();
  }

  /** 安全读取用户上次保存的侧栏固定状态。 */
  function readPinnedState() {
    try {
      return window.localStorage.getItem(PIN_STORAGE_KEY) === "true";
    } catch (error) {
      console.warn("[app-nav] 无法读取侧栏状态", error);
      return false;
    }
  }

  /** 保存侧栏固定状态，存储不可用时仅保留当前页面状态。 */
  function savePinnedState(pinned) {
    try {
      window.localStorage.setItem(PIN_STORAGE_KEY, String(pinned));
    } catch (error) {
      console.warn("[app-nav] 无法保存侧栏状态", error);
    }
  }

  /** 同步 Rail、页面让位和固定按钮的视觉与无障碍状态。 */
  function applyPinnedState(nav, button, pinned) {
    nav.classList.toggle("is-pinned", pinned);
    document.body.classList.toggle("app-rail-pinned", pinned);
    button.classList.toggle("is-active", pinned);
    button.setAttribute("aria-pressed", String(pinned));
    button.setAttribute("aria-label", pinned ? "取消固定侧栏" : "固定展开侧栏");
    button.querySelector(".app-rail-label").textContent = pinned ? "取消固定" : "固定侧栏";
  }

  /** 创建单个导航链接，包含图标、名称与一句辅助说明。 */
  function createNavItem(item, current) {
    var link = document.createElement("a");
    link.className = "app-rail-item" + (current === item.page ? " is-active" : "");
    link.href = item.href;
    link.title = item.label;
    link.setAttribute("aria-label", item.label);
    if (current === item.page) {
      link.setAttribute("aria-current", "page");
    }
    link.innerHTML = '<span class="app-rail-icon">' + item.icon + '</span>' +
      '<span class="app-rail-copy"><strong class="app-rail-label">' + item.label + '</strong>' +
      '<small>' + item.description + '</small></span>';
    return link;
  }

  /** 构建并注入全局侧边导航栏。 */
  function injectRail() {
    if (document.querySelector(".app-rail")) {
      return;
    }

    var current = currentPage();
    var nav = document.createElement("nav");
    nav.className = "app-rail";
    nav.setAttribute("aria-label", "全局导航");

    var brand = document.createElement("a");
    brand.className = "app-rail-brand";
    brand.href = "./index.html";
    brand.title = "图生图长 · AI 创作台";
    brand.innerHTML = '<span class="app-rail-logo">图</span>' +
      '<span class="app-rail-brand-copy"><strong>图生图长</strong><small>AI 创作台</small></span>';
    nav.appendChild(brand);

    var items = document.createElement("div");
    items.className = "app-rail-items";
    NAV_ITEMS.forEach(function (item) {
      items.appendChild(createNavItem(item, current));
    });
    nav.appendChild(items);

    var footer = document.createElement("div");
    footer.className = "app-rail-footer";
    var pinButton = document.createElement("button");
    pinButton.className = "app-rail-pin";
    pinButton.type = "button";
    pinButton.innerHTML = '<span class="app-rail-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4h8l-1 5 3 3v1H6v-1l3-3z"/><path d="M12 13v7"/></svg></span><span class="app-rail-label">固定侧栏</span>';
    footer.appendChild(pinButton);
    nav.appendChild(footer);

    document.body.insertBefore(nav, document.body.firstChild);
    document.body.classList.add("has-app-rail");
    applyPinnedState(nav, pinButton, readPinnedState());

    pinButton.addEventListener("click", function () {
      var nextPinned = !nav.classList.contains("is-pinned");
      applyPinnedState(nav, pinButton, nextPinned);
      savePinnedState(nextPinned);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectRail);
  } else {
    injectRail();
  }
})();
