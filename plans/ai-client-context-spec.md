# AI 客户端上下文注入 — 让 AI 知道「用户在用什么端对话」

## 背景（根因，2026-10-25 多 agent 摸底确认）

用户经 APK（WebView 壳，跑完整 Web App）对话问 AI「我在用什么」，AI 答「电脑桌面客户端」。三重根因：
1. `simple_ai/prompt.rs` persona 写死 "built into the Polaris **desktop** app"，无条件注入所有 SimpleAI 会话；
2. `simple_ai/context.rs` `<environment_context>` 只注入**服务端** os/cwd/shell，强化错误推断；
3. 协议无客户端身份：`ChatRequestOptions` 无 client 字段，HTTP 入口只有 Bearer token。

## 目标

模型能基于事实回答客户端环境；服务端环境与客户端环境显式区分。

## 方案（接口）

- 协议：`ChatRequestOptions` 新增 `clientType?: string`、`clientPlatform?: string`（serde camelCase，向后兼容，旧端不传则不注入）。`SessionOptions` 镜像两字段。
- 前端：`services/transport/detector.ts` 新增 `detectClientDescriptor()`（desktop / web / mobile-web / mobile-app[Android WebView `; wv)` 标记或移动 Tauri runtime] + platform），`createConversationStore` 的 `chatOptions` 附带两字段（start/continue 两个 dispatch 点共用）。
- 后端注入（`ai_chat_core` start/continue 共用 helper）：
  - SimpleAI：`build_context_messages(work_dir, client_type, client_platform)` → `<environment_context>` 内追加 `<client><type/><platform/></client>` + 说明行（os/cwd/shell 是服务端环境，用户客户端以 `<client>` 为准）；仅首轮注入（与现有语义一致）。
  - 非 SimpleAI 引擎（Claude 等）：向 `append_system_prompt` 追加一行客户端事实陈述。
  - OpenCode 忽略 system_prompt（现状即盲，不在本期范围）。
- persona：删除 "built into the Polaris desktop app" 表述，改为 "served by the Polaris runtime"；Tools 段引导查 `<client>`。
- 顺带不改：session 事件 `device_id="core"`（仲裁语义，另行评估）；`cap.self.inspect` clients 字段（Phase 3）。

## 验收

- `cargo check` + `pnpm typecheck` + 相关 vitest（context.rs tests 更新为新签名 + 新增 client 用例）。
- APK/移动端会话首轮 `<environment_context>` 含正确 `<client>`；桌面会话含 `desktop`。

## 后续（本期不做）

按客户端类型裁剪工具暴露面（移动端不暴露 bash/computer）；`X-Polaris-Client` 请求头（非 WebView 第三方客户端出现时再加）。
