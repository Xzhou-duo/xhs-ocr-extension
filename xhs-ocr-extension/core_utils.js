(function (root) {
  function isXhsImageUrl(src) {
    return !!src && /xhscdn\.com|xiaohongshu\.com/.test(src) && !src.startsWith("data:");
  }

  function imageDedupeKey(src) {
    return (src || "").split("?")[0].split("!")[0];
  }

  function hasPostImageDimensions(width, height, minSize = 120) {
    const renderedWidth = Number(width) || 0;
    const renderedHeight = Number(height) || 0;
    return (
      (renderedWidth === 0 || renderedWidth >= minSize) &&
      (renderedHeight === 0 || renderedHeight >= minSize)
    );
  }

  function imagePickerScrollState(scrollLeft, clientWidth, scrollWidth, tolerance = 2) {
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    return {
      canScroll: maxScrollLeft > tolerance,
      canScrollLeft: scrollLeft > tolerance,
      canScrollRight: scrollLeft < maxScrollLeft - tolerance,
    };
  }

  function findHistoryEntry(history, src) {
    const key = imageDedupeKey(src);
    return (Array.isArray(history) ? history : []).find(entry => entry?.key === key) || null;
  }

  function findReusableHistoryEntry(history, src, noteKey = "", imageIndex = null) {
    const directMatch = findHistoryEntry(history, src);
    if (directMatch?.result) return directMatch;
    if (!noteKey || !Number.isInteger(imageIndex)) return null;

    return (Array.isArray(history) ? history : []).find(entry => {
      return (
        entry?.result &&
        historyEntryNoteKey(entry) === noteKey &&
        entry.imageIndex === imageIndex
      );
    }) || null;
  }

  function countReusableHistoryEntries(history, images, noteKey = "") {
    return (Array.isArray(images) ? images : []).filter((image, index) => {
      const src = typeof image === "string" ? image : image?.src;
      const imageIndex = Number.isInteger(image?.imageIndex) ? image.imageIndex : index;
      return !!findReusableHistoryEntry(history, src, noteKey, imageIndex);
    }).length;
  }

  function upsertHistoryEntry(history, entry, limit = 100) {
    const entries = Array.isArray(history) ? history : [];
    return [
      entry,
      ...entries.filter(item => item?.key !== entry?.key),
    ].slice(0, limit);
  }

  function noteKeyFromUrl(url) {
    const value = String(url || "");
    const match = value.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/);
    if (match) return `note:${match[1]}`;

    try {
      const parsed = new URL(value);
      return parsed.pathname && parsed.pathname !== "/"
        ? `path:${parsed.origin}${parsed.pathname}`
        : "";
    } catch {
      return "";
    }
  }

  function historyEntryNoteKey(entry) {
    return entry?.noteKey || noteKeyFromUrl(entry?.noteUrl) || `image:${entry?.key || ""}`;
  }

  function groupHistoryByNote(history) {
    const groups = new Map();
    (Array.isArray(history) ? history : []).forEach(entry => {
      if (!entry?.key) return;
      const noteKey = historyEntryNoteKey(entry);
      if (!groups.has(noteKey)) {
        groups.set(noteKey, {
          noteKey,
          noteTitle: "",
          noteUrl: "",
          updatedAt: 0,
          totalImages: 0,
          entries: [],
        });
      }

      const group = groups.get(noteKey);
      group.entries.push(entry);
      group.noteTitle ||= entry.noteTitle || "";
      group.noteUrl ||= entry.noteUrl || "";
      group.updatedAt = Math.max(group.updatedAt, Number(entry.extractedAt) || 0);
      group.totalImages = Math.max(group.totalImages, Number(entry.totalImages) || 0);
    });

    return Array.from(groups.values())
      .map(group => {
        group.entries.sort((a, b) => {
          const aIndex = Number.isInteger(a.imageIndex) ? a.imageIndex : null;
          const bIndex = Number.isInteger(b.imageIndex) ? b.imageIndex : null;
          if (aIndex !== null && bIndex !== null) return aIndex - bIndex;
          if (aIndex !== null) return -1;
          if (bIndex !== null) return 1;
          return (Number(a.extractedAt) || 0) - (Number(b.extractedAt) || 0);
        });
        group.totalImages = Math.max(group.totalImages, group.entries.length);
        return group;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
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
    countReusableHistoryEntries,
    findHistoryEntry,
    findReusableHistoryEntry,
    groupHistoryByNote,
    hasPostImageDimensions,
    historyEntryNoteKey,
    imageDedupeKey,
    imagePickerScrollState,
    isTokenCacheValid,
    isTokenErrorCode,
    isXhsImageUrl,
    noteKeyFromUrl,
    normalizeError,
    pickImageUrl,
    upsertHistoryEntry,
  };

  root.XhsOcrUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
