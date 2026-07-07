# ADR 0003: Per-Engine Default Model Profile（按引擎设置默认供应商）

## Status

Proposed

## Date

2026-07-07

## Context

### 现状：引擎与供应商是两套正交概念

Polaris 支持四个 AI 引擎（`EngineId = 'claude-code' | 'codex' | 'simple-ai' | 'mimo'`，定义于 `src/types/config.ts:11`、后端 `src-tauri/src/ai/traits.rs` 并在 `src-tauri/src/models/config.rs:61` 重导出）。

「供应商」在代码中的载体是 **Model Profile**（`ModelProfile`，`src/types/modelProfile.ts:67` / `src-tauri/src/models/config.rs:183`），描述一个第三方端点（`baseUrl` + `apiKey` + `model` + `wireApi` 等）。二者的关联是**单向**的：

- Profile 身上有 `targetEngines?: EngineId[]`（`src/types/modelProfile.ts:92`），表达「该供应商**适用于**哪些引擎」，是一个过滤器 / 适用范围标签。
- 引擎侧**没有**任何「本引擎默认用哪个供应商」的反向记忆。

### 供应商如何在运行时生效

发送 / 续聊时由 `resolveEffectiveProfileId()`（`src/stores/conversationStore/conversationStoreUtils.ts:55-69`）三态解析，结果作为 `options.modelProfileId` 透传后端：

```
会话级覆盖(sessionMeta) > 状态栏镜像(sessionMirror) > 全局默认(getActiveModelProfile()?.id)
```

后端 `apply_model_profile_options()`（`src-tauri/src/commands/chat.rs:510-567`，调用点 `chat.rs:951-958` / `chat.rs:1110`）消费该 id，并做**硬校验**：若该 Profile 的 `targetEngines` 不含当前引擎，直接中断请求并返回 `errors:modelProfile.incompatibleRuntime`（`chat.rs:548-567`）。

### 根本问题

**全局激活状态是单一值**（`activeModelProfileId`，前端 `src/stores/modelProfileStore.ts:23`，后端 `Config.active_model_profile_id`，`models/config.rs:1109-1111`），且 `resolveEffectiveProfileId` 的兜底档 `getActiveModelProfile()?.id` **不接收引擎参数**。

由此产生用户痛点：当用户为 Claude 配了 Profile A、为 Codex 配了 Profile B，全局同一时刻只能激活一个。切到另一引擎后，兜底解析仍返回旧引擎的 Profile，后端校验发现不适用 → **直接报错 `incompatibleRuntime`**，用户被迫每次手动去设置页或状态栏重新激活。这不仅是「要手动切」，而是「不切就报错」。

### 已具备的一半能力

系统在展示层与校验层已引擎感知，仅缺「引擎 → 默认供应商」的持久化记忆与解析档：

- 状态栏切换器已按当前引擎过滤 Profile 列表（`compatibleProfiles`，`src/components/Chat/SessionConfigSelector.tsx:148-151`、`268-282`）。
- `isProfileForEngine()`（`modelProfile.ts:287`）/ 后端 `ModelProfile::is_for_engine()`（`models/config.rs:271`）兼容判断已就位。
- simple-ai 后端 `find_active_profile()`（`simple_ai/mod.rs:87-106`）**优先采用前端传入的 profile_id**（`__simple_ai_profile_id`，由 `apply_model_profile_options` 注入），`active_model_profile_id` 仅作兜底 —— 意味着只要前端解析层给对值，simple-ai 会自动跟随。

### 关键约束

1. **命名映射不一致**：引擎规范 id 是 `claude-code`，而 Profile 的适用引擎标识用 `claude`（其余三者同名）。前端映射见 `SessionConfigSelector.tsx:134-141`，后端见 `chat.rs:549-554`。
2. **状态栏镜像语义纠缠**：启动 hydrate 时会把全局 `activeModelProfileId` 灌入状态栏镜像 `sessionConfig.modelProfileId`（`src/stores/configStore.ts:98-106`）。若不调整，新增的「引擎默认」档会被这一步永久遮蔽。
3. **双 EngineId 同步**（见项目记忆 `dual-engineid-sync`）与 **web-only 门控**（`web-only-tauri-command-gate`）：后端改动需注意。
4. **Rust 本机测试限制**（`rust-lib-test-env-limit`）：只能 `cargo check --lib` 验证编译，不能 `cargo test --lib`。

