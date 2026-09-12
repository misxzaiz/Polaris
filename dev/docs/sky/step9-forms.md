# Polaris 重构 · 第九步：表单工具支持（阻断式 form + schema 驱动面板）

> 状态：规划定稿，实施中（阶段 B 完成）
> 日期：2026-09-12（复审后定稿）/ 阶段 A（2026-09-12）/ 阶段 B（2026-09-12）
> 目标目录：`dev/docs/sky/`
> 承接：第八步（`step8-config.md`）之后；对应审借分析 §2.4/§2.5（`plans/sky-refactor-borrow-analysis.md`）
> 原则：**给 AI 一个「拉起 → 挂起 → 提交 → 回填」的结构化输入闭环，复用既有会话桥，不新增旁路通道。**

---

## ⏩ 实施进展（2026-09-12）

### ✅ 阶段 A：form_core 纯函数（已落地）

- `src-tauri/src/services/form_core.rs` —— `validate_fields` / `expand_dot_paths` / `build_receipt`
  三纯函数 + 8 个单测，类型用 `contracts::Value`（非裸 serde_json）
- `src-tauri/src/services/mod.rs` 注册 `pub mod form_core;`
- 验证：
  - `cargo check --lib` 编译通过（无新增错误）
  - 独立验证 crate（`scripts/tmp/scaffold-form-verify.mjs` 生成，绕 Tauri DLL 0xc0000139）
    用主 crate 的 form_core 替换后 **13 测试全绿**（8 个 form_core + 5 个桥），证明移植无偏移

### ✅ 阶段 B：cap.ai.chat 新增 form_submit 同步动作 + 桥（已落地）

- `src-tauri/src/services/form_flow.rs` —— `FormHold`（formId/sessionId/target/action/read/fields/created_at）+
  `build_hold` / `submit_form` / `cleanup_expired` + 4 个单测
- `src-tauri/src/state.rs` —— 新增 `form_holds: Arc<Mutex<HashMap<String, FormHold>>>`，
  三装配点（main / clone_for_web / integration_tests）补齐
- `src-tauri/src/services/router/ai_chat_capability.rs` —— 同步动作表新增 `"form_submit"` 分支：
  按 `formId` 取 hold（不存在/迟到 → 「表单已失效，请让 AI 重新发起」）→ `submit_form`
  拿到 hold 元数据 build payload → **原文转发目标能力**（`&*s.router` dispatch）→
  `build_receipt` 生成安全回执 → 广播 `form-answered` 事件（前端 FormCard 切提交态）
  → 返回目标能力执行 reply
- 验证：`cargo check --lib` 编译通过（exit 0）
- 信任边界闭环：原始 values 只在服务端 flow 经手，AI / 前端只见 receipt

### 下一阶段：阶段 C（前端 FormCard + question 块分发 hook）
待阶段 B 验收后按 §8 实施顺序推进。

---

## 0. 一句话结论

**表单工具支持 = 三个新增（form_core 纯函数 + form 帧/动作 + 前端 FormCard）+ 复用一个既有「挂起/回填」链路（cap.ai.chat 的 answer 通路）。**
不做独立监听端口、不做第二套 MCP 卡片体系；拒绝裸 get 明文、拒绝 AI 上下文可见原始 values。

**复审修正（2026-09-12）**：上一版草案把表单归为「ask_listener 扩展、独立 cap.form」，
本轮核实 `answer_question` / `respond_plugin_card` 实为 **cap.ai.chat 的同步动作**
（`ai_chat_capability.rs:189-200`）。因此表单提交的归宿不是另起通道，而是 **cap.ai.chat
新增一个同步动作**，与既有 answer 共用同一回落填机制。这同时符合「单入口收敛」，
且让表单天然服务两类消费者。

---

## 1. 关键判断（2026-09-12 代码级核实）

### 1.1 fact——ask_listener 是「通用回填中枢」，表单只是再加一种帧

`ask_listener.rs` 已承载 16 类帧：`ask` / `card` / `browser` / `cancel` / `card_cancel`
+ 11 类 dispatch（dispatch/status/find_expert/roster/continue/targets/agent_save/
agent_delete/agent_list/roster_save）。每类都是「token 校验 → 注册 oneshot → emit chat-event →
await 回填 → 清理」五段式（`ask_listener.rs:218-302,304-407`）。
**表单是这一类模式的自然延续，不是新通道。**

### 1.2 fact——回填的现实归属是 cap.ai.chat，不是独立的 ask 通道

