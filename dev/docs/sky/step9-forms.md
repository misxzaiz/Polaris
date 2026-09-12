# Polaris 重构 · 第九步：表单工具支持（阻断式 form + schema 驱动面板）

> 状态：规划定稿，实施完成（阶段 A-E 全部落地）
> 日期：2026-09-12（复审后定稿）/ 阶段 A（2026-09-12）/ 阶段 B（2026-09-12）/ 阶段 C（2026-09-13）/ 阶段 D（2026-09-13）/ 阶段 E（2026-09-13）
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

### ✅ 阶段 C：前端 FormCard + question 块分发（已落地）

- `src/types/chat.ts` —— 新增 `FormBlock` / `FormFieldSchema` / `FormFieldType` + `isFormBlock` guard，并入 `ContentBlock` union
- `src/ai-runtime/event.ts` —— 新增 `FormEvent` / `FormAnsweredEvent` + `FormFieldData`，并入 `AIEvent` union
- `src/stores/conversationStore/`
  - `types.ts`：`formBlockMap` + `appendFormBlock` / `updateFormBlock` 签名
  - `createConversationStore.ts`：实现两个方法（幂等追加 + 索引定位更新）；历史恢复规整——仍 pending 的 form 块置为失效（hold 已丢，提示重新发起）
  - `eventHandler.ts`：`case 'form'`（schema 驱动拉起 FormBlock）+ `case 'form-answered'`（回填 ok/receipt）
- `src/components/Chat/chatBlocks/FormCard.tsx` —— schema 驱动面板（string/number/boolean/textarea/select/secret）；
  read=none 用非受控控件 + ref 收集，值不进入 React state；secret 恒密码框；必填前端兜底；
  提交走 `aiChatDispatch({ action:'form_submit', formId, values })`；回执态展示
- `src/components/Chat/chatBlocks/index.tsx` —— `case 'form'` 分发 FormCard
- `src/stores/conversationStore/formBlock.test.ts` —— 4 单测（拉起渲染 / read=none+回填 / 历史恢复失效 / 幂等）
- 验证：tsc 零新增错误（42 存量基线不变）；4 单测全过；conversationStore 108 通过（3 存量网络失败）；
  `vite build` 成功（52s）

### ✅ 阶段 D：form 工具进 polaris-ask MCP + ask_listener 帧（已落地）

- `src-tauri/src/services/ask_mcp_server.rs` —— 新增 `form` 工具（schema 含 `panel: {tag:"polaris-form"}`
  扩展元数据；`fields/target/action` 必填；read 三态；无会话绑定拒绝）。`handle_tools_call`
  分派 `form` 名称 → `handle_form_call`（构造 form 帧 → TCP 发送 → 读 `form_ack`/`form_error`）。
- `src-tauri/src/services/ask_listener.rs` —— 帧分发新增 `"form"` 分支 → `handle_form_frame`：
  token 校验 → 顺手清理超时 hold → `build_hold` 校验 schema（非法回写 `form_error` 帧）→
  注册 `AppState.form_holds` → 广播 `form` chat-event（前端 FormCard 拉起）→ **立即回写
  `form_ack` 帧（非阻塞，AI 不挂起）**。`emit_form_event` 复用 `emit_chat_event` 双通道
  （WS + tauri emit）。
- `src-tauri/src/services/form_flow.rs` —— `FormHold` 新增 `title` 字段（用户可见标题随
  hold 存储，`emit_form_event` 携带给前端）。`build_hold` 签名加 `title` 参数。
- 验证：`cargo check --lib` exit 0（37 存量 warnings）；独立 verify crate 实跑 **20 测试全绿**
  （form_core 8 + form_flow 5[含 title 字段] + form_tool_schema 7）；主 crate 单测编译通过。

**⚠️ 非阻塞决策（对 §3 帧协议的修正）**：文档原 §3 的「回填帧 form_answer（declined/receipt）」
**不适用于本实现**。form 工具是**非阻塞**的——MCP 侧发 form 帧后立即读回 `form_ack`
（`{type:"form_ack", formId, read, status:"waiting"}`），AI 拿到 ack 继续运行，**不挂起会话**。
用户提交走阶段 B 的 `cap.ai.chat form_submit` 动作（复用 answer 回填机制），服务端广播
`form-answered` 事件让前端 FormCard 切提交态；AI 上下文只见 `build_receipt`，原始 values
不回流。即：**拉起帧/ack 走 MCP 通道，提交/回填走 cap.ai.chat 通道**，两条通道在服务端
`form_holds` 交汇。

### ✅ 阶段 E：目标能力白名单逐个放开（已落地）