## Decision

引入 **Per-Engine Default Model Profile**：一个 `引擎 → 默认 profileId` 的持久化映射，并将其接入运行时解析链，作为兜底档取代原「全局单一默认」的语义。

核心落在**前端解析层 + 一个持久化映射**，后端运行时校验逻辑（`apply_model_profile_options`）无需改动，仅透传新增配置字段。

### D1. 数据结构

新增映射字段（key 用引擎规范 id `EngineId`，value 为 profileId）：

- 前端 `src/types/config.ts` 的 `Config`：
  ```ts
  /** 各引擎的默认模型供应商（key = EngineId，value = profileId）。缺省时回退全局默认。 */
  engineDefaultProfiles?: Partial<Record<EngineId, string>>
  ```
- 后端 `src-tauri/src/models/config.rs` 的 `Config`（`#[serde(rename_all = "camelCase")]` → JSON `engineDefaultProfiles`）：
  ```rust
  /// 各引擎的默认模型 Profile（key = EngineId 规范 id，value = profileId）
  #[serde(default)]
  pub engine_default_profiles: std::collections::BTreeMap<String, String>,
  ```
  用 `BTreeMap` 与既有 `terminal_scripts` 保持序列化稳定风格；`#[serde(default)]` 保证旧配置零迁移。同步更新 `Config::default()`（`models/config.rs:1123`）。

保留 `activeModelProfileId` 作为「未指定引擎默认时的全局兜底」，不删除，保证向后兼容。

### D2. 解析层：新增「引擎默认」档

将 `resolveEffectiveProfileId`（`conversationStoreUtils.ts:55`）改造为接收引擎默认值，优先级：

```
会话级覆盖 > 状态栏镜像 > 引擎默认 > 全局默认
```

```ts
export function resolveEffectiveProfileId(
  sessionMetaProfileId: string | undefined,
  sessionConfigProfileId: string | undefined,
  engineDefaultProfileId: string | undefined,   // 新增
  globalActiveProfileId: string | undefined,
): string | undefined {
  if (sessionMetaProfileId !== undefined) {
    return sessionMetaProfileId === OFFICIAL_API_PROFILE || sessionMetaProfileId === ''
      ? undefined
      : sessionMetaProfileId
  }
  const fallback = sessionConfigProfileId || engineDefaultProfileId || globalActiveProfileId
  return fallback && fallback !== OFFICIAL_API_PROFILE ? fallback : undefined
}
```

两个调用点（`createConversationStore.ts:1123`、`:1259`）已持有 `engine` / `currentEngine`，新增一次查表 `engineDefaultProfiles[engine]` 传入即可。

### D3. 状态栏镜像 hydrate 调整（消除遮蔽）

修改 `configStore.ts:96-106` 的 P0 初始化：状态栏镜像不再无条件灌全局 `activeModelProfileId`，而是按**当前默认引擎**优先取引擎默认：

```
sessionMirror ← engineDefaultProfiles[defaultEngine] ?? activeModelProfileId
```

保证「用户从未手动碰状态栏」时，引擎默认档真正生效。

### D4. 切换联动（真正实现「换引擎即换供应商」）

新建会话时（`CreateSessionModal.tsx` / `NewSessionButton.tsx`，已持有所选 `engineId`）按引擎默认预置该会话的初始供应商，避免继承上一引擎的镜像值导致 `incompatibleRuntime`。与 D2 兜底档形成双保险。

### D5. UI 入口

