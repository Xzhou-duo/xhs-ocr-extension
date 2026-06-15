(function (root) {
  function isXhsImageUrl(src) {
    return !!src && /xhscdn\.com|xiaohongshu\.com/.test(src) && !src.startsWith("data:");
  }

  function imageDedupeKey(src) {
    return (src || "").split("?")[0].split("!")[0];
  }

  function pickImageUrl(candidates, fallback = "") {
    return candidates.find(isXhsImageUrl) || fallback;
  }

  function isTokenErrorCode(code) {
    return code === 110 || code === 111;
  }

  function isTokenCacheValid(
    cache,
    apiKey,
    secretKey,
    now = Date.now(),
    expiryBufferMs = 5 * 60 * 1000
  ) {
    return !!(
      cache &&
      cache.apiKey === apiKey &&
      cache.secretKey === secretKey &&
      cache.expiresAt - expiryBufferMs > now
    );
  }

  function baiduErrorMessage(code, message = "") {
    if (isTokenErrorCode(code)) return "百度授权已过期，正在重新授权";
    if (code === 18) return "百度 OCR 请求过于频繁，请稍后重试";
    if (code === 4 || code === 17 || code === 19) return "百度 OCR 调用额度不足";
    if (code === 216201 || code === 216202 || code === 216203) {
      return "图片格式或大小不符合百度 OCR 要求";
    }
    return message ? `百度 OCR 识别失败：${message}` : `百度 OCR 识别失败（错误码 ${code}）`;
  }

  function normalizeError(error) {
    const message = error?.message || String(error || "");
    if (/invalid client|API Key|Secret Key/i.test(message)) {
      return "百度 API Key 或 Secret Key 无效";
    }
    if (/Token 请求失败/i.test(message)) return `获取百度授权失败：${message}`;
    if (/图片获取失败|图片请求失败|403|404/.test(message)) {
      return `图片获取失败：${message.replace(/^图片获取失败[:：]?\s*/, "")}`;
    }
    if (/timeout|超时/i.test(message)) return "网络请求超时，请稍后重试";
    if (/Failed to fetch|NetworkError|网络请求失败/i.test(message)) {
      return "网络连接失败，请检查网络后重试";
    }
    return message || "识别失败，请稍后重试";
  }

  const api = {
    baiduErrorMessage,
    imageDedupeKey,
    isTokenCacheValid,
    isTokenErrorCode,
    isXhsImageUrl,
    normalizeError,
    pickImageUrl,
  };

  root.XhsOcrUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
