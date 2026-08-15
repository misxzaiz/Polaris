# 供应商分组路由 · 状态栏选择器 PRD

> 版本：v1.1（2026-08-16）
> 状态：**已实施**（M1-M4 全绿）+ 攻坚复审修订
> 类型：功能增强（Frontend + Backend 契约扩展）
> 关联：`docs/provider-group-failover-plan.md`（P1 已实施）、`src/components/Settings/tabs/ModelProviderTab.tsx`

---

## 0. TL;DR

状态栏「模型供应商」选择器目前只有 **官方 API / 具体 Profile 二选一**，分组路由**无入口、且被官方 API 语义劫持**。本 PRD 新增第三态「分组路由」，并引入 `profileMode` 契约字段，使**官方 / 分组 / 单 Profile** 三态在会话级显式可选。

---

## 1. 背景与问题

### 1.1 现状（已代码核验）

| # | 事实 | 证据 |
|---|------|------|
| F1 | 状态栏 Profile 选择器只列出「官方 API + 各 Profile」 | `SessionConfigSelector.tsx:309-334` |
| F2 | 「官方 API」以 `value: ''` 表示 | 同上，``` value: '' `` |
| F3 | 前端模型 = 会话级覆盖 > 状态栏镜像 > 全局默认，空串归一为 `undefined` | `conversationStoreUtils.ts:78-92` `resolveEffectiveProfileId` |
| F4 | 后端判定「分组/官方」只看 `model_profile_id` 是否为 `Some` | `chat.rs:1137-1149` |
| F5 | 分组激活后，`model_profile_id = None` 时**必然走分组** | 同上 |
| F6 | 后端已有 `active_provider_group_id` 驱动分组、`provider_router` 全程记录日志 | `chat.rs:1121-1165` |

### 1.2 用户痛点

1. **无入口**：想用分组路由，状态栏没有「分组」选项，只能「选官方 API」这个假动作。
2. **语义反转**：选了「官方」实际走组内供应商；状态栏显示与真实线路不一致。
3. **无法禁用**：只要全局配了 `active_provider_group_id`，会话级无法明确「强制官方」。
4. **会话级优先级不明**：状态栏引导用户选 Profile 或官方，但不知道会覆盖分组。

### 1.3 目标

- 三态供应商选择在状态栏**显式可见、可切换**：**官方 API / 分组路由 / 指定 Profile**。
- 会话级选择与全局分组配置**解耦**，互不劫持。
- 分组路由的选择结果**在状态栏可见**（显示「分组 · <组名> · <策略>」）。

### 1.4 非目标

- 不做分组内成员 Profile 的会话级精确选择（优先级/权重由后端决策）。
- 不改后端 failover 引擎逻辑，仅新增入口与契约字段。
- RoundRobin / Weighted 的会话亲和展示不在本 PRD（后继可在路由日志完成）。

---

## 2. 核心模型：ProfileMode 三态

### 2.1 概念

把「供应商选择」从**一个 id 字段**升级为**两条信息**：

```
供应商 = Mode(官方 | 分组 | 指定 Profile) + 实体 id(仅第三种有)
```

### 2.2 后端新增枚举与字段（Rust / `models/config.rs`）

```rust
/// 会话级供应商模式
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileMode {
    /// 强制官方端点，不走分组，不用 Profile
    Official,
    /// 走供应商分组路由（需结合 active_provider_group_id / 传入 group_id）
    Group,
    /// 使用指定 Profile（语义与 model_profile_id 一致）
    Profile,
}
```

`ChatRequestOptions` 新增字段（`chat.rs:54-103`）：

```rust
/// 供应商选择模式（None = 未显式指定，走旧逻辑：
/// 有 model_profile_id → 该 Profile；否则如果激活了分组 → 分组；否则官方）
#[serde(default)]
pub profile_mode: Option<ProfileMode>,
```

### 2.3 契约字段关系矩阵

| 前端传入 | 后端行为（优先级从上到下） |
|---------|--------------------------|
| `profileMode = 'official'` | 强制官方：跳过分组、不使用 Profile |
| `profileMode = 'profile'` + `modelProfileId = 'A'` | 使用 Profile A（与现状一致，且**显式屏蔽分组**） |
| `profileMode = 'group'` | 走分组路由（`resolve_active_provider_group`） |
| `profileMode` 缺失 + `modelProfileId = 'A'` | 向前兼容：使用 Profile A |
| `profileMode` 缺失 + 无 Profile + 激活分组 | 向前兼容：走分组 |
| `profileMode` 缺失 + 无 Profile + 无分组 | 向前兼容：官方 |

> `profileMode = 'group'` 但未配置任何 active 分组 → 视为走官方（并记录一条 `AllUnavailable` 日志提示）。

### 2.4 前端类型（`types/sessionConfig.ts`）

```ts
/** 供应商选择模式 */
export type ProfileMode = 'official' | 'group' | 'profile'