- **主入口 —— `AIEngineTab`（引擎视角，贴合用户心智）**：在引擎详情区（`AIEngineTab.tsx:299-313` 附近）新增「默认供应商」下拉，选项来自 `getProfilesByEngine(engine)`（`modelProfileStore.ts:145`）过滤后的兼容 Profile，含「跟随全局默认 / 官方 API」空选项。写入 `engineDefaultProfiles[engine]`。
- **辅助入口 —— `ModelProviderTab` 卡片**：Profile 卡片增加「设为某引擎默认」动作（一个 Profile 可适用多引擎，故用小菜单）。
- **删除清理**：扩展 `ModelProviderTab.handleDelete`（`ModelProviderTab.tsx:929-947`），删除 Profile 时一并清除 `engineDefaultProfiles` 中指向它的悬空引用（与既有 session metadata 清理对称）。

### D6. Store 支撑

`modelProfileStore`（`src/stores/modelProfileStore.ts`）新增 `engineDefaultProfiles` 只读镜像 + `setEngineDefaultProfile(engine, profileId | null)`，并在 `configStore` hydrate（`configStore.ts:84-94`）灌入；写操作经 `onConfigChange` → `update_config` 持久化（沿用 `ModelProviderTab.syncToConfig` 模式，`ModelProviderTab.tsx:815-824`）。

## Considered Alternatives

### Alt 1：在每个 Profile 上加 `defaultForEngines: EngineId[]`（反向存储）

- 缺点：一个引擎可能被多个 Profile 同时标记为默认，需额外「唯一化」逻辑与冲突处理；查询「某引擎默认」需遍历全部 Profile。映射语义天然是 `引擎 → 单个 Profile`，独立映射更直接。**否决**。

### Alt 2：纯后端方案（`apply_model_profile_options` 在 profile_id 为空时按引擎兜底）

- 优点：可覆盖 bot / web / scheduler 等后端直发入口。
- 缺点：前端状态栏仍会解析并发送旧引擎的镜像值 → 后端仍先撞 `incompatibleRuntime`；用户在 UI 上看不到「当前会用哪个供应商」，与所见不一致。单独使用无法解决主痛点。**作为可选增强保留（见 Future Work），不作为主方案**。

### Alt 3：废弃全局 `activeModelProfileId`，改为完全 per-engine

- 缺点：破坏性大，删除既有字段涉及全链路迁移与已落盘配置兼容风险。**否决**（本方案以「新增兜底档、保留旧字段」实现平滑演进）。

## Consequences

### 正向

- 消除「换引擎必手动切供应商 / 不切即报错」的核心痛点。
- 向后兼容：新增字段可选、`#[serde(default)]`，旧配置与旧行为（全局默认）在未设置引擎默认时保持不变。
- 后端运行时校验、simple-ai 兜底路径均无需改动，风险收敛在前端解析层。
- 与既有「会话级覆盖」「状态栏镜像」三态解析自然叠加，不引入新的全局可变状态复杂度。

### 负向 / 成本

- `resolveEffectiveProfileId` 签名变更，需同步两处调用点与单测。
- 引入 `claude-code`↔`claude` 映射的又一处使用点，需复用既有映射工具避免分叉。
- 后端直发入口（QQ/飞书 bot、Web API、scheduler）在本方案下仍走全局默认，未纳入引擎默认（列为已知限制）。

## Risks & Mitigations

| 风险 | 说明 | 缓解 |
|------|------|------|
| 状态栏镜像遮蔽引擎默认 | hydrate 把全局默认灌进 `sessionMirror`，引擎默认档轮空 | D3 调整 hydrate 优先取引擎默认 |
| `claude-code` vs `claude` 映射错配 | 写入用 `EngineId`，兼容判断用 `claude` 标识 | 抽取单一映射工具（复用 `SessionConfigSelector.tsx:134-141` 逻辑），前后端各一处 |
| 悬空引用 | 删除 Profile 后 `engineDefaultProfiles` 仍指向它 | D5 删除清理；`Config::validate()` 可补充清理无效映射 |
| 双 EngineId 同步陷阱 | 后端 config 改动 | 本次仅加映射字段、非新增引擎，风险低；仍需 `cargo check --lib` 验证 |
| web-only 门控 | 新增 tauri command 需 `#[cfg(feature="tauri-app")]` | 本方案复用 `update_config`，**不新增 command** |

