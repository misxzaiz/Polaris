# opencode 引擎 incompatibleRuntime 报错修复

状态：已实施
日期：2026-10-26
涉及文件：
- `src/stores/conversationStore/types.ts`（CreateSessionOptions 加 profileMode）
- `src/stores/conversationStore/sessionStoreManager.ts`（createSession 透传 profileMode）
- `src-tauri/src/services/ai_chat_core.rs`（OpenCode 豁免 is_for_engine 校验）
- `src/stores/conversationStore/sessionStoreManager.engineInitialization.test.ts`（新增透传测试）

## 根因

用户用 opencode 引擎 + 官方免费模型时报「所选模型供应商不适用于当前引擎」。

### 根因 1：`createSession` 漏写 `profileMode`（会话级官方选择丢失）

用户在新建面板选择「官方 API」时，`providerSelection()` 返回 `{ profileMode: 'official', modelProfileId: '__official_api__' }`。
但 `createSession` 构造 `SessionMetadata` 时**只写了 `modelProfileId`，漏写 `profileMode`**（`sessionStoreManager.ts` metadata 对象无该字段），尽管 `SessionMetadata.profileMode` 字段与 `CreateSessionOptions` 均已存在。

发送链路 `createConversationStore.ts:2278-2284` 读取 `sessionMeta.profileMode` → 因为是 `undefined`，回落到状态栏镜像 `sessionConfig.profileMode`（持久化默认 `'profile'`）。于是：
- mode = `'profile'` → `isProfileModeWithoutProfile('profile') = false`
- `effectiveProfileId = modelProfileId`
- 若会话 meta 或镜像残留了真实旧 Profile id（例如新建面板默认值来自 `globalActiveProfileId`），该 id 被带上后端
- 后端 `is_for_engine('open-code')` 对旧 Profile（targetEngines 只含 claude/simple-ai）失败 → `incompatibleRuntime` 中断

即：**用户「选了官方」，但官方语义因 profileMode 丢失而回落 profile 模式，旧 Profile id 穿透。**

### 根因 2：后端对 opencode 引擎无 Profile 兼容性豁免

`apply_model_profile_options`（`ai_chat_core.rs:455`）对任何引擎都先做 `is_for_engine` 硬校验。
opencode 有自己的 provider 体系（`--model <provider>/<model>`），Polaris Profile 的 `targetEngines` 通常只标了 claude/simple-ai，
残留任一旧 Profile id 都会误中断请求。代码注释也承认「opencode 自带 provider 体系，Profile 端点注入是二阶能力」。

## 修复

1. `CreateSessionOptions` 加 `profileMode?: ProfileMode`。
2. `createSession` metadata 构造加 `profileMode: options.profileMode`——会话级官方选择持久化，不回落镜像。
3. `apply_model_profile_options` 对 `EngineId::OpenCode` 豁免 `is_for_engine` 兼容性校验（保留下方 `OPENAI_BASE_URL/API_KEY` 注入分支，Profile 仍可作二阶端点注入，只是不再因 targetEngines 不匹配拦截）。

## 验收

- [x] `cargo check --lib` 通过（41 个既有 dead_code warning，无新增）
- [x] `cargo check --no-default-features --bin polaris-web` 通过
- [x] vitest `sessionStoreManager.engineInitialization.test.ts` 5/5 通过（含新增 profileMode 透传测试）
- [x] ESLint 改动文件通过

## 已知边界

- 存量 `ChatInput.tsx:1330` 的 tsc 错误（`buildTcbReferencePrompt` 缺失）为会话开始前的既有问题，与本改动无关。
- 历史已有会话（重启前创建）meta 仍无 `profileMode`，官方选择在重启后仍会回落镜像；用户可在状态栏重新切一次官方生效，或由下次新建会话自动带上。