- `src-tauri/src/services/form_flow.rs` —— 新增 `FORM_TARGET_WHITELIST: &[&str] = &["cap.kv","cap.todo","cap.context"]`
  + `target_allowed(&str) -> bool`（精确匹配）。**语义：默认拒绝、仅白名单放行**——与全局
  权限矩阵（默认放行）方向相反，作为 form 工具层的独立兜底；放开即改表，不动架构。
- `src-tauri/src/services/ask_listener.rs` —— `handle_form_frame` 拉起时拦截：target 不在
  白名单 → 回写 `form_error` 帧（AI 立即拿到失败原因，不渲染表单、不落 hold）。
- `src-tauri/src/services/form_flow.rs` —— `submit_form` 提交时纵深防御：即使 hold 被篡改为
  非白名单 target，提交也拒绝（回执失败，不转发）。防绕过拉起校验。
- `src-tauri/src/services/router/ai_chat_capability.rs` —— `form_submit` 分支错误措辞细化
  （带 formId，白名单拒绝语境通顺）。
- 验证：`cargo check --lib` / `--tests` 双绿；form_flow 新增 3 单测（白名单精确匹配 /
  trim 容错 / 非白名单提交拒绝[DummyRouter 兜底不触发 dispatch]）。

### 阶段 E 收尾说明
白名单当前只含数据域（kv/todo/context）；cap.config 等管理面目标拒绝。后续放开即改
`FORM_TARGET_WHITELIST` 常量表，前端/引擎零改动。

**cap.config 远程收紧的边界（2026-09-13 核实）**：cap.config 的 dispatch target 恒为 `cap.config`
（action 在 payload），不存在 `cap.config.read` 等子能力 target——PolicyPermission 矩阵的
`cap.config* → remote deny` 匹配子路径语义对表单转发不生效，表单侧已由白名单完全覆盖；
而 Web（Remote）性能开关合法走 cap.config patch，若注入矩阵 remote deny 会打挂 Web 性能页。
cap.config 的远程收紧须等 config 语义收敛后单独引入，不在表单白名单范围内（详见 §7 验收走查 #5）。

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

### 验收走查（2026-09-13）

- **#1** ✅ `cargo check --lib` / `--tests` 阶段 E 已双绿；`--no-default-features --bin polaris-web`
  首次跑出**存量门控错误**（`model_profile_service.rs` 的 `Config` import 缺 `tauri-app` 门控，
  step8 之前已存在，step9 未碰此文件），已就地修复（补 `use crate::models::config::{Config, ModelProfile}`），
  重跑确认中。
- **#2** ✅ form_core 8 单测在独立 verify crate 实跑全绿（`scripts/tmp/scaffold-form-verify.mjs`）。
- **#3** ✅ form_submit 桥往返 + 迟到拒绝已入 `form_flow.rs` 与 `ai_chat_capability.rs`（表单失效拒绝）。
- **#4** ⏳ 双引擎真实拉起属人工闭环，待测试台验证（帧协议与 MCP tool 已是双引擎共用注入，见 1.3）。
- **#5** ✅ **落地说明（重要）**：„cap.config 目标远程 deny“在表单语境下的落点是**阶段 E 表单白名单**
  `FORM_TARGET_WHITELIST`（cap.config 不在表内 → 拉起回 `form_error` 帧 + 提交纵深防御拒绝），
  **而非** PolicyPermission 矩阵。原因（代码级核实）：
  - `cap.config` dispatch 的 target 恒为 `cap.config`（action 在 payload），**不存在** `cap.config.read` 等
    子能力 target；矩阵的 `cap.config* remote deny` **匹配子路径永远不触发**（`policy_permission.rs` 前缀
    `starts_with` 只匹配真实 target 前缀，而真实 target 就是 `cap.config` 本-body）。
  - Web 前端（Remote source）性能开关**现在合法地** `router_dispatch("cap.config",{action:"patch"})`
    （`configStore.ts:189`）；若在 config.json 注入 `cap.config* → remote deny`，会让 Web 性能页
    **被打挂**。文档 §4 预留的「精确 `cap.config.read → allow` 覆盖通配 deny」因不存在该 target 而无意义。
  - 因此：**cap.config 的远程收紧若需要，须等 config 语义收敛到未被 Web UI 直用的动作粒度后单独引入**，
    不在表单白名单范围内；表单的 cap.config 拒绝已由白名单完全覆盖。
- **#6** ✅ 前端 FormCard vitest（`formBlock.test.ts` 4 单测）+ tsc / vite build（阶段 C 已绿）。
- **#7** ✅ `grep` 旁路核查：`form_holds` 读写点 **仅 3 处**（ask_listener 拉起清理/注册、ai_chat_capability
  form_submit 取走）；旧 `form_bridge` / `form_answer` 帧 / `ai_form_submit` **零残留**；前端 form
  事件/块唯经 eventHandler `case 'form'`/`form-answered` → FormCard → `form_submit`。无第二通道。

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