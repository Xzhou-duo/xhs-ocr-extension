# 小红书图片文字提取插件 - 开发交接文档

## 当前状态

版本：`1.0.1`

Chrome / Edge Manifest V3 扩展。在小红书网页图文笔记中收集图片，调用百度通用文字识别接口批量 OCR，并支持单条或全部复制。

截至 2026-06-15，单图、多图、懒加载图片、跨域图片获取、百度 OCR 和结果复制已经用户实测通过。

## 关键设计

- `core_utils.js`：共享 URL 选择、去重键和错误映射。
- `background.js`：缓存百度 Token，通过 Service Worker 获取图片并转 Base64。
- `content_script.js`：采集图片、触发懒加载、串行 OCR、单图重试及页面跳转中止。
- `popup.js`：保存密钥；密钥改变时废弃 Token 缓存。

图片完整 URL 只在去重比较时移除 `?` 和 `!` 后的部分，实际请求不裁剪。Content Script 不直接跨域 XHR 图床。

## 验证

在项目根目录运行：

```powershell
npm.cmd run check
npm.cmd test
```

手工回归至少覆盖单图、8 图、未提前翻页的多图、单图失败重试、复制和页面跳转中止。

详细说明见项目根目录 `HANDOFF.md`。
