// background.js — Service Worker
// 职责：1) 获取百度 access_token  2) 中转图片请求转 base64

importScripts("core_utils.js");

const TOKEN_CACHE_KEY = "baiduTokenCache";
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("网络请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── 获取百度 access_token ──────────────────────────────────────────────────
async function getBaiduToken(apiKey, secretKey) {
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;
  const res = await fetchWithTimeout(url, { method: "POST" });
  if (!res.ok) throw new Error(`Token 请求失败: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 2592000) * 1000,
  };
}

async function getCachedBaiduToken(apiKey, secretKey, forceRefresh = false) {
  const stored = await storageGet(TOKEN_CACHE_KEY);
  const cache = stored[TOKEN_CACHE_KEY];
  const cacheValid = XhsOcrUtils.isTokenCacheValid(
    cache,
    apiKey,
    secretKey,
    Date.now(),
    TOKEN_EXPIRY_BUFFER_MS
  );

  if (!forceRefresh && cacheValid) return cache.token;

  const fresh = await getBaiduToken(apiKey, secretKey);
  await storageSet({
    [TOKEN_CACHE_KEY]: {
      apiKey,
      secretKey,
      token: fresh.token,
      expiresAt: fresh.expiresAt,
    },
  });
  return fresh.token;
}

// ── 图片 URL → base64 ──────────────────────────────────────────────────────
async function fetchImageAsBase64(imageUrl, pageUrl) {
  const referer = pageUrl || "https://www.xiaohongshu.com/";

  // 策略1：带 Referer + credentials（携带登录cookie）
  async function tryWithCredentials() {
    const res = await fetchWithTimeout(imageUrl, {
      method: "GET",
      credentials: "include",   // 携带小红书登录态 cookie
      headers: {
        "Referer": referer,
        "Origin": "https://www.xiaohongshu.com",
      },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.blob();
  }

  // 策略2：纯净请求不带额外头（某些CDN不校验referer）
  async function tryPlain() {
    const res = await fetchWithTimeout(imageUrl, { method: "GET" });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.blob();
  }

  let blob;
  try {
    blob = await tryWithCredentials();
  } catch (e1) {
    try {
      blob = await tryPlain();
    } catch (e2) {
      throw new Error(`图片获取失败(${e1.message}/${e2.message})，请刷新页面后重试`);
    }
  }

  // blob → base64
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── 消息监听 ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // 1. 获取 access_token
  if (message.type === "GET_BAIDU_TOKEN") {
    const { apiKey, secretKey, forceRefresh = false } = message;
    getCachedBaiduToken(apiKey, secretKey, forceRefresh)
      .then(token => sendResponse({ success: true, token }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 2. 图片转 base64
  if (message.type === "FETCH_IMAGE_BASE64") {
    fetchImageAsBase64(message.imageUrl, message.pageUrl)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
