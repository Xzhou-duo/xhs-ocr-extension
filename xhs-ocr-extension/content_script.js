// content_script.js — 注入小红书页面的主逻辑

(function () {
  // 防止重复注入
  if (document.getElementById("xhs-ocr-root")) return;

  // ── 状态 ──────────────────────────────────────────────────────────────────
  let panelOpen = false;
  let collectedImages = [];
  let ocrResults = {};

  const {
    baiduErrorMessage,
    imageDedupeKey,
    isTokenErrorCode,
    isXhsImageUrl,
    normalizeError,
    pickImageUrl,
  } = XhsOcrUtils;

  // ── 工具函数 ───────────────────────────────────────────────────────────────

  function getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(["baiduApiKey", "baiduSecretKey"], resolve);
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
    return (data.words_result || []).map(w => w.words).join("\n");
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

      <div id="xhs-image-grid"></div>

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
          <span>识别结果</span>
          <button id="xhs-copy-all-btn" class="xhs-btn-copy-all">复制全部</button>
        </div>
        <div id="xhs-result-list"></div>
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
    `;
    root.appendChild(panel);
    return panel;
  }

  // ── 渲染图片网格 ────────────────────────────────────────────────────────────
  function renderImageGrid(images) {
    const grid = document.getElementById("xhs-image-grid");
    const empty = document.getElementById("xhs-empty-tip");

    if (images.length === 0) {
      grid.innerHTML = "";
      empty.classList.remove("xhs-hidden");
      document.querySelector(".xhs-panel-footer").classList.add("xhs-hidden");
      return;
    }

    empty.classList.add("xhs-hidden");
    document.querySelector(".xhs-panel-footer").classList.remove("xhs-hidden");

    grid.innerHTML = images.map((img, i) => `
      <div class="xhs-img-item" data-index="${i}">
        <label class="xhs-img-label">
          <input type="checkbox" class="xhs-img-check" data-index="${i}">
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
  }

  function updateSelectionState() {
    const checks = document.querySelectorAll(".xhs-img-check");
    const selected = Array.from(checks).filter(c => c.checked);
    const count = selected.length;

    document.getElementById("xhs-selected-count").textContent = `已选 ${count} 张`;
    document.getElementById("xhs-ocr-btn").disabled = count === 0;

    const selectAll = document.getElementById("xhs-select-all");
    selectAll.indeterminate = count > 0 && count < checks.length;
    selectAll.checked = count === checks.length;

    // 视觉反馈：选中的卡片高亮
    document.querySelectorAll(".xhs-img-item").forEach(item => {
      const cb = item.querySelector(".xhs-img-check");
      item.classList.toggle("xhs-selected", cb.checked);
    });
  }

  // ── 渲染结果 ───────────────────────────────────────────────────────────────
  function renderResult(index, status, text) {
    const list = document.getElementById("xhs-result-list");
    const resultArea = document.getElementById("xhs-result-area");
    resultArea.classList.remove("xhs-hidden");

    const existingItem = document.getElementById(`xhs-result-item-${index}`);
    const html = buildResultItemHTML(index, status, text);

    if (existingItem) {
      existingItem.outerHTML = html;
    } else {
      list.insertAdjacentHTML("beforeend", html);
    }

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
  }

  function buildResultItemHTML(index, status, text) {
    if (status === "loading") {
      return `
        <div class="xhs-result-item" id="xhs-result-item-${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <span class="xhs-status-loading">识别中…</span>
          </div>
        </div>`;
    }
    if (status === "error") {
      return `
        <div class="xhs-result-item xhs-result-error" id="xhs-result-item-${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <button class="xhs-retry-single">重试此图</button>
          </div>
          <p class="xhs-error-msg">${escapeHtml(text)}</p>
        </div>`;
    }
    if (status === "aborted") {
      return `
        <div class="xhs-result-item xhs-result-aborted" id="xhs-result-item-${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <span class="xhs-status-aborted">识别已中止</span>
          </div>
        </div>`;
    }
    if (!text || text.trim() === "") {
      return `
        <div class="xhs-result-item" id="xhs-result-item-${index}">
          <div class="xhs-result-item-header">
            <span class="xhs-result-label">图 ${index + 1}</span>
            <span class="xhs-status-empty">未检测到文字</span>
          </div>
        </div>`;
    }
    return `
      <div class="xhs-result-item" id="xhs-result-item-${index}">
        <div class="xhs-result-item-header">
          <span class="xhs-result-label">图 ${index + 1}</span>
          <button class="xhs-copy-single">复制</button>
        </div>
        <pre class="xhs-result-text">${escapeHtml(text)}</pre>
      </div>`;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  async function processImage(index, apiKey, secretKey) {
    renderResult(index, "loading", "");
    try {
      const text = await recognizeImage(index, apiKey, secretKey);
      ocrResults[index] = text;
      renderResult(index, "done", text);
      return true;
    } catch (error) {
      delete ocrResults[index];
      renderResult(index, "error", normalizeError(error));
      return false;
    }
  }

  async function retryImage(index) {
    const settings = await getSettings();
    const { baiduApiKey, baiduSecretKey } = settings;
    if (!baiduApiKey || !baiduSecretKey) {
      renderResult(index, "error", "请先配置百度 API Key 和 Secret Key");
      return;
    }
    await processImage(index, baiduApiKey, baiduSecretKey);
  }

  // ── 主流程：OCR ─────────────────────────────────────────────────────────────
  async function runOCR() {
    const settings = await getSettings();
    const { baiduApiKey, baiduSecretKey } = settings;

    if (!baiduApiKey || !baiduSecretKey) {
      document.getElementById("xhs-no-key-tip").classList.remove("xhs-hidden");
      return;
    }

    const checks = document.querySelectorAll(".xhs-img-check:checked");
    const selectedIndices = Array.from(checks).map(c => parseInt(c.dataset.index));

    if (selectedIndices.length === 0) return;

    const ocrBtn = document.getElementById("xhs-ocr-btn");
    ocrBtn.disabled = true;
    ocrBtn.textContent = "识别中…";

    // 清空旧结果
    document.getElementById("xhs-result-list").innerHTML = "";
    document.getElementById("xhs-result-area").classList.add("xhs-hidden");
    ocrResults = {};

    try {
      await ensureToken(baiduApiKey, baiduSecretKey);
    } catch (err) {
      ocrBtn.disabled = false;
      ocrBtn.textContent = "开始识别";
      alert(normalizeError(err));
      return;
    }

    const startUrl = location.href; // 记录开始时的URL，用于检测路由跳转
    try {
      for (let i = 0; i < selectedIndices.length; i++) {
        if (location.href !== startUrl) {
          selectedIndices.slice(i).forEach(index => renderResult(index, "aborted", ""));
          break;
        }

        const index = selectedIndices[i];
        ocrBtn.textContent = `识别中 ${i + 1}/${selectedIndices.length}`;
        await processImage(index, baiduApiKey, baiduSecretKey);

        if (i < selectedIndices.length - 1) {
          await sleep(350);
        }
      }
    } finally {
      ocrBtn.disabled = false;
      ocrBtn.textContent = "开始识别";
    }

    // 绑定复制全部
    document.getElementById("xhs-copy-all-btn").onclick = () => {
      const allText = Object.values(ocrResults).filter(Boolean).join("\n\n---\n\n");
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
    ocrResults = {};

    collectedImages = collectImages();
    renderImageGrid(collectedImages);
    updateSelectionState();
  }

  function closePanel() {
    panelOpen = false;
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

    // 初始判断：不在笔记详情页时先隐藏
    if (!isNoteDetailPage()) {
      fab.style.display = "none";
    }

    // FAB 点击
    fab.addEventListener("click", openPanel);

    // 关闭
    document.getElementById("xhs-close-btn").addEventListener("click", closePanel);

    // 刷新扫描
    document.getElementById("xhs-refresh-btn").addEventListener("click", () => {
      collectedImages = collectImages();
      renderImageGrid(collectedImages);
      updateSelectionState();
      document.getElementById("xhs-result-area").classList.add("xhs-hidden");
      document.getElementById("xhs-result-list").innerHTML = "";
      ocrResults = {};
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
