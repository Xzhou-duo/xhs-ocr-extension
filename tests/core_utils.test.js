const test = require("node:test");
const assert = require("node:assert/strict");

const {
  baiduErrorMessage,
  imageDedupeKey,
  isTokenCacheValid,
  isTokenErrorCode,
  normalizeError,
  pickImageUrl,
} = require("../xhs-ocr-extension/core_utils.js");

test("pickImageUrl skips placeholders and keeps the complete signed URL", () => {
  const signedUrl =
    "https://sns-webpic-qc.xhscdn.com/path/image!nd_dft_webp_3?token=abc";
  assert.equal(
    pickImageUrl(["data:image/png;base64,abc", "", signedUrl]),
    signedUrl
  );
});

test("imageDedupeKey removes formatting and query parts only for comparison", () => {
  assert.equal(
    imageDedupeKey("https://sns-webpic-qc.xhscdn.com/path/image!format?token=abc"),
    "https://sns-webpic-qc.xhscdn.com/path/image"
  );
});

test("Baidu token errors are identifiable and receive a Chinese message", () => {
  assert.equal(isTokenErrorCode(110), true);
  assert.equal(isTokenErrorCode(111), true);
  assert.equal(baiduErrorMessage(110), "百度授权已过期，正在重新授权");
});

test("Baidu rate limit and quota errors have distinct messages", () => {
  assert.match(baiduErrorMessage(18), /请求过于频繁/);
  assert.match(baiduErrorMessage(17), /额度不足/);
  assert.match(baiduErrorMessage(216201), /图片格式或大小/);
});

test("normalizeError distinguishes credentials, image fetch, timeout and network", () => {
  assert.equal(
    normalizeError(new Error("invalid client_id")),
    "百度 API Key 或 Secret Key 无效"
  );
  assert.match(normalizeError(new Error("Token 请求失败: 500")), /获取百度授权失败/);
  assert.match(normalizeError(new Error("图片获取失败(403/403)")), /^图片获取失败/);
  assert.equal(
    normalizeError(new Error("网络请求超时")),
    "网络请求超时，请稍后重试"
  );
  assert.equal(
    normalizeError(new Error("Failed to fetch")),
    "网络连接失败，请检查网络后重试"
  );
});

test("token cache expires when credentials change or the safety buffer is reached", () => {
  const cache = {
    apiKey: "api-key",
    secretKey: "secret-key",
    expiresAt: 2_000_000,
  };
  assert.equal(
    isTokenCacheValid(cache, "api-key", "secret-key", 1_000_000, 300_000),
    true
  );
  assert.equal(
    isTokenCacheValid(cache, "new-key", "secret-key", 1_000_000, 300_000),
    false
  );
  assert.equal(
    isTokenCacheValid(cache, "api-key", "secret-key", 1_800_000, 300_000),
    false
  );
});