## Implementation Plan

分阶段落地，每阶段可独立编译验证。

- **Phase 1 — 数据结构**
  - 前端 `config.ts` 加 `engineDefaultProfiles`；后端 `models/config.rs` 加 `engine_default_profiles` + `Config::default()`。
  - 验证：`cargo check --lib`、`tsc`。
- **Phase 2 — 解析层与 Store**
  - 改 `resolveEffectiveProfileId`（+ 单测 `conversationStoreUtils.test.ts`）。
  - 更新调用点 `createConversationStore.ts:1123`、`:1259`。
  - `modelProfileStore` 加 `engineDefaultProfiles` + setter；`configStore` hydrate（含 D3 镜像调整）。
- **Phase 3 — UI**
  - `AIEngineTab` 引擎默认供应商下拉（主入口）。
  - `ModelProviderTab` 卡片「设为引擎默认」动作 + 删除清理（D5）。
  - 抽取 `EngineId ↔ ProfileTargetEngine` 映射工具。
- **Phase 4 — 切换联动**
  - 新建会话按 `engineId` 预置初始供应商（`CreateSessionModal` / `NewSessionButton`）。
- **Phase 5（可选）— 后端兜底（Alt 2）**
  - `apply_model_profile_options` 在 `profile_id=None` 时按 `engine` 查 `engine_default_profiles` 兜底，覆盖 bot/web/scheduler。

### 涉及文件清单

前端：
- `src/types/config.ts`（+字段）
- `src/stores/conversationStore/conversationStoreUtils.ts`（解析签名）
- `src/stores/conversationStore/conversationStoreUtils.test.ts`（单测）
- `src/stores/conversationStore/createConversationStore.ts`（两处调用点）
- `src/stores/modelProfileStore.ts`（state + setter）
- `src/stores/configStore.ts`（hydrate + 镜像调整）
- `src/components/Settings/tabs/AIEngineTab.tsx`（主入口 UI）
- `src/components/Settings/tabs/ModelProviderTab.tsx`（辅助入口 + 删除清理）
- `src/components/Session/CreateSessionModal.tsx` / `src/components/Chat/NewSessionButton.tsx`（切换联动）
- 新增：`EngineId ↔ 'claude'|...` 映射工具（建议置于 `src/utils/engineDisplay.ts`）

后端：
- `src-tauri/src/models/config.rs`（+字段 + default）
- （Phase 5 可选）`src-tauri/src/commands/chat.rs`（`apply_model_profile_options` 兜底）

## Testing / Validation

- **单测**：扩展 `conversationStoreUtils.test.ts`，覆盖新档优先级（引擎默认命中 / 被会话覆盖与状态栏镜像压制 / 无引擎默认回退全局 / 官方哨兵归一化）。
- **编译**：`cargo check --lib`（不可 `cargo test --lib`，见 `rust-lib-test-env-limit`）；前端 `tsc` 零错误。
- **手动验收**：
  1. 配置 Profile A（targetEngines=claude）、B（targetEngines=codex）。
  2. `AIEngineTab` 中把 A 设为 claude-code 默认、B 设为 codex 默认。
  3. 分别新建 claude-code / codex 会话直接发送，均不出现 `incompatibleRuntime`，且状态栏显示对应供应商。
  4. 切换全局默认引擎后新建会话，供应商随引擎自动切换。
  5. 删除 A 后，claude-code 引擎默认回退为「全局默认 / 官方」，无悬空报错。

## Rollout / Migration

- 无数据迁移：新字段可选、`#[serde(default)]`，缺省行为等价现状。
- 灰度顺序：Phase 1→4 交付即可解决主痛点；Phase 5 视 bot/web 需求单独评估。

## Future Work

- Alt 2 后端兜底：让 QQ/飞书 bot、Web API、scheduler 等后端直发入口也遵循引擎默认。
- `cascade_active_model_profile`（`lib.rs:199-225`）目前仅按单一激活 Profile 级联写 Claude settings.json；后续可扩展为按 claude-code 的引擎默认 Profile 级联。
