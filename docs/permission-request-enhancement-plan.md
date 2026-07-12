# 权限请求卡片增强 — 处理方案（待确认）

> **状态**：已实施（P1 + P2 + P3 完成，2026-06-09）
> **日期**：2026-06-09
> **范围**：让权限请求卡片在「非 bypassPermissions 权限模式」下真正可用
> **关联提交**：`443e1d83 feat(permission): 权限请求卡片支持逐项决策、授权范围与全局规则落盘`
> **关联文件**：`PermissionRequestRenderer.tsx` / `createConversationStore.ts` / `conversationStore/types.ts` / `event_parser.rs` / `claude_settings.rs`

---

## 1. 背景

提交 `443e1d83` 为工具权限确认引入了一套增强卡片：逐项批准/拒绝、授权范围（once/session/global）、`expired` 失效态、global 规则落盘到 `~/.claude/settings.json`。

本方案在该提交基础上，针对「实际切换到会触发权限的模式（`default` / `plan` / `acceptEdits`）时，功能能否真正闭环」做重新评估，并给出处理方案。**当前默认 `bypassPermissions` 为用户个人测试配置，不在本方案改动范围内。**

---

## 2. 现状评估（基于实证）

### 2.1 已验证（静态铁证）

| 项 | 结论 | 证据 |
|---|---|---|
| 进程模型 | `continueChat` 每次**新起进程 + `--resume <sid>` + `--allowedTools`** | `claude.rs:976-1056`（continue_session）、`claude.rs:397/507`（`--allowedTools`） |
| store 模型 | **每会话一个 store 实例**，LRU 管理，会话级状态天然隔离 | `sessionStoreManager`（MAX_IDLE_STORES=5） |
| 后端解析 | `parse_result` 提取 `tool_name`/`reason`，其余字段（含 `tool_input`/`tool_use_id`）→ `extra` → `#[serde(flatten)]` → JSON 顶层 | `event_parser.rs:694-721`、`models/ai_event.rs:804-812`（`#[serde(flatten)]`） |
| 前端归一化 | 从顶层 `raw.tool_input` / `raw.tool_use_id` 接住 | `createConversationStore.ts:appendPermissionRequestBlock` |
| 回传链路 | `handleSubmit → continueChat(prompt, allowedTools) → invoke('continue_chat') → --allowedTools` | `PermissionRequestRenderer.tsx:262-303`、`createConversationStore.ts:1238` |

**结论**：触发 → 解析 → 展示 → 回传重试，链路静态自洽。

### 2.2 重大发现：默认配置会架空功能（仅说明，**本方案不处理**）

- `DEFAULT_SESSION_CONFIG.permissionMode = 'bypassPermissions'`（`sessionConfig.ts:96`，提交 `0d0f451d` 改入）。
- 连锁后果：
  1. `normalizeSessionConfig` 的剔除逻辑「命中 bypass → 回退到 `DEFAULT.permissionMode`」，因默认值本身即 bypass，**剔除失效** → 单元测试 `剔除高风险的 permissionMode=bypassPermissions` 持续 red。
  2. bypass 模式下 CLI 不产生 `permission_denials`，**权限卡片默认永不触发**（也解释了全仓无任何真实样本）。
- **处理立场**：默认配置是用户测试用途，剔除逻辑与该 red test 属旧契约遗留，**全部不动**。仅提示：该 test 会使 `pnpm test:run` / CI 维持 1 failed，处置方式由用户决定。

### 2.3 真问题清单（与权限模式解耦）

| 编号 | 问题 | 性质 | 证据 |
|---|---|---|---|
| **P1** | `session` 范围等同 `once`（选「本会话」仍每轮弹卡） | 确凿功能 bug | `handleSubmit` 仅 `global` 分叉；`scope` 落库后无消费方 |
| **P2** | 权限路径零测试覆盖 | 质量缺口 | 全仓无 permission 测试/fixture |
| **P3** | `toolInput` 真实字段未实测 | 验证缺口 | 解析逻辑自洽，但本机 `claude` 为残留 shim + 默认 bypass，从未实跑 |