`ai_chat_capability.rs` 的同步动作表已含 `answer_question` / `respond_plugin_card`；
前端提交后 `router_dispatch("cap.ai.chat", { action: "answer_question", ... })`
（`chatService.ts:90` 的 `answerQuestion` → `aiChatDispatch` → `router_dispatch`）。
**表单只需新增一个 `form_submit` 动作，复用同一回落填机制。**

### 1.3 fact——跨引擎注入已就绪，不新增 MCP server

- **claude 引擎**：`claude.rs:build_command` 原样传递 `--mcp-config`；`polaris-ask` server
  已在 `mcp_config_service.rs` 以 `McpServerArgsMode::AskListener` 注入
  `--polaris-port / --polaris-token`（`with_ask_listener` 接线）。
- **simple_ai 引擎**：`chat_loop.rs` 经 `McpClientPool` 把已启用 server 的工具并入工具池
  （`chat_loop.rs:101-128`）。polaris-ask 同样入池 → **表单工具天然跨引擎可用**。

### 1.4 fact——sky 的 form_core 可逐字搬用

`form_bridge.rs` / `tools/form.rs` / `ai_form_submit.rs` 合起来 = validate_fields +
expand_dot_paths + build_receipt + FormBridge（oneshot 等待）+ FormSubmitCapability。
三纯函数各带单测，可直接移植（换 `Capability` 成 Polaris 的同步动作）。

### 1.5 三态 read 是 sky 原创，Polaris 此前没有 —— 保留为本案信任边界

- `read="full"`（默认）：AI 可读全部字段值，`secret` 类型仍掩码
- `read="none"`：AI 只见字段名列表，值全部 `<已隐藏>`
- `secret` 字段无论模式一律掩码 —— 服务端强制，非提示词约束
  单测三态均已锁定（`form_bridge.rs` test 或 `do/sky/src/ai/form_bridge.rs`）。

---

## 2. 交付清单

### A. form_core.rs（纯函数业务核 + 单测，先做）

| 纯函数 | 职责 |
|---|---|
| `validate_fields(fields) -> Result<(), String>` | non-empty array；每字段 non-empty name；select 必须带 options；未知 type 容错 |
| `expand_dot_paths(flat) -> Value` | `{"a.b": 1}` → `{"a": {"b": 1}}`；无点路径原样保留 |
| `build_receipt(read_mode, fields, values, exec_result) -> String` | read=none 只列字段名；full 列值但 secret 恒掩码；附执行结果 |

单测（真实，非骨架）：空数组 / 缺 name / select 无 options / 未知 type 容错 /
点路径嵌套 / 无点透传 / none 不泄露值 / full 掩码 secret / exec 失败报告。
（sky 已有 8 条，直接对齐移植。）

### B. cap.ai.chat 新增同步动作 `form_submit`（主回填通路）

前端提交后 `router_dispatch("cap.ai.chat", { action: "form_submit", formId, values })`，
服务端：

1. 按 `formId` 取 hold 元数据（target/action/read/fields）——不存在即失效
2. `expand_dot_paths(values)` + 注入 `action` → payload 原文
3. **原文转发目标 capability**（敏感值只在这里流经，不进 AI 上下文）
4. `build_receipt`（read 决定）→ 写回桥 → 挂起的 chat_loop 继续

**可选独立 cap.form**：若三方能力/插件需直接触发提交，可将其拆为
`cap.form` 同步动作（同 sky `FormSubmitCapability`），经 RouterBus `dispatch`。
两种形态共享 form_core + 同一桥。

### C. form 工具（MCP，注入两个引擎上下文）

- schema 含 `panel: {"tag": "polaris-form", "interactive": true}`（借用 sky 自 2.5 的机制：
  前端按 function.panel.tag 分发，无需改前端代码即得通用表单面板）
- 字段 `target` 指向**任意已上总线的目标能力**；`action` 按目标动作表传递（提交失败前注入）
- 由引擎在 form 工具被调用且返回 hold 时挂起会话

### D. 前端 FormCard（挂在 question 块分发，复用卡片管线）

- `chatBlocks/index.tsx` 在 `case 'question'` 旁打 hook，新增 `form` 变体渲染 FormCard
- read=none 时值不写入 DOM；提交仍原文发服务端；secret 字段 input 对 AI 不可见

### E. 目标白名单（安全兜底，非能力上限）

