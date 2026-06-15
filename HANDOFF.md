# 小红书图片文字提取插件 - 开发交接文档

## 当前状态

版本：`1.0.1`

Chrome / Edge Manifest V3 扩展。在小红书网页图文笔记中收集图片，调用百度通用文字识别接口批量 OCR，并支持单条或全部复制。

截至 2026-06-15，以下核心流程已经用户实测通过：

- 单图和多图采集
- 未提前翻页图片的懒加载处理
- 图片跨域获取与 Base64 转换
- 百度 OCR 串行识别
- 识别结果复制

## 项目结构

```text
xhs-ocr-extension/
├── manifest.json
├── core_utils.js       # URL、去重和错误映射共享工具
├── background.js       # Token 缓存、图片获取与 Base64 转换
├── content_script.js   # 页面 UI、图片采集和 OCR 流程
├── content_style.css
├── popup.html
├── popup.js
└── icons/
tests/
└── core_utils.test.js
```

## 当前实现

### 图片采集

- 优先按 `.swiper-slide` DOM 顺序采集，过滤 Swiper 重复节点。
- 找不到轮播时，在笔记容器内扫描图片并按渲染尺寸过滤头像和图标。
- 设置 `loading="eager"` 触发未浏览图片加载。
- URL 去除 `?` 和 `!` 后的部分仅作为去重键，实际请求始终保留完整 URL。
- 每次请求和重试前重新读取 `currentSrc`、懒加载属性及 `src`，避免使用过期地址。

### 图片请求

Content Script 不直接跨域请求图床。它发送 `FETCH_IMAGE_BASE64` 消息，由具备 `*.xhscdn.com` host permission 的 Service Worker 获取图片并转为 Base64。

Service Worker 的图片请求：

- 先尝试携带登录凭据请求。
- 失败后尝试普通请求。
- 每次请求 15 秒超时。
- 两种方式都失败时返回可读的中文错误。

### 百度 Token

- `GET_BAIDU_TOKEN` 消息接口保持不变，支持可选的 `forceRefresh`。
- Token 和过期时间缓存在 `chrome.storage.local`，过期前 5 分钟刷新。
- API Key 或 Secret Key 改变时，popup 会废弃缓存。
- 百度返回 Token 无效错误时，自动强制刷新并重试一次。

### OCR 和错误恢复

- 图片串行处理，每张间隔 350ms。
- 普通失败等待 600ms 后自动重试一次。
- 区分密钥错误、图片获取失败、网络超时、限流、额度不足和图片格式错误。
- 单张失败会显示“重试此图”，不会清空其他成功结果。
- 批处理使用 `try/finally` 恢复按钮状态。
- 识别期间切换页面时，剩余图片显示“识别已中止”。

## 开发与验证

```powershell
npm.cmd run check
npm.cmd test
```

手工回归：

1. 在 `chrome://extensions` 或 `edge://extensions` 加载 `xhs-ocr-extension`。
2. 在 popup 保存百度 API Key 和 Secret Key。
3. 分别验证单图、8 图以及未提前翻页的多图笔记。
4. 验证单图重试、复制单条、复制全部和页面跳转中止。
5. 更换错误密钥，确认显示中文密钥错误。

## 已知边界

- 小红书 DOM 类名或轮播结构变化时，图片选择器可能需要同步调整。
- 正式商店发布前仍需准备正式图标、隐私说明和商店素材。
- API Key 与 Token 保存在本机 `chrome.storage.local`，不会发送到扩展作者的服务器。

## 发布

发布包名称：`xhs-ocr-extension-v1.0.1.zip`

ZIP 根目录直接包含 `manifest.json`，可用于浏览器“加载已解压的扩展程序”前的分发和解压。
