// content_script.js — 注入小红书页面的主逻辑

(function () {
  // 防止重复注入
  if (document.getElementById("xhs-ocr-root")) return;

  // ── 状态 ──────────────────────────────────────────────────────────────────
  let panelOpen = false;
  let collectedImages = [];
  let ocrResults = {};
  let resultNavFrame = null;
  let historyNavFrame = null;
  const HISTORY_KEY = "xhsOcrHistory";
  const HISTORY_LIMIT = 100;

  const {
    baiduErrorMessage,
    countReusableHistoryEntries,
    findReusableHistoryEntry,
    groupHistoryByNote,
    historyEntryNoteKey,
    imageDedupeKey,
    isTokenErrorCode,
    isXhsImageUrl,
    noteKeyFromUrl,
    normalizeError,
    pickImageUrl,
    upsertHistoryEntry,
  } = XhsOcrUtils;

  // ── 工具函数 ───────────────────────────────────────────────────────────────

  function getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(["baiduApiKey", "baiduSecretKey"], resolve);
    });
  }

  function storageGet(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(items) {
    return new Promise(resolve => chrome.storage.local.set(items, resolve));
  }

  async function getHistory() {
    const stored = await storageGet(HISTORY_KEY);
    return Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  }

  function getNoteTitle() {
    const metaTitle =
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="title"]')?.content;
    return String(metaTitle || document.title || "")
      .replace(/\s*[-_|]\s*小红书.*$/i, "")
      .trim();
  }

  async function saveHistoryEntry(index, result) {
    const img = collectedImages[index];
    const imageUrl = getImageUrl(img?.imgEl, img?.src || "");
    const key = imageDedupeKey(imageUrl);
    if (!key) return;

    const history = await getHistory();
    const entry = {
      key,
      imageUrl,
      thumb: img?.thumb || imageUrl,
      noteUrl: location.href,
      noteKey: noteKeyFromUrl(location.href),
      noteTitle: getNoteTitle(),
      imageIndex: index,
      totalImages: collectedImages.length,
      extractedAt: Date.now(),
      result,
    };
    await storageSet({
      [HISTORY_KEY]: upsertHistoryEntry(history, entry, HISTORY_LIMIT),
    });
  }

  async function ensureToken(apiKey, secretKey, forceRefresh = false) {
    const res = await chrome.runtime.sendMessage({
      type: "GET_BAIDU_TOKEN",
      apiKey,
      secretKey,
      forceRefresh,
    });
    if (!res.success) throw new Error(res.error);
    return res.token;
  }

  function getImageUrl(imgEl, fallback = "") {
    if (!imgEl) return fallback;
    return pickImageUrl([
      imgEl.currentSrc,
      imgEl.dataset.src,
      imgEl.dataset.lazySrc,
      imgEl.getAttribute("data-original"),
      imgEl.getAttribute("data-full-src"),
      imgEl.getAttribute("src"),
      imgEl.src,
    ], fallback);
  }

  function waitForImageLoad(imgEl) {
    if (!imgEl || (imgEl.complete && imgEl.naturalWidth > 0)) {
      return Promise.resolve();
    }

    imgEl.loading = "eager";
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        imgEl.removeEventListener("load", finish);
        imgEl.removeEventListener("error", finish);
        resolve();
      };
      const timer = setTimeout(finish, 3000);
      imgEl.addEventListener("load", finish, { once: true });
      imgEl.addEventListener("error", finish, { once: true });
    });
  }

  // Content Script 的跨域 XHR 会受 CORS 限制，交给有 host permission 的 Service Worker 获取。
  async function imageToBase64(imageUrl) {
    const res = await chrome.runtime.sendMessage({
      type: "FETCH_IMAGE_BASE64",
      imageUrl,
      pageUrl: location.href,
    });
    if (!res?.success) {
      throw new Error(res?.error || "图片获取失败");
    }
    return res.base64;
  }

  async function ocrImage(base64, token) {
    const params = new URLSearchParams();
    params.append("image", base64);
    params.append("detect_direction", "false");
    params.append("paragraph", "false");

    const res = await fetch(
      `https://aip.baidubce.com/rest/2.0/ocr/v1/general?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      }
    );
    const data = await res.json();
    if (data.error_code) {
      const error = new Error(baiduErrorMessage(data.error_code, data.error_msg));
      error.code = data.error_code;
      throw error;
    }
    return {
      text: (data.words_result || []).map(item => item.words).join("\n"),
    };
  }

  // ── 收集页面图片 ────────────────────────────────────────────────────────────
  function collectImages() {
    const seen = new Set();
    const results = [];

    function addImage(src, thumb, imgEl) {
      // 去重 key 只取基础路径，但 src 存完整 URL（含鉴权签名和格式参数，缺一 403）
      const key = imageDedupeKey(src);
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ src: src, thumb: thumb || src, imgEl: imgEl || null });
    }

    // ① 优先策略：按轮播 slide 顺序抓取，保证顺序正确
    const slideSelectors = [
      ".swiper-slide",
      "[class*=\'slide\']",
      "[class*=\'carousel-item\']",
      "[class*=\'imageItem\']",
      "[class*=\'image-item\']",
    ];

    let slideImgs = [];
    for (const sel of slideSelectors) {
      const slides = document.querySelectorAll(sel);
      if (slides.length >= 2) {
        slides.forEach(slide => {
          if (slide.classList.contains("swiper-slide-duplicate")) return;
          const img = slide.querySelector("img");
          if (!img) return;
          img.loading = "eager";
          const src = getImageUrl(img);
          if (isXhsImageUrl(src)) slideImgs.push({ src, thumb: src, imgEl: img });
        });
        if (slideImgs.length >= 2) break;
      }
    }

    if (slideImgs.length >= 2) {
      slideImgs.forEach(({ src, thumb, imgEl }) => addImage(src, thumb, imgEl));
    }

    // ② 兜底策略
    if (results.length < 2) {
      seen.clear();
      results.length = 0;

      const contentSelectors = [
        "[class*=\'note-detail\']",
        "[class*=\'noteDetail\']",
        "[class*=\'swiper\']",
        "[class*=\'preview\']",
        "article",
      ];

      let searchRoot = document.body;
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el) { searchRoot = el; break; }
      }

      const imgs = Array.from(searchRoot.querySelectorAll("img"));
      imgs.forEach(img => {
        img.loading = "eager";
        const src = getImageUrl(img);
        if (!isXhsImageUrl(src)) return;
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 60) return;
        if (rect.height > 0 && rect.height < 60) return;
        addImage(src, src, img);
      });
    }

    return results;
  }

  // ── DOM 构建 ───────────────────────────────────────────────────────────────
  function createRoot() {
    const root = document.createElement("div");
    root.id = "xhs-ocr-root";
    document.body.appendChild(root);
    return root;
  }

  function buildFAB(root) {
    const fab = document.createElement("button");
    fab.id = "xhs-ocr-fab";
    fab.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M3 9h18M9 21V9"/>
      </svg>
      <span>提取文字</span>
    `;
    root.appendChild(fab);
    return fab;
  }

  function buildPanel(root) {
    const panel = document.createElement("div");
    panel.id = "xhs-ocr-panel";
    panel.innerHTML = `
      <div class="xhs-panel-header">
        <span class="xhs-panel-title">图片文字提取</span>
        <div class="xhs-header-actions">
          <button id="xhs-history-btn" title="历史提取记录">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
              <path d="M3 3v5h5M12 7v5l3 2"/>
            </svg>
          </button>
          <button id="xhs-refresh-btn" title="重新扫描图片">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
          </button>
          <button id="xhs-close-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      <div id="xhs-image-picker">
        <button id="xhs-image-picker-toggle" type="button" aria-expanded="false">
          <span class="xhs-image-picker-label">选择图片</span>
          <span id="xhs-image-picker-summary">已选择 0/0 张</span>
          <svg class="xhs-image-picker-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        <div id="xhs-image-grid"></div>
      </div>

      <div class="xhs-panel-footer">
        <div class="xhs-select-row">
          <label class="xhs-checkbox-label">
            <input type="checkbox" id="xhs-select-all"> 全选
          </label>
          <span id="xhs-selected-count">已选 0 张</span>
        </div>
        <button id="xhs-ocr-btn" class="xhs-btn-primary" disabled>开始识别</button>
      </div>

      <div id="xhs-result-area" class="xhs-hidden">
        <div class="xhs-result-header">
          <span id="xhs-result-title">识别结果</span>
          <button id="xhs-copy-all-btn" class="xhs-btn-copy-all">复制全部</button>
        </div>
        <div class="xhs-result-body">
          <div id="xhs-result-list"></div>
          <nav id="xhs-result-nav" class="xhs-hidden" aria-label="图片识别结果导航"></nav>
        </div>
      </div>

      <div id="xhs-empty-tip" class="xhs-empty-tip xhs-hidden">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M9 21V9"/>
        </svg>
        <p>当前页面未找到笔记图片</p>
        <p class="xhs-tip-sub">请先打开一篇图文笔记</p>
      </div>

      <div id="xhs-no-key-tip" class="xhs-empty-tip xhs-hidden">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
        <p>请先配置 API Key</p>
        <p class="xhs-tip-sub">点击浏览器右上角的插件图标进行设置</p>
      </div>

      <div id="xhs-history-view" class="xhs-hidden">
        <div class="xhs-history-header">
          <button id="xhs-history-back">返回提取</button>
          <span id="xhs-history-count"></span>
          <button id="xhs-history-clear">清空记录</button>
        </div>
        <div id="xhs-history-list"></div>
      </div>
    `;
    root.appendChild(panel);
    return panel;
  }

  function buildHistoryImagePreview(root) {
    const preview = document.createElement("div");
    preview.id = "xhs-history-image-preview";
    preview.className = "xhs-hidden";
    preview.innerHTML = `
      <button id="xhs-history-preview-close" type="button" aria-label="关闭大图预览">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
      <img id="xhs-history-preview-image" alt="历史图片大图预览">
    `;
    root.appendChild(preview);
    return preview;
  }

  // ── 渲染图片网格 ────────────────────────────────────────────────────────────
  function renderImageGrid(images) {
    const grid = document.getElementById("xhs-image-grid");
    const picker = document.getElementById("xhs-image-picker");
    const empty = document.getElementById("xhs-empty-tip");

    if (images.length === 0) {
      grid.innerHTML = "";
      picker.classList.add("xhs-hidden");
      empty.classList.remove("xhs-hidden");
      document.querySelector(".xhs-panel-footer").classList.add("xhs-hidden");
      return;
    }

    picker.classList.remove("xhs-hidden");
    empty.classList.add("xhs-hidden");
    document.querySelector(".xhs-panel-footer").classList.remove("xhs-hidden");

    grid.innerHTML = images.map((img, i) => `
      <div class="xhs-img-item" data-index="${i}">
        <label class="xhs-img-label">
          <input type="checkbox" class="xhs-img-check" data-index="${i}" checked>
          <div class="xhs-img-wrap">
            <img src="${img.thumb}" alt="图片${i + 1}" loading="lazy">
            <div class="xhs-img-overlay">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
                <path d="M20 6 9 17l-5-5"/>
              </svg>
            </div>
          </div>
          <span class="xhs-img-num">图 ${i + 1}</span>
        </label>
      </div>
    `).join("");

    // 绑定 checkbox 事件
    grid.querySelectorAll(".xhs-img-check").forEach(cb => {
      cb.addEventListener("change", updateSelectionState);
    });
    markHistoricalImages();
  }

  function setImagePickerExpanded(expanded) {
    const panel = document.getElementById("xhs-ocr-panel");
    const toggle = document.getElementById("xhs-image-picker-toggle");
    panel.classList.toggle("xhs-image-picker-expanded", expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
  }

  async function markHistoricalImages() {
    const history = await getHistory();
    const noteKey = noteKeyFromUrl(location.href);
    document.querySelectorAll(".xhs-history-badge").forEach(badge => badge.remove());
    collectedImages.forEach((img, index) => {
      const imageUrl = getImageUrl(img.imgEl, img.src);
      if (!findReusableHistoryEntry(history, imageUrl, noteKey, index)) return;
      const wrap = document.querySelector(`.xhs-img-item[data-index="${index}"] .xhs-img-wrap`);
      if (!wrap || wrap.querySelector(".xhs-history-badge")) return;
      wrap.insertAdjacentHTML("beforeend", '<span class="xhs-history-badge">已提取</span>');
    });
  }

  function updateSelectionState() {
    const checks = document.querySelectorAll(".xhs-img-check");
    const selected = Array.from(checks).filter(c => c.checked);
    const count = selected.length;
    const total = checks.length;
    const ocrBtn = document.getElementById("xhs-ocr-btn");

    document.getElementById("xhs-selected-count").textContent = `已选 ${count} 张`;
    document.getElementById("xhs-image-picker-summary").textContent = `已选择 ${count}/${total} 张`;
    ocrBtn.disabled = count === 0 || ocrBtn.dataset.running === "true";
    if (ocrBtn.dataset.running !== "true") {
      ocrBtn.textContent =
        count === 0
          ? "请选择图片"
          : count === total
            ? `提取全部 ${count} 张`
            : `提取所选 ${count} 张`;
    }

    const selectAll = document.getElementById("xhs-select-all");
    selectAll.indeterminate = count > 0 && count < checks.length;
    selectAll.checked = count === checks.length;

    // 视觉反馈：选中的卡片高亮
    document.querySelectorAll(".xhs-img-item").forEach(item => {
      const cb = item.querySelector(".xhs-img-check");
      item.classList.toggle("xhs-selected", cb.checked);
    });
  }

  function setActiveResultNav(index) {
    document.querySelectorAll(".xhs-result-nav-node").forEach(node => {
      const active = Number(node.dataset.index) === index;
      node.classList.toggle("xhs-active", active);
      node.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  function syncResultNavToScroll() {
    resultNavFrame = null;
    const list = document.getElementById("xhs-result-list");
    const items = Array.from(list.querySelectorAll(".xhs-result-item"));
    if (items.length === 0) return;

    const listTop = list.getBoundingClientRect().top + 12;
    let current = items[0];
    for (const item of items) {
      if (item.getBoundingClientRect().top <= listTop) current = item;
      else break;
    }
    setActiveResultNav(Number(current.dataset.index));
  }

  function scheduleResultNavSync() {
    if (resultNavFrame !== null) return;
    resultNavFrame = requestAnimationFrame(syncResultNavToScroll);
  }

  function clearResultNav() {
    if (resultNavFrame !== null) {
      cancelAnimationFrame(resultNavFrame);
      resultNavFrame = null;
    }
    const nav = document.getElementById("xhs-result-nav");
    nav.innerHTML = "";
    nav.classList.add("xhs-hidden");
  }

  function buildResultNav(indices) {
    const nav = document.getElementById("xhs-result-nav");
    document.getElementById("xhs-result-list").scrollTop = 0;
    nav.innerHTML = indices.map(index => `
      <button
        type="button"
        class="xhs-result-nav-node xhs-pending"
        data-index="${index}"
        data-label="图 ${index + 1}"
        aria-label="跳转到图 ${index + 1}"
        aria-current="false"
        disabled
      ></button>
    `).join("");
    nav.classList.toggle("xhs-hidden", indices.length === 0);

    nav.querySelectorAll(".xhs-result-nav-node").forEach(node => {
      node.addEventListener("click", () => {
        const index = Number(node.dataset.index);
        const item = document.getElementById(`xhs-result-item-${index}`);
        const list = document.getElementById("xhs-result-list");
        if (!item) return;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        list.scrollTo({
          top:
            list.scrollTop +
            item.getBoundingClientRect().top -
            list.getBoundingClientRect().top,
          behavior: reduceMotion ? "auto" : "smooth",
        });
        setActiveResultNav(index);
      });
    });
  }

  function updateResultNavNode(index, status) {
    const node = document.querySelector(`.xhs-result-nav-node[data-index="${index}"]`);
    if (!node) return;
    node.disabled = false;
    node.classList.remove(
      "xhs-pending",
      "xhs-loading",
      "xhs-done",
      "xhs-error",
      "xhs-aborted"
    );
    node.classList.add(`xhs-${status}`);

    if (!document.querySelector(".xhs-result-nav-node.xhs-active")) {
      setActiveResultNav(index);
    }
    scheduleResultNavSync();
  }

  // ── 渲染结果 ───────────────────────────────────────────────────────────────
  function renderResult(index, status, text, options = {}) {
    const list = document.getElementById("xhs-result-list");
    const resultArea = document.getElementById("xhs-result-area");
    document.getElementById("xhs-ocr-panel").classList.add("xhs-has-results");
    document.querySelector(".xhs-image-picker-label").textContent = "修改图片选择";
    resultArea.classList.remove("xhs-hidden");

    const existingItem = document.getElementById(`xhs-result-item-${index}`);
    const html = buildResultItemHTML(index, status, text, options);

    if (existingItem) {
      existingItem.outerHTML = html;
    } else {
      list.insertAdjacentHTML("beforeend", html);
    }
    updateResultNavNode(index, status);

    // 绑定单条复制
    const item = document.getElementById(`xhs-result-item-${index}`);
    const copyBtn = item?.querySelector(".xhs-copy-single");
    if (copyBtn && text) {
      copyBtn.addEventListener("click", () => copyToClipboard(text, copyBtn));
    }
    const retryBtn = item?.querySelector(".xhs-retry-single");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => retryImage(index));
    }
    const refreshBtn = item?.querySelector(".xhs-refresh-single");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => retryImage(index, true));
    }
  }

  function buildResultItemHTML(index, status, text, options = {}) {
    if (status === "loading") {
      return `
        <div class="xhs-result-item" id="xhs-result-item-${index}" data-index="${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <span class="xhs-status-loading">识别中…</span>
          </div>
        </div>`;
    }
    if (status === "error") {
      return `
        <div class="xhs-result-item xhs-result-error" id="xhs-result-item-${index}" data-index="${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <button class="xhs-retry-single">重试此图</button>
          </div>
          <p class="xhs-error-msg">${escapeHtml(text)}</p>
        </div>`;
    }
    if (status === "aborted") {
      return `
        <div class="xhs-result-item xhs-result-aborted" id="xhs-result-item-${index}" data-index="${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <span class="xhs-status-aborted">识别已中止</span>
          </div>
        </div>`;
    }
    if (!text || text.trim() === "") {
      return `
        <div class="xhs-result-item" id="xhs-result-item-${index}" data-index="${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}${options.fromHistory ? " · 来自历史" : ""}</span>
            <div class="xhs-result-item-actions">
              ${options.fromHistory ? '<button class="xhs-refresh-single">重新识别</button>' : ""}
              <span class="xhs-status-empty">未检测到文字</span>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="xhs-result-item" id="xhs-result-item-${index}" data-index="${index}">
        <div class="xhs-result-item-header">
          <span class="xhs-result-label">图 ${index + 1}${options.fromHistory ? " · 来自历史" : ""}</span>
          <div class="xhs-result-item-actions">
            ${options.fromHistory ? '<button class="xhs-refresh-single">重新识别</button>' : ""}
            <button class="xhs-copy-single">复制</button>
          </div>
        </div>
        <pre class="xhs-result-text">${escapeHtml(text)}</pre>
      </div>`;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeAttribute(str) {
    return escapeHtml(String(str)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function setHistoryView(visible) {
    const historyView = document.getElementById("xhs-history-view");
    const panel = document.getElementById("xhs-ocr-panel");
    const mainIds = ["xhs-image-picker", "xhs-result-area", "xhs-empty-tip", "xhs-no-key-tip"];
    document.querySelector(".xhs-panel-title").textContent = visible
      ? "历史提取记录"
      : "图片文字提取";
    document.getElementById("xhs-refresh-btn").classList.toggle("xhs-hidden", visible);
    document.querySelector(".xhs-panel-footer").classList.toggle("xhs-hidden", visible || collectedImages.length === 0);
    historyView.classList.toggle("xhs-hidden", !visible);

    if (visible) {
      mainIds.forEach(id => document.getElementById(id).classList.add("xhs-hidden"));
      panel.classList.add("xhs-has-results");
      document.getElementById("xhs-result-nav").classList.add("xhs-hidden");
    } else {
      clearHistoryNav();
      document.getElementById("xhs-image-picker").classList.toggle("xhs-hidden", collectedImages.length === 0);
      document.getElementById("xhs-empty-tip").classList.toggle("xhs-hidden", collectedImages.length > 0);
      document.getElementById("xhs-result-area").classList.toggle(
        "xhs-hidden",
        document.getElementById("xhs-result-list").children.length === 0
      );
      panel.classList.toggle(
        "xhs-has-results",
        document.getElementById("xhs-result-list").children.length > 0
      );
      document.getElementById("xhs-result-nav").classList.toggle(
        "xhs-hidden",
        document.querySelectorAll(".xhs-result-nav-node").length === 0
      );
    }
  }

  async function renderHistory() {
    const history = await getHistory();
    renderHistoryGroups(history);
  }

  function formatHistoryTime(timestamp) {
    return new Date(timestamp).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderHistoryGroups(history) {
    const groups = groupHistoryByNote(history);
    const list = document.getElementById("xhs-history-list");
    clearHistoryNav();
    list.classList.remove("xhs-history-detail-mode");
    document.getElementById("xhs-history-clear").classList.remove("xhs-hidden");
    document.getElementById("xhs-history-count").textContent = `最近 ${groups.length} 篇`;

    if (groups.length === 0) {
      list.innerHTML = '<div class="xhs-history-empty">暂无提取记录</div>';
      return;
    }

    list.innerHTML = groups.map((group, index) => {
      const cover = group.entries[0]?.thumb || group.entries[0]?.imageUrl || "";
      const title = group.noteTitle || "未命名帖子";
      return `
        <div class="xhs-history-post">
          <button class="xhs-history-post-main" data-index="${index}" type="button">
            <span class="xhs-history-post-cover">
              ${cover ? `<img src="${escapeAttribute(cover)}" alt="">` : ""}
            </span>
            <span class="xhs-history-post-info">
              <strong>${escapeHtml(title)}</strong>
              <span>${group.entries.length === group.totalImages
                ? `${group.entries.length} 张图片`
                : `已解析 ${group.entries.length}/${group.totalImages} 张`}</span>
              <time>${escapeHtml(formatHistoryTime(group.updatedAt))}</time>
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="m9 18 6-6-6-6"/>
            </svg>
          </button>
          <button class="xhs-history-post-delete" data-index="${index}" type="button">删除</button>
        </div>`;
    }).join("");

    list.querySelectorAll(".xhs-history-post-main").forEach(btn => {
      btn.addEventListener("click", () => {
        renderHistoryDetail(groups[Number(btn.dataset.index)], history);
      });
    });
    list.querySelectorAll(".xhs-history-post-delete").forEach(btn => {
      btn.addEventListener("click", async () => {
        const group = groups[Number(btn.dataset.index)];
        if (!group || !confirm(`确定删除“${group.noteTitle || "未命名帖子"}”的历史记录吗？`)) return;
        const remaining = history.filter(
          entry => historyEntryNoteKey(entry) !== group.noteKey
        );
        await storageSet({ [HISTORY_KEY]: remaining });
        renderHistoryGroups(remaining);
      });
    });
  }

  function renderHistoryDetail(group, history) {
    if (!group) return;
    const list = document.getElementById("xhs-history-list");
    document.getElementById("xhs-history-clear").classList.add("xhs-hidden");
    const allText = group.entries
      .map(entry => entry.result?.text)
      .filter(Boolean)
      .join("\n\n---\n\n");
    document.getElementById("xhs-history-count").textContent =
      `${group.entries.length}/${group.totalImages} 张`;

    list.classList.add("xhs-history-detail-mode");
    list.innerHTML = `
      <div class="xhs-history-detail-header">
        <button id="xhs-history-detail-back" type="button">返回帖子列表</button>
        <div class="xhs-history-detail-actions">
          ${group.noteUrl
            ? `<a href="${escapeAttribute(group.noteUrl)}" target="_blank" rel="noreferrer">打开原帖</a>`
            : ""}
          ${allText ? '<button id="xhs-history-copy-all" type="button">复制全部</button>' : ""}
        </div>
      </div>
      <div class="xhs-history-detail-title">${escapeHtml(group.noteTitle || "未命名帖子")}</div>
      <div class="xhs-history-detail-body">
        <div id="xhs-history-detail-list">
          ${group.entries.map((entry, position) => {
            const text = entry.result?.text || "";
            const imageNumber = Number.isInteger(entry.imageIndex)
              ? entry.imageIndex + 1
              : position + 1;
            const thumb = entry.thumb || entry.imageUrl || "";
            return `
              <article class="xhs-history-detail-item" data-position="${position}">
                <button
                  class="xhs-history-detail-image"
                  type="button"
                  data-image-url="${escapeAttribute(thumb)}"
                  aria-label="展开图 ${imageNumber}"
                  ${thumb ? "" : "disabled"}
                >
                  ${thumb ? `<img src="${escapeAttribute(thumb)}" alt="图 ${imageNumber}">` : ""}
                  ${thumb ? '<span>点击展开</span>' : ""}
                </button>
                <div class="xhs-history-detail-result">
                  <div>
                    <strong>图 ${imageNumber}</strong>
                    ${text
                      ? `<button class="xhs-history-copy" data-position="${position}" type="button">复制</button>`
                      : '<span>未检测到文字</span>'}
                  </div>
                  <pre>${text ? escapeHtml(text) : "未检测到文字"}</pre>
                </div>
              </article>`;
          }).join("")}
        </div>
        <nav id="xhs-history-detail-nav" aria-label="历史图片结果导航">
          ${group.entries.map((entry, position) => {
            const imageNumber = Number.isInteger(entry.imageIndex)
              ? entry.imageIndex + 1
              : position + 1;
            return `
              <button
                type="button"
                class="xhs-result-nav-node${position === 0 ? " xhs-active" : ""}"
                data-position="${position}"
                data-label="图 ${imageNumber}"
                aria-label="跳转到图 ${imageNumber}"
                aria-current="${position === 0 ? "true" : "false"}"
              ></button>`;
          }).join("")}
        </nav>
      </div>
    `;

    document.getElementById("xhs-history-detail-back").addEventListener("click", () => {
      renderHistoryGroups(history);
    });
    const copyAllBtn = document.getElementById("xhs-history-copy-all");
    if (copyAllBtn) {
      copyAllBtn.addEventListener("click", () => copyToClipboard(allText, copyAllBtn));
    }
    list.querySelectorAll(".xhs-history-copy").forEach(btn => {
      btn.addEventListener("click", () => {
        const text = group.entries[Number(btn.dataset.position)]?.result?.text;
        if (text) copyToClipboard(text, btn);
      });
    });
    list.querySelectorAll(".xhs-history-detail-image[data-image-url]").forEach(btn => {
      btn.addEventListener("click", () => openHistoryImagePreview(btn.dataset.imageUrl));
    });
    const detailList = document.getElementById("xhs-history-detail-list");
    detailList.addEventListener("scroll", scheduleHistoryNavSync);
    document.querySelectorAll("#xhs-history-detail-nav .xhs-result-nav-node").forEach(node => {
      node.addEventListener("click", () => {
        const position = Number(node.dataset.position);
        const item = detailList.querySelector(
          `.xhs-history-detail-item[data-position="${position}"]`
        );
        if (!item) return;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        detailList.scrollTo({
          top:
            detailList.scrollTop +
            item.getBoundingClientRect().top -
            detailList.getBoundingClientRect().top,
          behavior: reduceMotion ? "auto" : "smooth",
        });
        setActiveHistoryNav(position);
      });
    });
  }

  function setActiveHistoryNav(position) {
    document.querySelectorAll("#xhs-history-detail-nav .xhs-result-nav-node").forEach(node => {
      const active = Number(node.dataset.position) === position;
      node.classList.toggle("xhs-active", active);
      node.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  function syncHistoryNavToScroll() {
    historyNavFrame = null;
    const detailList = document.getElementById("xhs-history-detail-list");
    if (!detailList) return;
    const items = Array.from(detailList.querySelectorAll(".xhs-history-detail-item"));
    if (items.length === 0) return;
    if (detailList.scrollTop + detailList.clientHeight >= detailList.scrollHeight - 2) {
      setActiveHistoryNav(Number(items[items.length - 1].dataset.position));
      return;
    }

    const listTop = detailList.getBoundingClientRect().top + 12;
    let current = items[0];
    for (const item of items) {
      if (item.getBoundingClientRect().top <= listTop) current = item;
      else break;
    }
    setActiveHistoryNav(Number(current.dataset.position));
  }

  function scheduleHistoryNavSync() {
    if (historyNavFrame !== null) return;
    historyNavFrame = requestAnimationFrame(syncHistoryNavToScroll);
  }

  function clearHistoryNav() {
    if (historyNavFrame !== null) {
      cancelAnimationFrame(historyNavFrame);
      historyNavFrame = null;
    }
  }

  function openHistoryImagePreview(imageUrl) {
    if (!imageUrl) return;
    const preview = document.getElementById("xhs-history-image-preview");
    document.getElementById("xhs-history-preview-image").src = imageUrl;
    preview.classList.remove("xhs-hidden");
  }

  function closeHistoryImagePreview() {
    const preview = document.getElementById("xhs-history-image-preview");
    preview.classList.add("xhs-hidden");
    document.getElementById("xhs-history-preview-image").removeAttribute("src");
  }

  // ── 复制到剪贴板 ────────────────────────────────────────────────────────────
  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "已复制 ✓";
      btn.classList.add("xhs-btn-copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("xhs-btn-copied");
      }, 1500);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function recognizeImage(index, apiKey, secretKey) {
    const img = collectedImages[index];
    if (!img) throw new Error("图片已失效，请重新扫描");

    const attempt = async () => {
      await waitForImageLoad(img.imgEl);
      const imageUrl = getImageUrl(img.imgEl, img.src);
      img.src = imageUrl;
      const base64 = await imageToBase64(imageUrl);
      const token = await ensureToken(apiKey, secretKey);
      return ocrImage(base64, token);
    };

    try {
      return await attempt();
    } catch (error) {
      if (isTokenErrorCode(error.code)) {
        await ensureToken(apiKey, secretKey, true);
      } else {
        await sleep(600);
      }
      return attempt();
    }
  }

  async function processImage(index, apiKey, secretKey, forceRefresh = false) {
    delete ocrResults[index];
    const img = collectedImages[index];
    const imageUrl = getImageUrl(img?.imgEl, img?.src || "");

    if (!forceRefresh) {
      const cached = findReusableHistoryEntry(
        await getHistory(),
        imageUrl,
        noteKeyFromUrl(location.href),
        index
      );
      if (cached) {
        ocrResults[index] = cached.result;
        renderResult(index, "done", cached.result.text, { fromHistory: true });
        return { success: true, fromHistory: true };
      }
    }

    renderResult(index, "loading", "");
    try {
      const result = await recognizeImage(index, apiKey, secretKey);
      ocrResults[index] = result;
      renderResult(index, "done", result.text);
      await saveHistoryEntry(index, result);
      markHistoricalImages();
      return { success: true, fromHistory: false };
    } catch (error) {
      delete ocrResults[index];
      renderResult(index, "error", normalizeError(error));
      return { success: false, fromHistory: false };
    }
  }

  async function retryImage(index, forceRefresh = false) {
    const settings = await getSettings();
    const { baiduApiKey, baiduSecretKey } = settings;
    if (!baiduApiKey || !baiduSecretKey) {
      renderResult(index, "error", "请先配置百度 API Key 和 Secret Key");
      return;
    }
    await processImage(index, baiduApiKey, baiduSecretKey, forceRefresh);
  }

  // ── 主流程：OCR ─────────────────────────────────────────────────────────────
  async function runOCR() {
    const settings = await getSettings();
    const { baiduApiKey, baiduSecretKey } = settings;

    const checks = document.querySelectorAll(".xhs-img-check:checked");
    const selectedIndices = Array.from(checks).map(c => parseInt(c.dataset.index));

    if (selectedIndices.length === 0) return;

    const history = await getHistory();
    const noteKey = noteKeyFromUrl(location.href);
    const selectedImages = selectedIndices.map(index => {
      const img = collectedImages[index];
      return {
        src: getImageUrl(img?.imgEl, img?.src || ""),
        imageIndex: index,
      };
    });
    const reusableCount = countReusableHistoryEntries(history, selectedImages, noteKey);
    const needsOcrCount = selectedIndices.length - reusableCount;
    const needsOcr = needsOcrCount > 0;

    if (reusableCount === selectedIndices.length) {
      alert("您已提取过类似内容，已直接展示历史结果，本次不会重复调用 API。");
    } else if (reusableCount > 0) {
      alert(
        `您已提取过类似内容，其中 ${reusableCount} 张将直接展示历史结果，仅对 ${needsOcrCount} 张新图片调用 API。`
      );
    }

    if (needsOcr && (!baiduApiKey || !baiduSecretKey)) {
      document.getElementById("xhs-no-key-tip").classList.remove("xhs-hidden");
      return;
    }
    if (needsOcr) {
      try {
        await ensureToken(baiduApiKey, baiduSecretKey);
      } catch (error) {
        alert(normalizeError(error));
        return;
      }
    }

    const ocrBtn = document.getElementById("xhs-ocr-btn");
    document.getElementById("xhs-result-title").textContent = `识别结果（${selectedIndices.length}）`;
    setImagePickerExpanded(false);
    ocrBtn.dataset.running = "true";
    ocrBtn.disabled = true;
    ocrBtn.textContent = "识别中…";

    // 清空旧结果
    document.getElementById("xhs-result-list").innerHTML = "";
    document.getElementById("xhs-result-area").classList.add("xhs-hidden");
    buildResultNav(selectedIndices);
    ocrResults = {};

    const startUrl = location.href; // 记录开始时的URL，用于检测路由跳转
    try {
      for (let i = 0; i < selectedIndices.length; i++) {
        if (location.href !== startUrl) {
          selectedIndices.slice(i).forEach(index => renderResult(index, "aborted", ""));
          break;
        }

        const index = selectedIndices[i];
        ocrBtn.textContent = `识别中 ${i + 1}/${selectedIndices.length}`;
        const outcome = await processImage(index, baiduApiKey, baiduSecretKey);

        if (!outcome.fromHistory && i < selectedIndices.length - 1) {
          await sleep(350);
        }
      }
    } finally {
      delete ocrBtn.dataset.running;
      updateSelectionState();
    }

    // 绑定复制全部
    document.getElementById("xhs-copy-all-btn").onclick = () => {
      const allText = Object.values(ocrResults)
        .map(result => result?.text)
        .filter(Boolean)
        .join("\n\n---\n\n");
      if (allText) {
        const btn = document.getElementById("xhs-copy-all-btn");
        copyToClipboard(allText, btn);
      }
    };
  }

  // ── 面板开关 ───────────────────────────────────────────────────────────────
  function openPanel() {
    panelOpen = true;

    const panel = document.getElementById("xhs-ocr-panel");
    panel.classList.add("xhs-panel-open");
    document.getElementById("xhs-fab-btn") && (document.getElementById("xhs-fab-btn").style.display = "none");

    // 重置
    document.getElementById("xhs-result-area").classList.add("xhs-hidden");
    document.getElementById("xhs-empty-tip").classList.add("xhs-hidden");
    document.getElementById("xhs-no-key-tip").classList.add("xhs-hidden");
    document.getElementById("xhs-result-list").innerHTML = "";
    document.getElementById("xhs-result-title").textContent = "识别结果";
    document.querySelector(".xhs-image-picker-label").textContent = "选择图片";
    panel.classList.remove("xhs-has-results");
    clearResultNav();
    ocrResults = {};
    setImagePickerExpanded(false);

    collectedImages = collectImages();
    renderImageGrid(collectedImages);
    updateSelectionState();
    setHistoryView(false);
  }

  function closePanel() {
    panelOpen = false;
    closeHistoryImagePreview();
    const panel = document.getElementById("xhs-ocr-panel");
    panel.classList.remove("xhs-panel-open");
    document.getElementById("xhs-ocr-fab").style.display = "flex";
  }

  // ── 路由判断：是否为笔记详情页 ────────────────────────────────────────────
  function isNoteDetailPage() {
    return /\/(explore|discovery\/item)\/[a-zA-Z0-9]+/.test(location.pathname);
  }

  // FAB 和面板的整体显隐控制
  function updateVisibility() {
    const fab = document.getElementById("xhs-ocr-fab");
    const panel = document.getElementById("xhs-ocr-panel");
    if (!fab || !panel) return;

    if (isNoteDetailPage()) {
      // 在笔记详情页：显示 FAB（面板保持其自身开关状态）
      if (!panelOpen) {
        fab.style.display = "flex";
      }
    } else {
      // 不在笔记详情页：隐藏 FAB，如果面板开着则关掉
      fab.style.display = "none";
      if (panelOpen) closePanel();
    }
  }

  // ── 初始化 ─────────────────────────────────────────────────────────────────
  function init() {
    const root = createRoot();
    const fab = buildFAB(root);
    const panel = buildPanel(root);
    const imagePreview = buildHistoryImagePreview(root);

    // 初始判断：不在笔记详情页时先隐藏
    if (!isNoteDetailPage()) {
      fab.style.display = "none";
    }

    // FAB 点击
    fab.addEventListener("click", openPanel);

    // 关闭
    document.getElementById("xhs-close-btn").addEventListener("click", closePanel);

    document.getElementById("xhs-history-btn").addEventListener("click", async () => {
      setHistoryView(true);
      await renderHistory();
    });
    document.getElementById("xhs-history-back").addEventListener("click", () => {
      setHistoryView(false);
      markHistoricalImages();
    });
    document.getElementById("xhs-history-clear").addEventListener("click", async () => {
      if (!confirm("确定清空全部历史提取记录吗？")) return;
      await storageSet({ [HISTORY_KEY]: [] });
      await renderHistory();
    });
    document.getElementById("xhs-history-preview-close").addEventListener("click", closeHistoryImagePreview);
    imagePreview.addEventListener("click", event => {
      if (event.target === imagePreview) closeHistoryImagePreview();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !imagePreview.classList.contains("xhs-hidden")) {
        closeHistoryImagePreview();
      }
    });

    // 刷新扫描
    document.getElementById("xhs-refresh-btn").addEventListener("click", () => {
      collectedImages = collectImages();
      renderImageGrid(collectedImages);
      updateSelectionState();
      document.getElementById("xhs-result-area").classList.add("xhs-hidden");
      document.getElementById("xhs-result-list").innerHTML = "";
      document.getElementById("xhs-result-title").textContent = "识别结果";
      document.querySelector(".xhs-image-picker-label").textContent = "选择图片";
      document.getElementById("xhs-ocr-panel").classList.remove("xhs-has-results");
      clearResultNav();
      ocrResults = {};
      setImagePickerExpanded(false);
    });

    document.getElementById("xhs-image-picker-toggle").addEventListener("click", () => {
      const panel = document.getElementById("xhs-ocr-panel");
      setImagePickerExpanded(!panel.classList.contains("xhs-image-picker-expanded"));
    });

    // 全选
    document.getElementById("xhs-select-all").addEventListener("change", function () {
      document.querySelectorAll(".xhs-img-check").forEach(cb => {
        cb.checked = this.checked;
      });
      updateSelectionState();
    });

    // OCR 按钮
    document.getElementById("xhs-ocr-btn").addEventListener("click", runOCR);
    document.getElementById("xhs-result-list").addEventListener("scroll", scheduleResultNavSync);
    // 监听 SPA 路由变化：URL 改变时重新判断显隐
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        updateVisibility();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // 等 DOM 稳定后初始化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