---

## 3. 范围边界

### 3.1 不碰（硬约束）
- `src/types/sessionConfig.ts` — `DEFAULT_SESSION_CONFIG`（含 `permissionMode`）。
- `src/stores/sessionConfigStore.ts` — `normalizeSessionConfig` 剔除逻辑。
- `src/stores/sessionConfigStore.test.ts` — 对应 red test（除非用户另行授权加 skip）。

### 3.2 要改（本方案目标）
- P1：`session` 范围真正落地（核心）。
- P2：权限路径补测试 + 健壮性复查。
- P3：提供 default 模式实跑验证脚本。

---

## 4. 详细设计

> 以下代码片段为**方案示意（proposed）**，非已落盘改动。

### P1 — `session` 范围落地

#### 4.1 设计依据
- 进程每次 `--resume` 重起 → 只需前端维护**会话级 allow 集合**，每次 `continueChat` 并入 `allowedTools`，新进程即放行。
- store 实例 = 会话生命周期 → 集合天然 per-session，无需跨会话清理；`clearMessages`（清消息保留会话）**不清**该集合。

#### 4.2 改动点 1：`src/stores/conversationStore/types.ts`

`ConversationState` 新增字段（约 116 行 `activePermissionRequestId` 附近）：
```ts
/** 会话级工具放行集合（scope=session/global 时累积；--resume 续聊自动带上）。绑定会话生命周期，不持久化。 */
sessionAllowedTools: string[]
```

`ConversationActions` 新增（权限区 `expireStalePermissionRequests` 之后）：
```ts
/** 追加会话级放行工具（去重）。scope=session/global 的批准项调用，使本会话续聊不再询问。 */
addSessionAllowedTools: (tools: string[]) => void
```

#### 4.3 改动点 2：`src/stores/conversationStore/createConversationStore.ts`

初始 state（约 59 行）：
```ts
sessionAllowedTools: [],
```
> 注：`clearMessages`（约 165 行）**不**重置此字段——授权绑定会话而非消息。

新增 action 实现（权限区）：
```ts
addSessionAllowedTools: (tools) => {
  if (!tools || tools.length === 0) return
  const cur = get().sessionAllowedTools
  const merged = [...new Set([...cur, ...tools])]
  if (merged.length !== cur.length) set({ sessionAllowedTools: merged })
},
```

`continueChat` 并入（约 1238 行 `allowedTools` 处）：
```ts
// 改动前
allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,

// 改动后
allowedTools: (() => {
  const merged = [...new Set([...(allowedTools ?? []), ...get().sessionAllowedTools])]
  return merged.length > 0 ? merged : undefined
})(),
```

#### 4.4 改动点 3：`src/components/Chat/PermissionRequestRenderer.tsx`

`handleSubmit`（约 277 行 `resolvePermissionRequest` 之后、`continueChat` 之前）：
```ts
// scope=session/global：批准项写入会话集合，使本会话续聊不再询问
if ((scope === 'session' || scope === 'global') && approvedTools.length > 0) {
  store.addSessionAllowedTools(approvedTools)
}
```
> `once` 维持现状（仅本次 `continueChat` 携带，不进集合）。

#### 4.5 行为矩阵

| scope | 写 settings.json | 进会话集合 | 效果 |
|---|---|---|---|
| once | ✗ | ✗ | 仅本轮放行（现状不变） |
| session | ✗ | ✓ | 本会话存活期内不再询问 |
| global | ✓（收敛规则） | ✓ | 永久 + 本会话立即生效（不必等 CLI 重启读 settings.json） |

#### 4.6 风险与取舍
- **放行粒度**（**决策点 ②**）：会话集合存**工具名**（如 `Bash`）→ 放行该工具在本会话所有调用，简单但偏宽；若要精确，可改存收敛规则（`Bash(npm:*)`，Claude Code `--allowedTools` 支持该语法），但需复用 `buildGlobalRule` 并处理多规则合并。
- 会话集合不持久化：刷新页面 / 重载会话后清空（符合「会话存活期」语义；如需跨重载保留需额外持久化，**不建议**）。
- 与现有逐项 `once` 逻辑无冲突（Set 去重）。

