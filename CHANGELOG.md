# Changelog

## 0.1.13 - 2026-01-31
- App 模式入站媒体落盘写入 MediaPath/MediaType，避免图片/文件读取失败。
- App 模式增加媒体保存日志，便于排查下载失败。

## 0.1.14 - 2026-01-31
- App 模式入站媒体回复提示包含最新保存路径，避免模型误用旧路径。

## 0.1.15 - 2026-01-31
- 入站媒体不再在文本中暴露本地路径，仅通过 `MediaPath/MediaType` 传递。
- Bot/App 媒体缓存（基于 mediaId/URL）与保留期对齐，减少重复下载。
- 追加 MediaMimeType 供上层识别。

## 0.1.31 - 2026-02-01
- App outbound media: treat local file paths in mediaUrl as local path (fix sendfile/path sends).

## 0.1.32 - 2026-02-01
- Docs: clarify video recognition is verified in App mode; Bot mode requires extra config.

## 0.1.30 - 2026-01-31
- Bot inbound image/file: decrypt URL media with encodingAESKey (no app creds needed).
- Bot A2UI template_card: send card via response_url in single chat, fallback to text.
- Bot template_card_event: convert interactions into text for the agent.

## 0.1.29 - 2026-01-31
- Bot stream placeholder text changed to "\ud83e\udd14\u601d\u8003\u4e2d...".

## 0.1.28 - 2026-01-31
- Refactor: shared media utils for Bot/App (temp dir, filename sanitize, retention).
- Bot/App: clearer media errors (Bot-only media, size limit).
- File list pagination: reply “更多” to see next page.
- Media download: early size guard via Content-Length.
- Docs: add manual testing checklist.

## 0.1.27 - 2026-01-31
- Docs: clarify Bot-only media limitations; add MIT license.

## 0.1.26 - 2026-01-31
- Bot 模式入站媒体支持 data URI base64 解析与 mediaId 下载兜底。
- Bot 模式语音入站识别字段兼容（recognition/text/transcript）。
- Bot 模式媒体 URL 字段兼容增强（image_url/download_url 等）。

## 0.1.25 - 2026-01-31
- 自然语言触发文件发送：多文件时返回列表并支持确认发送。

## 0.1.24 - 2026-01-31
- 自然语言触发文件发送（匹配 `media.tempDir` 文件名）。

## 0.1.23 - 2026-01-31
- 视频识别支持 light / full 两种模式（多帧抽取）。
- 图片识别增加重试与失败记录（操作日志）。

## 0.1.22 - 2026-01-31
- 图片识别增加重试与失败记录（操作日志）。

## 0.1.21 - 2026-01-31
- 文档补充：/sendfile、自动识别、ffmpeg 依赖与配置说明。

## 0.1.20 - 2026-01-31
- /sendfile 支持目录打包 zip、多文件队列发送与操作日志。
- 多媒体自动识别（语音转写、文本文件预览、视频首帧识别）。

## 0.1.19 - 2026-01-31
- 增加 /sendfile 命令：一句话发送服务器文件，支持多文件与引号路径。

## 0.1.18 - 2026-01-31
- 新增主动推送接口（`<webhookPath>/push`），支持多条消息与文件发送。
- 新增 pushToken 配置与环境变量支持。

## 0.1.17 - 2026-01-31
- 出站媒体支持本地路径与 base64（mediaPath/mediaBase64），完善文件发送能力。
- 入站文件提示 Read 工具并附带保存路径，便于读取内容。

## 0.1.16 - 2026-01-31
- 图片入站支持可选 Vision 预识别（OpenAI 兼容接口），避免 Read 工具循环。
- 识别结果写入消息文本，仍保留 MediaPath/MediaType。

## 0.1.12 - 2026-01-31
- Bot handler now skips non-bot endpoints so App XML callbacks are not blocked.

## 0.1.11 - 2026-01-31
- Docs: recommend split webhook paths for Bot/App, update full config example.

## 0.1.10 - 2026-01-31
- Bot 模式入站媒体落盘后写入 MediaPath/MediaType 以触发 OpenClaw 媒体理解管线。

## 0.1.9 - 2026-01-31
- Bot 模式入站图片/语音/视频/文件支持下载落盘并在上下文中提示 Read 工具（OCR/识图）。

## 0.1.5 - 2026-01-31
- Fix install docs to use `openclaw-wecom` plugin id for enable.

## 0.1.4 - 2026-01-31
- Rename npm package to `@marshulll/openclaw-wecom`.

## 0.1.3 - 2026-01-31
- Add JSON schema fallback for config schema to support OpenClaw runtimes.

## 0.1.2 - 2026-01-31
- Align plugin id with package name (`wecom-dual`) to avoid install warnings.

## 0.1.1 - 2026-01-31
- Add root `openclaw.plugin.json` for OpenClaw plugin discovery.

## 0.1.0 - 2026-01-31
- Initial public release of the OpenClaw WeCom dual-mode plugin.
- Bot API mode (JSON callbacks + stream replies).
- App mode (XML callbacks + ACK + proactive send).
- Multi-account support and media handling (text/image/voice/video/file).
- Configuration templates and bilingual README.