表单目标可指向任意已上总线的能力（cap.kv / cap.todo / cap.context / cap.ai.chat …）。
权限层按目标能力做精确匹配；**首个版本白名单建议 cap.kv / cap.todo / cap.context**
（数据域起步），cap.config 属管理面，延后到阶段 E 逐个放开。
白名单只是兜底，不构成能力上限——未来放开即改表，不动架构。

---

## 3. 帧协议（长度前缀 JSON，复用既有 ask_listener 机制）

```
拉起帧（引擎 → 服务端）：{ "type":"form", "token":..., "sessionId":..., "callId":"form-…",
                             "title":..., "read":"full|none", "target":"cap.todo", "action":"create",
                             "fields":[ {name, type, options?, ...} ] }
提交帧（用户 → 服务端）：{ "type":"form_submit", "callId":"form-…", "values": {...} }
回填帧（服务端 → 引擎）：{ "type":"form_answer", "declined": bool, "receipt": "…" }
```

临界点：
- **超时清理**（沿用 sky 600s）：超时后桥清理 sender，迟到的提交被拒绝
- **迟到拒绝**：formId 不存在 → 返回「表单已失效，请让 AI 重新发起」
- **read=none 回填边界**：引擎侧的 tool_result 一律是 `build_receipt` 的输出，
  **绝不回传原始 values** —— 这是本方案的全部意义

---

## 4. 权限与审计

- 权限：`cap.ai.chat.form_submit` 与 `cap.form` 按既有 `PolicyPermission` 矩阵裁决；
  Remote 提交可对本会话放行；管理面目标（cap.config）远程 deny。
- 审计：提交落 `domain_audit`（不落明文 values，只落 action / target / 回执形态）。

---

## 5. 自由度清单（复审后明确保留的扩展点）

| 维度 | 现状方案 | 预留自由度 |
|---|---|---|
| 提交归宿 | `cap.ai.chat.form_submit` 同步动作 | 可拆独立 `cap.form` 供三方/插件直接调用 |
| 目标能力 | 任意已上总线能力号 | 目标可 unfold 到任意域；白名单仅兜底 |
| 前端卡片 | FormCard（question 块变体） | schema 驱动面板可复用给其他交互（非表单）工具 |
| 隐私 | 三态 read + secret 掩码 | 字段级 read 覆盖（细粒度）可后加 |
| 引擎覆盖 | claude + simple_ai（MCP 注入） | 其他引擎接入即天然获得 |

---

## 6. 边界（做/不做）

- ✅ 三个新增（form_core / form 帧+动作 / FormCard）+ 复用回填链路
- ✅ 三态 read + secret 掩码（服务端强制）
- ✅ 目标能力白名单（首个版本：kv / todo / context）
- ❌ 不新增独立监听端口（复用 ask_listener 帧机制）
- ❌ 不做第二套 MCP 卡片体系（前端走 question 块分发）
- ❌ 引擎侧 tool_result 不回传原始 values（回填一律是 receipt）

## 7. 验收标准

1. `cargo check --lib` / `--tests` / `--no-default-features --bin polaris-web` 全绿；
   独立 crate 单测实跑通过（沿用 /tmp verify 模式，绕 Tauri DLL `0xc0000139`）。
2. form_core 单测全绿（对齐 sky 8 条 + Polaris 边界）。
3. `cap.ai.chat` 新增 `form_submit` 动作 + 桥往返测试 + 迟到拒绝测试。
4. claude / simple_ai 双引擎各拉起一次真实表单并回填。
5. 权限：Remote 提交本会话放行；cap.config 目标远程 deny。
6. 前端 FormCard 在两种插件状态下可见性 + vitest。
7. 摘旧四层清单过；`grep` 表单旁路直读点全量核对、无第二通道残留。

## 8. 实施顺序

- **A**：form_core.rs + 单测（先做，独立验证）
- **B**：cap.ai.chat 新增 form_submit 动作 + 桥（复用 answer 通路）
- **C**：前端 FormCard + question 块分发
- **D**：form 工具进 polaris-ask MCP，注入双引擎上下文
- **E**：目标能力白名单逐个放开（kv → todo → context → … → config 后续）

不一次全改；A 验证通过再动 B，回填边界未稳前不摘旧。

## 9. 关联

- 审借 §2.4/§2.5（`plans/sky-refactor-borrow-analysis.md`）
- 第五步 PolicyPermission 规则（`step5-permission-audit.md` §2.C）
- 第七步 cap.ai.chat 动作表（`step7-consolidation.md` 阶段 A2）
- sky 原型实现：`do/sky/src/ai/form_bridge.rs`、`plugins/tools/form.rs`、`plugins/ai_form_submit.rs`