### P2 — 测试 + 健壮性

- **后端** `event_parser.rs::parse_result`：新增单测，输入含 `permission_denials` 的 result JSON，断言 `tool_name`/`reason` 提取正确、`tool_input`/`tool_use_id` 进入 `extra` 并能 flatten。
  - ⚠️ **诚实声明**：测试样本若由开发侧构造，仅能验证「解析逻辑对该格式正确」，**不能**证明「CLI 真实输出该格式」。真实性依赖 P3，不以自编 fixture 冒充真实验证。
- **前端**：补 `resolvePermissionRequest`（逐项落库 + 整卡状态推导）、`expireStalePermissionRequests`（仅失效非空 denials 块、跳过 plan 空块）、`addSessionAllowedTools`（去重）用例。
- **健壮性复查**：`buildGlobalRule` 的 `Bash(head:*)` 取首 token 可能偏宽（如 `npm run build` → `Bash(npm:*)` 放行所有 npm）；文件类 `dir/**` 目录推导边界。仅复查，是否收紧待定。

### P3 — 实跑验证脚本

目的：在 `--permission-mode default` 下触发一次拒绝，dump `permission_denials` 真实字段，确认 `toolInput` 存在及其键名（`tool_input` vs 其他）。

前置：定位本机可用 `claude`（当前 PATH 内 `/c/Program Files/nodejs/claude` 为残留 shim；真实安装疑在 pnpm global `C:\Users\28409\AppData\Local\pnpm\global\5\node_modules` 或 `AppData/Local/claude-code`）。

脚本骨架（示意，需先解决 `claude` 可执行）：
```bash
cd "$(mktemp -d)"
printf '使用 Write 工具创建 a.txt，内容为 hello' \
  | claude --print --output-format stream-json --verbose \
           --permission-mode default 2>&1 \
  | grep -o '"permission_denials":\[[^]]*\]' | head
```
判定：若输出含 `tool_input`/`tool_use_id` 字段 → 链路打通确证；若仅 `tool_name` → UI 详情区将 fallback 到 reason，需调整展示预期。

#### 4.7 P3 实跑结果（2026-06-09，已执行）

本机 `claude` 实为 `2.1.167`（**非** shim，位于 `~/AppData/Roaming/npm/claude`）。在 `--print --output-format stream-json --verbose --permission-mode default` 下触发一次 Write 拒绝，`result` 事件实测 `permission_denials`：

```json
"permission_denials":[{
  "tool_name":"Write",
  "tool_use_id":"toolu_01GUeEiBbTLLCkiapsm39zPt",
  "tool_input":{"file_path":"...\\a.txt","content":"hello"}
}]
```

结论：
1. ✅ **`tool_input` 真实存在**，键名即 `tool_input`（snake_case）——`event_parser.rs` 的解析假设成立，flatten → 前端 `raw.tool_input` 接住，端到端链路用真实数据验证打通。
2. ✅ **`tool_use_id` 真实存在**，键名 `tool_use_id`。
3. ⚠️ **`reason` 字段不存在**：真实 denial 仅含 `tool_name`/`tool_use_id`/`tool_input` 三字段。`event_parser.rs:705-708` 对缺失 `reason` 有兜底（`.unwrap_or("权限被拒绝")`），故不破坏链路——UI 摘要从 `tool_input` 提取文件路径/命令（有意义），展开详情的 reason 显示兜底文案。原方案 2.1「提取 tool_name/reason」表述需修正为「reason 实际恒为兜底值」，非 bug。

---