interface SessionRuntimeConfig {
  // ...现有字段
  /** 供应商选择模式（新增） */
  profileMode?: ProfileMode
}
```

---

## 3. 交互设计（原型）

### 3.1 状态栏 Profile 选择器新增第三个区块

当前 `items` 顺序：`官方 API` → 各 Profile。改为三区块：

```
┌─────────────────────────────────────┐
│ 模型供应商                            │
├─────────────────────────────────────┤
│ ● 官方 API                           │  ← 官方（新增描述「使用官方端点」）
│   使用 Anthropic 官方端点             │
│                                       │
│ ○ 分组路由                            │  ← 新增（组激活时可用）
│   <组名> · Failover · 2 成员          │
│   ▸ 路由详情                          │  ← 展开显示组内成员 priority
│                                       │
│ ── 指定 Profile ──────────────────  │
│ (□) A 供应商                          │
│ (□) B 供应商                          │
└─────────────────────────────────────┘
```

**交互规则**：
- 选择「官方」/「分组路由」/ 任一 Profile → 立即设置 `profileMode` 并清空同态冲突字段。
- 选择「官方」→ `profileMode = 'official'`，`modelProfileId = ''`，模型重置。
- 选择「分组路由」→ `profileMode = 'group'`，`modelProfileId = ''`，模型重置。
- 选择某 Profile → `profileMode = 'profile'`，`modelProfileId = <id>`，模型重置。
- 分组未激活（`activeProviderGroupId` 为空）时，「分组路由」项**置灰**，title 提示「先在设置中激活分组」。

### 3.2 状态栏显示

- 当前模式为「官方」→ 显示 **官方**。
- 当前模式为「分组」→ 显示 **分组 · <组名>**（hover tooltip 显示策略与成员）。
- 当前模式为「Profile」→ 显示 Profile 名（现状不变）。

### 3.3 分组路由详情内联展开

点击「分组路由」行右侧展开箭头（或悬停 tooltip）：
- 列出组内成员 `priority` 排序
- 标识当前 Failover 首选项（priority 最小的健康成员）
- 提供「路由日志」快捷入口（跳转 `RouteLogTab` 或打开侧栏）

### 3.4 设置页协同

`ModelProviderTab` 分组卡片新增一行提示：*「会话状态栏选择『分组路由』即可启用；未显式选择时默认跟随全局激活分组。」*

---

## 4. 行为细化

| 场景 | 期望行为 |
|------|---------|
| 全局激活分组 G，状态栏未设置（默认） | 走 G（现状不变，向后兼容） |
| 状态栏选「官方」 | 强制官方，G 不生效 |
| 状态栏选「分组路由」 | 走 G；若 G 未激活 → 记日志 + 回退官方 |
| 状态栏选 Profile A | 用 A，G 不生效 |
| 会话中切到分组 G，然后切回「官方」 | profileMode 切换为 official，模型重置，重新发送生效 |
| 会话级优先级 | `sessionMeta.profileMode` > `sessionConfig.profileMode` > 全局 |

**会话级覆盖落点**：`createConversationStore` 两处 `resolveEffectiveProfileId` 调用间透传 `profileMode`（`createConversationStore.ts:1502、1661` 附近），并写入 `sessionMetadata`（三态哨兵同 `OFFICIAL_API_PROFILE` 模式，`OFFICIAL_PROFILE_MODE = '__official__'`）。

---

## 5. 后端改动清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `models/config.rs` | 新增 `ProfileMode` 枚举 | 序列化 `camelCase` |
| `commands/chat.rs` | `ChatRequestOptions` 加 `profile_mode` | 默认 `None`（兼容） |
| `commands/chat.rs` | `start_chat_inner` 判定逻辑 | `chat.rs:1137-1149` 前插 `profile_mode` 分支 |
| `commands/chat.rs` | 缺省分组回退时记录日志 | `AllUnavailable` 或新增 `OfficialFallback` kind |
| `services/provider_router.rs` | （可选）`RouteLogKind` 增 `OfficialFallback` | 日志可观测 |

**判定逻辑伪码**：

```rust
let chosen = match options.profile_mode {
    Some(ProfileMode::Official) => None,                    // 强制官方
    Some(ProfileMode::Profile) => options.model_profile_id.clone(), // 指定 Profile 先于分组
    Some(ProfileMode::Group) | None => {
        // None 兼容旧逻辑：有显式 model_profile_id 用 Profile，否则走分组
        if options.model_profile_id.is_some() {
            options.model_profile_id.clone()
        } else {
            resolve_active_provider_group(state).await.map(|(g, _)| select_initial_or_next())
        }
    }
};
```

---

## 6. 前端改动清单

| 文件 | 改动 |
|------|------|
| `types/sessionConfig.ts` | 新增 `ProfileMode` 类型 + `SessionRuntimeConfig.profileMode` |
| `types/modelProfile.ts` | 新增 `OFFICIAL_PROFILE_MODE` 哨兵 |
| `stores/sessionConfigStore.ts` | 新增 `setProfileMode` / `reset` 联动 |
| `stores/conversationStore/types.ts` | `SessionMetadata` 加 `profileMode` |
| `stores/conversationStore/createConversationStore.ts` | 透传 `profileMode` → invoke 参数 |
| `stores/conversationStore/conversationStoreUtils.ts` | `resolveEffectiveProfileId` 扩展、新增 `resolveEffectiveProfileMode` |
| `components/Chat/SessionConfigSelector.tsx` | Profile 区块重构：加「分组路由」项 + 详情展开 + 置灰逻辑 |
| `components/Settings/tabs/ModelProviderTab.tsx` | 分组卡片加「会话状态栏启用」提示 |

---

## 7. 测试用例

### 7.1 单元测试（前端）

| 编号 | 用例 | 期望 |
|------|------|------|
| U1 | `resolveEffectiveProfileMode` 三态 | 官方/分组/Profile 正确解析 |
| U2 | 哨兵归一化 | `OFFICIAL_PROFILE_MODE` 不向后端透传真实 id |
| U3 | 选择分组后 `modelProfileId` 清空 | 状态无残留 |
| U4 | 分组未激活时项置灰 | `disabled` 不可点击 |

### 7.2 后端单元测试

| 编号 | 用例 | 期望 |
|------|------|------|
| B1 | `profile_mode=Official` + 激活分组 | 走官方，跳过分组 |
| B2 | `profile_mode=Group` + 无激活分组 | 记日志 + 回退官方（不报错） |
| B3 | `profile_mode` 缺失 + `model_profile_id=A` + 激活分组 | 向前兼容：用 A |
| B4 | `profile_mode` 缺失 + 无 Profile + 激活分组 | 向前兼容：走分组 |
| B5 | `profile_mode=Profile` + `model_profile_id=A` | 用 A |

### 7.3 E2E（Mock）

| 编号 | 用例 | 期望 |
|------|------|------|
| E1 | 激活分组 G + 状态栏选「官方」 | CLI 用官方 env，无 overlay |
| E2 | 激活分组 G + 状态栏选「分组路由」 | CLI 用 G 首成员 overlay/env |
| E3 | 激活分组 G + 状态栏选 Profile A | CLI 用 A overlay/env |
| E4 | 无激活分组 + 「分组路由」项置灰 | 无法选择 |
| E5 | 路由日志出现 `OfficialFallback`（B2 场景） | 日志面板可见 |

---

## 8. 兼容与回滚

- 后端新增字段默认 `None`，**完全向后兼容**（旧前端不发 `profileMode`）。
- 旧前端仍会「选官方 = 走分组」（现状行为），升级前端后即正确。**无迁移数据**。
- 回滚：仅需前端回退 `SessionConfigSelector` + 后端移除 `profile_mode` 判定（默认走旧逻辑）。

---

## 9. 风险

| 风险 | 缓解 |
|------|------|
| `ProfileMode::Group` 与 `resolve_active_provider_group` 无参耦合 | 后续可扩展为 `options.provider_group_id` 直接指定组；本期沿用全局激活组 |
| 会话级 `profileMode` 与 `modelProfileId` 双字段一致性 | 前端统一 `handleSelect` 处原子写入；后端以 `ProfileMode` 为判定主源 |
| 分组激活但成员模型不一致 | 沿用规划文档风险表第 3 条：文档建议同组同模型（本 PRD 不引入新模型源） |

---

## 10. 验收标准

1. 状态栏出现「官方 API / 分组路由 / 指定 Profile」三区块，分组项在激活后可用。
2. 选择「官方」后，激活分组仍走官方端点（CLI env 无 overlay）。
3. 选择「分组路由」后，生效配置来自组内首成员（无 validering 报错）。
4. 旧链路（不发 `profileMode`）行为与 v1 完全一致。
5. 路由日志正确记录 `OfficialFallback`（若实施）。

---

## 11. 里程碑（建议）

| 阶段 | 内容 | 依赖 |
|------|------|------|
| M1 | 后端 `ProfileMode` + 判定重构 + B1-B5 单测 | 无 |
| M2 | 前端类型 + store + 三态解析 + U1-U4 | M1 |
| M3 | `SessionConfigSelector` 三区块 UI + 详情展开 | M2 |
| M4 | 设置页提示 + 路由日志 `OfficialFallback` | M1 |