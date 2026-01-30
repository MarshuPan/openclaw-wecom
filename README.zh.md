# OpenClaw 企业微信插件（双模式）

中文 | [English](README.en.md)

OpenClaw WeCom 插件，支持 **智能机器人 API 模式** 与 **自建应用模式**（双模式），并支持多账户、媒体消息与群聊。

> 以 `docs/TECHNICAL.md` 为准；开发前请先阅读。

## 功能概览
- 双模式：Bot API（JSON 回调 + stream）/ App（XML 回调 + ACK + 主动发送）
- 多账户：`channels.wecom.accounts`
- 消息类型：文本 / 图片 / 语音 / 视频 / 文件（收发均支持）
- 机器人命令：`/help`、`/status`、`/clear`
- 稳定性：签名校验、AES 解密、token 缓存、限流与重试
- 群聊：自动识别 `chatId` 并使用 `appchat/send`

## 安装
### npm 安装
```bash
openclaw plugins install @openclaw/wecom-dual
openclaw plugins enable wecom
openclaw gateway restart
```

### 本地路径加载
```bash
openclaw plugins install --link /path/to/openclaw-wecom/project
openclaw plugins enable wecom
openclaw gateway restart
```

## 配置
主配置写入：`~/.openclaw/openclaw.json`  
推荐仅使用主配置；环境变量仅作为兜底。

最小示例：`docs/wecom.config.example.json`  
全量示例：`docs/wecom.config.full.example.json`  
安装与配置说明：`docs/INSTALL.md`

### 最小配置示例
```json5
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "both",
      "webhookPath": "/wecom",
      "token": "BOT_TOKEN",
      "encodingAESKey": "BOT_AES",
      "receiveId": "BOT_ID",
      "corpId": "CORP_ID",
      "corpSecret": "CORP_SECRET",
      "agentId": 1000001,
      "callbackToken": "CALLBACK_TOKEN",
      "callbackAesKey": "CALLBACK_AES"
    }
  }
}
```

### 关键字段说明
- Bot 模式 `receiveId`：建议填写 **Bot ID（aibotid）**，用于回调加解密校验
- App 模式回调解密使用 **CorpID**（`corpId`）

## 回调配置（企业微信后台）
### Bot 模式
- URL：`https://你的域名/wecom`
- Token：自定义
- EncodingAESKey：后台生成
- Bot ID（aibotid）：填写到 `receiveId`

### App 模式
- URL：`https://你的域名/wecom`
- Token / EncodingAESKey：后台生成，对应 `callbackToken` / `callbackAesKey`
- CorpID / AgentID / Secret：分别对应 `corpId` / `agentId` / `corpSecret`

> 两种模式都要求公网 HTTPS；配置完成后请重启 OpenClaw gateway。

## 模式说明
- `mode: "bot"`：只启用智能机器人 API 模式
- `mode: "app"`：只启用自建应用模式
- `mode: "both"`：同时启用两种模式（默认）

## 媒体处理说明
- App 模式：收到媒体会下载到本地临时目录（可配置 `media.tempDir`）
- Bot 模式媒体桥接：当 reply payload 含 `mediaUrl + mediaType` 时，
  若已配置 App 凭据，会自动上传并发送媒体

## 常见问题
- 回调验证失败：检查 Token / AESKey / URL 是否一致
- 没有回复：确认已启用插件并重启 gateway
- 媒体过大：调整 `media.maxBytes` 或发送更小文件
- invalid access_token：检查 `corpId/corpSecret/agentId`

## 资料入口
- 开发文档：`docs/TECHNICAL.md`
- 安装配置：`docs/INSTALL.md`
- 配置示例：`docs/wecom.config.example.json` / `docs/wecom.config.full.example.json`