## 5. 待确认决策点

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| ① | 改造范围 | P1 / P2 / P3 各做不做 | 至少 P1（功能可用前提） |
| ② | `session` 放行粒度 | 工具名（宽/简单） vs 收敛规则（窄/复杂） | 工具名（符合「本会话不再问该工具」直觉） |
| ③ | global 是否本会话立即生效 | 是（写文件 + 进集合） / 否（仅写文件） | 是 |
| ④ | red test 处置 | 维持不动（用户自理） / 授权我加 skip 注明 | 维持不动 |

---

## 6. 实施顺序 / 验证 / 回滚

1. **顺序**：P1 改动点 1→2→3 → `tsc`（`pnpm run build` 前半）类型校验 → P2 补测试 → `pnpm test:run`（预期仍仅 2.2 那 1 个既存 red，其余全绿）→ P3 脚本验证。
2. **验证**：
   - 类型：`pnpm run build`（tsc + vite）零错误。
   - 单测：新增用例全绿；既存 red test 数量不增加（维持 1）。
   - 行为：default 模式下手动验证 session 选项一轮授权后，同会话后续同类工具不再弹卡。
3. **回滚**：P1/P2 改动集中在 3 个前端文件 + 测试文件，未触碰后端与配置；`git revert` 单提交即可，无数据迁移、无 settings.json 结构变更。

---

## 7. 已知限制（本次不改，仅备案）

- **软重试**：授权回传靠「发送 `[已授权] X` 文案 + `--allowedTools` 白名单」驱动模型在 `--resume` 新进程中重新执行被拒操作，非协议级同步授权（CLI `--print` 无 `can_use_tool` 实时回调）。模型理论上可能改变策略而不复现原操作；实践中多数可复现。属现有架构，超出本方案范围。
- **多工具依赖链**：一轮内多个需授权工具若存在前后依赖，第一轮可能整体被拒，授权后重跑由模型重新规划，存在多轮往返。为 CLI 非交互授权固有限制。
- **global 即时性**：`~/.claude/settings.json` 由 CLI 启动时读取；P1 通过「同时进会话集合」弥补当前会话即时性，跨进程持久化仍以文件为准。

---

## 8. 实施记录（2026-06-09 已完成）

### 8.1 决策点最终取值
| # | 决策 | 取值 |
|---|---|---|
| ① | 改造范围 | P1 + P2 + P3 全做 |
| ② | `session` 放行粒度 | 工具名（宽/简单） |
| ③ | global 本会话立即生效 | 是（写文件 + 进集合） |
| ④ | red test 处置 | 维持不动 |

### 8.2 实际改动
- `conversationStore/types.ts`：`ConversationState` 新增 `sessionAllowedTools: string[]`；`ConversationActions` 新增 `addSessionAllowedTools`。
- `conversationStore/createConversationStore.ts`：初始 state `sessionAllowedTools: []`；新增 `addSessionAllowedTools`（去重 + 无新增不 set）；`continueChat` 的 `allowedTools` 改为并入会话集合的 IIFE。`clearMessages` 保持**不**重置该字段。
- `components/Chat/PermissionRequestRenderer.tsx`：`handleSubmit` 在 `scope===session|global` 且有批准项时调用 `store.addSessionAllowedTools(approvedTools)`。
- `conversationStore/permissionScope.test.ts`（新增）：12 个用例覆盖 `addSessionAllowedTools` 去重/no-op、`clearMessages` 保留集合、`continueChat` 并入、`resolvePermissionRequest` 状态推导、`expireStalePermissionRequests` 跳过空 plan 块。

### 8.3 验证结果
- `tsc --noEmit`：零错误。
- `vitest run src/stores/conversationStore/`：8 文件 **52/52 通过**（含新增 12 项）。
- P3 实跑：见 4.7，真实数据端到端确证。
- 既有 red test（2.2 的 `bypassPermissions` 剔除）：未触碰，数量未增加。

### 8.4 待用户手动验证（自动化无法覆盖）
default 模式下：选 `本会话` 授权某工具一次 → 同会话后续该工具调用不再弹卡（需真实 GUI 交互，软重试依赖模型复现原操作）。
