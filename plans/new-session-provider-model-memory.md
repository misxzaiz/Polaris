# 新建会话：模型供应商/模型选择 + cap.kv 引擎级记忆

> 目标：新建会话时（NewSessionButton 下拉 + CreateSessionModal）在「AI 引擎」选择之外，
> 支持选择「模型供应商（Profile / 官方 API）」与「模型」，并按 **AI 引擎** 用 cap.kv
> 记住上次选择，下次新建会话自动恢复。
>
> 对应请求：新建会话支持选择模型供应商和模型，并且按 AI 引擎记住选择的模型和模型供应商，使用 cap.kv 记忆。

## 一、现状与缺口

- `NewSessionButton`（`src/components/Chat/session/NewSessionButton.tsx`）已支持选引擎，
  并用 **localStorage** 记住「上次选的引擎」（`polaris-last-new-session-engine`）。
  无「模型供应商 / 模型」选择。
- `CreateSessionModal`（`src/components/Session/CreateSessionModal.tsx`）仅选引擎。
- 会话 metadata（`SessionMetadata`）已承载 `modelProfileId` / `model` / `profileMode`，
  `CreateSessionOptions` 已透传这三个字段（`sessionStoreManager.createSession` 已写入 metadata）。
  **发送链路**（`createConversationStore` + `conversationStoreUtils.resolveEffective*`）已消费会话级
  Profile/模型覆盖 —— 也就是说只要新建会话时带上这三个字段，发送时就生效，无需改后端。
- `cap.kv`（`src-tauri/src/services/router/kv_capability.rs`）提供 `get/set/delete/list`，
  前端调用范式见 `src/services/promptHistoryService.ts`（RouterBus dispatch，落数据根 `kv.db`）。

## 二、设计

### 2.1 记忆模型（cap.kv，按引擎分键）

- 键：`new-session-prefs:{engineId}`，值 JSON 对象：
  ```json
  { "providerMode": "official" | "profile", "modelProfileId": "", "model": "" }
  ```
- `providerMode='official'` 时 `modelProfileId` 为空串（复用 `profileMode` 二态语义，
  `OFFICIAL_API_PROFILE` 哨兵仅用于会话级覆盖持久化，记忆层用空串表达「官方 API」即可）。
- 引擎名规范化用 `normalizeEngineId`；读不到记忆或校验失败 → 跟随全局默认
  （`config.activeModelProfileId` + `sessionConfig` 镜像），不报错只降级。

### 2.2 新建会话写入

- `NewSessionButton` 与 `CreateSessionModal` 的「创建」路径，把选定的
  `{ profileMode, modelProfileId, model }` 透传给 `createSession({ ... })`（已支持），
  并 `cap.kv.set` 写回 `new-session-prefs:{engineId}`。
- 选择器 UI 直接复用 `SessionConfigSelector`（`visibleTypes={['profile','model']}`，
  `variant='panel'`）——它已实现「Profile（官方/指定）+ 模型」联动、按引擎过滤 Profile、
  切换 Profile 清残留模型等逻辑，避免重复造轮子。

### 2.3 恢复（下次打开新建面板）

- 打开面板时：读 `new-session-prefs:{selectedEngineId}` → 若存在且值合法则恢复
  （含 Provider + Model 一并恢复）；引擎切换时也按新引擎的记忆恢复。
- 恢复的 Provider/Model 通过 `createSession` 的会话级覆盖写入新会话 metadata，
  **不修改全局 `sessionConfig` 镜像**（保持「会话级覆盖优先、全局默认兜底」的既有语义）。

### 2.4 归属与边界

- 存储唯一写入路径：cap.kv（`kv.db`）。**移除 localStorage 引擎记忆**，统一走 cap.kv
  （`new-session-prefs:{engineId}` 里也存 `engineId` 字段，兼容迁移）。
- 记忆是「新建会话面板」偏好，不涉及发送链路改动、不涉及后端 AI 调用改动。
- 读失败/解析失败一律静默降级为全局默认（参照 `promptHistoryService` 的降级范式）。

## 三、接口与验收

| 项 | 说明 |
|---|---|
| 新 service | `src/services/newSessionPrefsService.ts`（dispatch cap.kv，导出 `readNewSessionPrefs` / `persistNewSessionPrefs`） |
| 组件改动 | `NewSessionButton.tsx`：加入 Profile+Model 选择器、恢复/写入记忆、透传 createSession；`CreateSessionModal.tsx` 同款 |
| createSession | 不改签名（`CreateSessionOptions` 已含 `modelProfileId/model/profileMode`） |
| 后端 | 零改动（复用 cap.kv） |
| 验收 | ① 新建面板可选供应商（官方/Profile）+ 模型；② 创建后会话发送按所选 Profile/模型生效；③ 切换引擎后记忆互相独立；④ 重启应用（刷新）后记忆仍在（落 kv.db） |
