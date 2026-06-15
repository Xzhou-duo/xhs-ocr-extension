const test = require("node:test");
const assert = require("node:assert/strict");

const {
  baiduErrorMessage,
  countReusableHistoryEntries,
  findHistoryEntry,
  findReusableHistoryEntry,
  groupHistoryByNote,
  hasPostImageDimensions,
  imageDedupeKey,
  imagePickerScrollState,
  isTokenCacheValid,
  isTokenErrorCode,
  noteKeyFromUrl,
  normalizeError,
  pickImageUrl,
  upsertHistoryEntry,
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

test("post image dimensions reject avatars but allow content and unloaded images", () => {
  assert.equal(hasPostImageDimensions(64, 64), false);
  assert.equal(hasPostImageDimensions(640, 800), true);
  assert.equal(hasPostImageDimensions(0, 0), true);
});

test("image picker scroll state tracks overflow and both edges", () => {
  assert.deepEqual(imagePickerScrollState(0, 300, 300), {
    canScroll: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  assert.deepEqual(imagePickerScrollState(0, 300, 600), {
    canScroll: true,
    canScrollLeft: false,
    canScrollRight: true,
  });
  assert.deepEqual(imagePickerScrollState(150, 300, 600), {
    canScroll: true,
    canScrollLeft: true,
    canScrollRight: true,
  });
  assert.deepEqual(imagePickerScrollState(300, 300, 600), {
    canScroll: true,
    canScrollLeft: true,
    canScrollRight: false,
  });
});

test("history entries match signed variants and keep the newest unique records", () => {
  const oldEntry = { key: "https://img/1", extractedAt: 1 };
  const otherEntry = { key: "https://img/2", extractedAt: 2 };
  const newEntry = { key: "https://img/1", extractedAt: 3 };

  assert.equal(
    findHistoryEntry(
      [oldEntry],
      "https://img/1!format?token=changed"
    ),
    oldEntry
  );
  assert.deepEqual(
    upsertHistoryEntry([oldEntry, otherEntry], newEntry, 2),
    [newEntry, otherEntry]
  );
});

test("reusable history count includes only matching entries with OCR results", () => {
  const history = [
    {
      key: "https://img/1",
      result: { text: "cached" },
    },
    {
      key: "https://img/2",
    },
  ];

  assert.equal(
    countReusableHistoryEntries(history, [
      "https://img/1!format?token=changed",
      "https://img/2",
      "https://img/3",
    ]),
    1
  );
});

test("reusable history falls back to note and image index when CDN paths change", () => {
  const cached = {
    key: "https://old-cdn/image-a",
    noteKey: "note:postA",
    imageIndex: 1,
    result: { text: "cached" },
  };
  const history = [cached];

  assert.equal(
    findReusableHistoryEntry(
      history,
      "https://new-cdn/image-b?token=fresh",
      "note:postA",
      1
    ),
    cached
  );
  assert.equal(
    findReusableHistoryEntry(
      history,
      "https://new-cdn/image-b?token=fresh",
      "note:postB",
      1
    ),
    null
  );
  assert.equal(
    countReusableHistoryEntries(
      history,
      [{ src: "https://new-cdn/image-b", imageIndex: 1 }],
      "note:postA"
    ),
    1
  );
});

test("noteKeyFromUrl ignores query parameters and recognizes both detail routes", () => {
  assert.equal(
    noteKeyFromUrl("https://www.xiaohongshu.com/explore/abc123?xsec_token=one"),
    "note:abc123"
  );
  assert.equal(
    noteKeyFromUrl("https://www.xiaohongshu.com/discovery/item/abc123?xsec_token=two"),
    "note:abc123"
  );
});

test("groupHistoryByNote groups posts, orders images and keeps newest posts first", () => {
  const groups = groupHistoryByNote([
    {
      key: "post-a-2",
      noteUrl: "https://www.xiaohongshu.com/explore/postA?xsec_token=two",
      imageIndex: 1,
      totalImages: 2,
      extractedAt: 20,
    },
    {
      key: "post-b-1",
      noteKey: "note:postB",
      noteTitle: "帖子 B",
      imageIndex: 0,
      totalImages: 1,
      extractedAt: 30,
    },
    {
      key: "post-a-1",
      noteUrl: "https://www.xiaohongshu.com/explore/postA?xsec_token=one",
      imageIndex: 0,
      totalImages: 2,
      extractedAt: 10,
    },
  ]);

  assert.deepEqual(groups.map(group => group.noteKey), ["note:postB", "note:postA"]);
  assert.deepEqual(groups[1].entries.map(entry => entry.key), ["post-a-1", "post-a-2"]);
  assert.equal(groups[1].totalImages, 2);
});

test("groupHistoryByNote supports legacy entries without image indices", () => {
  const groups = groupHistoryByNote([
    {
      key: "legacy-2",
      noteUrl: "https://www.xiaohongshu.com/explore/legacy",
      extractedAt: 20,
    },
    {
      key: "legacy-1",
      noteUrl: "https://www.xiaohongshu.com/explore/legacy",
      extractedAt: 10,
    },
  ]);

  assert.deepEqual(groups[0].entries.map(entry => entry.key), ["legacy-1", "legacy-2"]);
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
