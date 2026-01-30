# OpenClaw WeCom 插件（双模式）技术开发文档

> 目标：在 `project/` 下实现一个新的 OpenClaw WeCom 插件，结构与 `openclaw-wecom-channel` 保持一致，功能与 `OpenClaw-Wechat` 对齐，同时保留智能机器人 API 模式的 stream 被动回复能力。

## 1. 范围与目标

### 1.1 支持范围
- **双模式**：
  - 智能机器人 API 模式（JSON 加密回调 + stream 被动回复）
  - 企业微信自建应用（XML 加密回调 + ACK 异步处理 + 主动发送）
- **多账户**：支持 `channels.wecom.accounts` 多账户配置
- **媒体能力**：图片接收/发送，语音接收（识别）、文件/视频预留
- **命令系统**：`/help`、`/status`、`/clear`
- **安全**：签名验证 + AES-256-CBC 加解密
- **稳定性**：access_token 缓存、并发锁、API 限流

### 1.2 非目标（初期）
- Wechaty 深度接入（仅保留适配层边界）
- UI/管理面板

## 2. 架构分层

```
HTTP Webhook
    |--> Bot API Handler (JSON)  ----> Stream reply
    |--> App Handler (XML)      ----> ACK + async agent + send API
             |                         |
             v                         v
      Message Normalize            WeCom API Client
             |
             v
       OpenClaw Agent Runtime
```

### 模块职责
- `channel.ts`: Channel 元信息、能力声明、配置处理、网关生命周期
- `monitor.ts`: HTTP 入口统一路由与目标注册
- `wecom-bot.ts`: 智能机器人 API 模式（JSON 加密、stream）
- `wecom-app.ts`: 自建应用模式（XML 加密、ACK + 主动发送）
- `wecom-api.ts`: token 缓存、限流、发送/上传/下载
- `crypto.ts`: 签名 + AES 加解密
- `format.ts`: Markdown 转文本 + 2048 字节分段
- `commands.ts`: /help /status /clear
- `accounts.ts`: 多账户解析与合并
- `types.ts`: 类型定义

## 3. 数据流与处理流程

### 3.1 智能机器人 API 模式（JSON + stream）
1. WeCom 回调到 `webhookPath`（JSON 加密）
2. `monitor.ts` -> `wecom-bot.ts`
3. 验签、解密
4. 创建 streamId + 先回复占位符
5. 异步调用 Agent 处理
6. WeCom 通过 `msgtype=stream` 回调刷新，返回当前 stream 内容

### 3.2 自建应用模式（XML + 主动发送）
1. WeCom 回调到 `webhookPath`（XML 加密）
2. `monitor.ts` -> `wecom-app.ts`
3. 验签、解密
4. **立即 ACK 200**
5. 异步处理消息
6. 调用 WeCom API 发送文本/图片等消息

## 4. 配置设计

### 4.1 配置入口
优先级（高 → 低）：
1. `channels.wecom` / `channels.wecom.accounts`
2. `env.vars`（兼容旧插件）
3. 进程环境变量

### 4.2 建议配置结构
```json5
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "both",
      "webhookPath": "/wecom",

      // Bot API 模式
      "token": "BOT_TOKEN",
      "encodingAESKey": "BOT_AES",
      "receiveId": "",

      // 自建应用模式
      "corpId": "CORP_ID",
      "corpSecret": "CORP_SECRET",
      "agentId": 1000001,
      "callbackToken": "CALLBACK_TOKEN",
      "callbackAesKey": "CALLBACK_AES",

      "dm": { "policy": "pairing" }
    }
  }
}
```

### 4.3 多账户示例
```json5
{
  "channels": {
    "wecom": {
      "defaultAccount": "default",
      "accounts": {
        "default": {
          "mode": "both",
          "webhookPath": "/wecom",
          "token": "...",
          "encodingAESKey": "...",
          "corpId": "...",
          "corpSecret": "...",
          "agentId": 1000002,
          "callbackToken": "...",
          "callbackAesKey": "..."
        },
        "sales": {
          "mode": "app",
          "webhookPath": "/wecom/sales",
          "corpId": "...",
          "corpSecret": "...",
          "agentId": 1000003,
          "callbackToken": "...",
          "callbackAesKey": "..."
        }
      }
    }
  }
}
```

## 5. 消息支持清单

### 入站
- 文本 ✅
- 图片 ✅
- 语音 ✅（识别字段优先）
- 文件 ✅（预留处理）
- 视频 ✅（预留处理）
- 链接 ✅
- 事件 ✅（enter_chat 等）

### 出站
- 文本 ✅（分段 + Markdown 转纯文本）
- 图片 ✅（上传后发送）
- 文件/视频 ✅（预留）
- Bot API stream ✅

## 6. 命令系统
- `/help`：展示使用帮助
- `/status`：运行状态/账户信息
- `/clear`：清空会话历史

## 7. 安全与稳定性
- 签名验证（SHA1）
- AES-256-CBC 解密/加密
- 请求体大小限制（1MB）
- token 缓存（按 corpId）
- 并发刷新锁（Promise 锁）
- API 限流（RateLimiter）

## 8. npm 安装支持
- `package.json` 已配置 `openclaw.install.npmSpec`
- 可通过 `openclaw plugins install <package>` 安装
- 需保证发布到 npm 时 `name` 与 `npmSpec` 一致

> 当前 `package.json` 使用 `@openclaw/wecom-dual`，如需更改，请同步更新 `openclaw.install.npmSpec`。

## 9. 目录结构（当前骨架）

```
project/
  package.json
  docs/
    TECHNICAL.md
  wecom/
    index.ts
    openclaw.plugin.json
    package.json
    src/
      accounts.ts
      channel.ts
      commands.ts
      config-schema.ts
      crypto.ts
      format.ts
      monitor.ts
      runtime.ts
      types.ts
      wecom-api.ts
      wecom-app.ts
      wecom-bot.ts
```

## 10. 后续实现清单（分阶段）

### 阶段 1：基础可跑
- [ ] Bot API 模式解密/验签
- [ ] stream 占位 + refresh 回复
- [ ] Agent runtime 调用
- [ ] App 模式 XML 解密/验签 + ACK

### 阶段 2：主动发送 & 媒体
- [ ] access_token 缓存 + 刷新
- [ ] sendText + 分段
- [ ] 上传媒体 + 图片发送
- [ ] 语音识别 + 结构化输入

### 阶段 3：体验与稳定
- [ ] Markdown 转文本
- [ ] /help /status /clear 命令
- [ ] RateLimiter
- [ ] 详细日志与状态统计

## 11. 兼容性策略
- OpenClaw 与 Clawdbot 均支持（`openclaw`/`clawdbot` metadata）
- Wechaty 仅做接口适配边界，不做强依赖

