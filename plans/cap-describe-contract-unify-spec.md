# spec: cap describe 契约归一（describe 单一权威）

> 日期：2026-10-25 · 状态：**已实施（2026-10-25 多agent评审选定本方案后落地；实施记录见 cap-describe-contract-unify-implementation.md）**
> 背景：cap 协议存在"三张皮"——各能力 `describe()`（cap_list / cap.help 聚合源）、`bus_help` 手写 protocol/usage_examples/modules、未知动作错误文案。三者独立演化已互相漂移（bus_help 含不存在的 `diff` 动作、cap_list describe 键两套口径、文档与实现参数不符）。本方案把 describe() 立为唯一权威，其余两张皮全部派生。
> 本文即规划 JSON 中 P0 阶段的 spec 产出（曾用名 `cap-describe-single-authority.md`，按任务指令统一为本文件名，仅此一个 spec 文件）。

---

## 1. 目标

**describe() 是 cap 协议的唯一权威**：

1. **标准形状由 contracts 层强制**——id 注入、validate 巡逻，能力体不再手写 `id`/`description` 键；
2. **动作清单与错误文案共享同一来源**——各能力的动作常量同时供 describe、未知动作报错、validate 三处使用；
3. **bus_help 的 protocol / modules / tools / usage_examples 全部从注册表派生**——删除一切手写的第二份协议。

一句话：任何手写的第二份协议都是漂移温床，一律删除。

**同步面结论**（已核实）：纯后端改动。`src/` 无 cap_list / bus_help / describe 消费点；`D:\space\base\Polaris-plugin` 仓库为 manifest/schema 域，不消费 describe——**无前端 / 插件改动**。本次无 invoke 契约变化（cap.* 请求/响应不变）。

**前提差异（如实报告）**：规划材料称 `plugin_discovery_capability.rs` 与 `policy_permission.rs` 为未提交改动；实测 `git status --porcelain` 两者干净（"远程只读拆分"已在 HEAD 提交 0905a5eb），当前未提交仅为前端 4 文件 + `plans/remove-statusbar-task-center-html-card.md`。方案直接在 HEAD 叠加、无回退诉求。

---

## 2. 接口

### 2.1 标准 describe 形状

```jsonc
{
  "id": "cap.x",              // 由 standard_describe 注入，能力体不手写
  "name": "中文短名",          // 采纳审计 suggestedName 26 值（§4.3）
  "summary": "一句话说明",
  "note": "边界/权限提示（可选）",
  "actions": {
    "<动作>": {
      "params":  { "<参数>": "类型/说明（标必填）" },
      "returns": "返回结构",
      "note":    "动作级备注（可选）",
      "example": { "action": "<动作>", ... }   // 可选；bus_help usage_examples 派生源
    }
  }
}
```

### 2.2 三契约 helper（落地于 `src-tauri/src/contracts/mod.rs`，Capability trait 旁）

```rust
/// 构造标准顶层键 { id, name, summary, note?, actions }。
/// id 由 helper 注入——消除现 cap.mcp / cap.voice 手写 "id"/"description"
/// 与其余能力 "summary" 的两套口径（mcp_capability.rs:225-226、voice_capability.rs:814-815，已抽查核实）。
pub fn standard_describe(
    id: &str, name: &str, summary: &str, note: Option<&str>, actions: Value,
) -> Value;

/// 校验 describe：顶层键白名单、actions 非空、每动作含 params/returns。
/// 返回违规项清单（空 = 合规），供各能力 describe_contract 测试与聚合层告警共用；不 panic、不阻断。
pub fn validate_describe(id: &str, describe: &Value) -> Vec<String>;

/// 未知动作自纠文案：
/// 「cap.x 不支持动作: a（支持: …；协议见 cap.help show target=cap.x）」
pub fn unsupported_action(cap: &str, action: &str, supported: &[&str]) -> String;
```

`Capability::describe()` 的文档注释（contracts/mod.rs:309-318，现自称"单一事实来源"但未定义形状）改写为上述标准形状。

---

## 3. 所有者

| 职责 | 所有者（唯一写入路径） |
|---|---|
| 标准 describe 形状 + 三契约 helper（契约权威） | `src-tauri/src/contracts/mod.rs` |
| cap_list 聚合：describe 注入 + validate 巡逻（聚合权威） | `src-tauri/src/services/router/mod.rs` `described_capabilities()` |
| 各能力 describe 内容（内容权威，每能力一处） | 26 个 `src-tauri/src/services/router/*_capability.rs` |
| bus_help 四段派生（文档派生权威） | `src-tauri/src/services/bus_mcp_server.rs` `handle_bus_help_impl` + 纯函数 `derive_protocol` |
| dispatch / cap_list 文档措辞 | `dispatch_mcp_server.rs`、`ask_listener.rs`、`router/mod.rs` |
| 本方案与验收口径 | `plans/cap-describe-contract-unify-spec.md`（本文件） |

---

## 4. 改动面

### 4.1 C1 契约层（`contracts/mod.rs`）

三 helper（§2.2）+ trait `describe()` 文档注释改写为标准形状。验收：`cargo check` 通过 + 三 helper 单元测试。

### 4.2 C2 聚合层（`router/mod.rs:569-599`，已核实）

`described_capabilities()` 对每项 describe 跑 `validate_describe`，异常仅 `tracing::warn` 不阻断（协议保守）。流式分支（router/mod.rs:589-594，现只推 3 键）补 `"overridden": false`，与同步分支（:579-585，4 键）对齐——AI 统一按四键解析不再落空。**cap_list 每项键形状 `{ id, streaming, overridden, describe }` 不变，describe 内部纯增量。**

### 4.3 C3 26 能力 describe() 内容修正（审计 worklist 全量落地）

每条实施时以源码复核；审计自标两处"未核实"（`register_pending_plan` 空 planId 行为、ui.theme import 的 Dark 补全归属）——存疑只改文档措辞不动行为。要点与锚点：

| 能力 | 修正要点 | 锚点（describe vs 实现） |
|---|---|---|
| cap.ai.chat | form_submit/form_skip/form_template_save/register_pending_question 真实参数；start 返回 sessionId 裸字符串；continue 返回 {ok:true} | ai_chat_capability.rs:122-143 vs 253/291/347-358/437-439/496-529/572-584 |
| cap.context | entry 展开 ContextEntry（JSON 键为字面 `type_`）；ide_report_* 参数 structure/diagnostics；补必填 cursor_offset；get_all 裸数组 | context_capability.rs:51-59 vs context_core.rs:117-135/154-157/228-235 |
| cap.prompt_snippet | variables 每项 {key,label,type,required?,defaultValue?,placeholder?}；delete returns {deleted,item} | prompt_snippet_capability.rs:266/272 vs models/prompt_snippet.rs:22-39、:234/246 |
| cap.pluginDiscovery | validate_manifest sourcePath / install_local sourcePath / install_package packagePath / install_remote sourceUrl / uninstall_with_cleanup pluginId 必填 | plugin_discovery_capability.rs:184-189 vs 283/292/315/338/386 |
| cap.pluginServiceManager | start 补 installPath+contribution 必填；stop/restart 补 pluginId+serviceId；autostart 改 pluginStates map；list_status 裸数组；note「Remote 默认 deny」改为已鉴权放行 | plugin_service_manager_capability.rs:123-130 vs 148-156/169-170/181-182/193-197/211-226 与 policy_permission.rs:244-250 |
| cap.kv | delete returns {deleted:true}（已核实） | kv_capability.rs:103 vs 75 |
| cap.bash | run 按两种模式写明返回；logPath 恒空；workdir 实为宿主进程 cwd；timeoutMs=0 同步语义 | bash_capability.rs:570-580 vs 371-395/425-432/492 |
| cap.todo | describe 补 delete 动作；删 list.workspaceName；create 补 relatedFiles/sessionId/workspaceId/subTasks | todo_capability.rs:478-508 vs 150-177/205-213 |
| cap.http | method 清单补 TRACE | http_capability.rs:116 vs 190-195 |
| cap.data_root | 五动作返回改裸类型 + options 展开字段 | data_root_capability.rs:764-768 vs 780-802/122-128 |
| cap.config | get 的 section∈白名单\|all\|full 三形态；modelProfiles/providerGroups 仅 full 可读；patch 双路径 | config_capability.rs:388-391 vs 291-301/313/344-355 |
| cap.history | 删 list_claude_sessions 的 workDir | history_capability.rs:42 vs 99-104 |
| cap.mcp | description→summary；call.arguments 标 required；返回补 toolGates/tools/isError | mcp_capability.rs:226-246 vs 43-52/285/311-314/387-395/497-503（description 键已抽查核实） |
| cap.voice | description→summary；library.add 补 tags；voices.add type 可省；synthesize voiceRef 缺省冰糖 | voice_capability.rs:814-824 vs 242-244/386/486/646-650（description 键已抽查核实） |
| cap.registry | 补 plugin-rpc handler 形态与 replace/replaceMode | registry_capability.rs:365-370 vs 174-283 |
| cap.help | index 返回补 overridden | help_capability.rs:70 vs router/mod.rs:579-584 |
| cap.self.inspect | status/capabilities 返回补 dataRootIsCustom 与三个计数字段 | self_capability.rs:220/222 vs 69-77/166-177 |
| cap.self.mutate | listSlots 同步回包形状；setSlot props 列 PROPS_KEYS | self_mutate_capability.rs:111-112 vs 125-133/27 |
| cap.ui.theme / cap.ui.chat / cap.ui.input | returns 改实际同步回包 {ok,forwarded,capability,action,…}（ui_theme_capability.rs:104-119 已核实）；「效果经 tool_call_end 落前端」改为 **tool_call_start**（消费点 src/stores/conversationStore/eventHandler.ts:482-489 case 'tool_call_start' 调 consumeCapUiDispatch，已核实）；ui.chat summary 删「工具块折叠/Markdown 开关」或列全 KNOWN 白名单（ui_chat_capability.rs:73 vs 31-38）；ui.input 改 tonne 拼写并写全 banner 约束（ui_input_capability.rs:139 vs 88-122） | ui_theme_capability.rs / ui_chat_capability.rs / ui_input_capability.rs |
| cap.git | describe 全量化：动作键与中文说明从 KNOWN_ACTIONS（git_capability.rs:239-261，已抽查核实）+ action_label（:272-323）常量生成，与 `every_known_action_is_handled` 巡逻（:1019-1060）同源，常量加动作 describe 自动跟随；summary 删「见 plans/git-panel-p0-spec.md」死指针（已核实断裂：该文件 76 行无动作清单）；写类动作统一 Plugin 拒绝 note | git_capability.rs |
| cap.stream.echo | 标注「仅 WS 流式通道（dispatch_stream），cap_dispatch 同步不可调」 | stream_echo_capability.rs:47-54 |

其余（ui.render、fs 等）不在 C3 文件清单内（审计标题为 26 能力、清单 23 文件），实施按 worklist 逐条对源码复核为准。

- **name 中文短名**：采纳审计 suggestedName 26 值——AI会话/Shell任务/待办/HTTP转发/文件只读/数据根/系统配置/上下文/会话历史/钩子/键值存储/插件工具/语音电台/能力注册/能力索引/流式回显/片段CRUD/插件发现/插件服务/界面渲染/主题控制/对话渲染/输入区调节/自身透视/自身改造/Git仓库域。
- **测试**：每能力 `#[cfg(test)]` 增一个 `describe_contract` 测试调用 `validate_describe`。
- 验收：`cargo check` + 全部 describe_contract 测试 + `cargo clippy --lib` 无新增 warning。

### 4.4 C4 错误工效：未知动作清单化 + 静默吞错显式化

文件：context / history / prompt_snippet / fs / data_root / plugin_discovery / ui_render / git 共 8 个 capability。

- 未知动作臂统一换 `contracts::unsupported_action`，动作清单取各能力已有常量：`FS_ACTIONS`（fs_capability.rs:41）、`DATA_ROOT_ACTIONS`（data_root_capability.rs:733）、`PLUGIN_DISCOVERY_ACTIONS`（plugin_discovery_capability.rs:66）、`UI_RENDER_ACTIONS`（ui_render_capability.rs:81）、git `KNOWN_ACTIONS`（git_capability.rs:239）——均已在源码核实；无常量的能力就地声明 `const`，使 describe、错误文案、validate 三处共享同一清单。
- 三处静默错误改显式 `Err`：context remove 缺 id 由「删空串返回 {ok:true}」改 Err（context_capability.rs:103-106）；history sessionId 缺失由 `unwrap_or("")` 改 Err（history_capability.rs:79/91/107）；prompt_snippet `parse_variables` 解析失败由静默置空改 Err（prompt_snippet_capability.rs:105-108），`load_all` 跳过损坏条目时 `tracing::warn` 记录 id 与错误（:52-55）。
- 验收：`cargo check` + 受影响单测更新（如 kv_capability.rs:230 既有断言保持绿）。

### 4.5 C5 bus_help 三张皮归一（`bus_mcp_server.rs:550-648`，已抽查核实）

1. **protocol**：删手写五键对象（:590-631，仅 cap.todo/http/bash/fs/git，且含不存在的 `diff` 幽灵动作——已核实 git `KNOWN_ACTIONS` 无裸 `diff`，只有 get_diffs/get_worktree_diff 等）与「各白名单能力的动作协议」措辞（:591，与同文件 :249/:561「无白名单」自相矛盾）。改为抽纯函数 `derive_protocol(&[Value]) -> Value` 遍历 `router.described_capabilities` 生成全量协议段，便于无 RouterBus 单测；describe 为 null 的能力（动态注册/测试夹具）归入「未提供自描述」清单。
2. **usage_examples**（:632-645）：删手写 per-cap payload，改从各能力 describe 的动作内可选 `example` 字段派生。首批给原 12 条对应动作补 example（todo create/list/complete、http GET/POST、fs list/getFileInfo、bash run/status、cap_list、cap_dispatch history list_sessions、ai.chat start）；无 example 的能力不生成示例。
3. **modules**（:563-584）：删全部手写「协议/返回」串（漂移源：diff 幽灵动作、http 返回漏 url、ui.theme 漏 delete、ui 域漏 cap.ui.input/cap.ui.render），只留域→能力导航 + 策略面警示（审批门槛/Remote 语义）；「入口」按 id 是否在本进程 dispatchable 集合自动判定，纠正错标——cap.kv/cap.prompt_snippet/cap.data_root/cap.hook/cap.context/cap.self.inspect/cap.help/cap.registry 本进程已注册（bus_mcp_server.rs:138/140/141/145/167-170/173-175/177-179/183-217，已核实注册块）却写「仅主进程 cap_dispatch」；cap.context 实为独立内存实例（主进程不可见）需警示而非否定存在（:21 头注释同错一并改）。
4. **tools**：改用真实 `tools_list()`（:244-251 动态 enum）替代 `tools_list_placeholder`（:551/:654-667 静态 8 项），删除占位函数。
5. **bus_dispatch 描述**：target 举例补 cap.http/cap.bash/cap.fs。

验收：`cargo check` + `derive_protocol` 单测（protocol 键集 == 提供 describe 的注册能力集）+ 手动调用 bus_help 工具核对响应。

### 4.6 C6 dispatch / cap_list 文档面措辞

文件：`dispatch_mcp_server.rs`、`ask_listener.rs`、`router/mod.rs`。

1. dispatch_mcp_server.rs:461-470 `cap_dispatch` 的 target 举例（10 例，系统性漏 cap.bash/cap.http/cap.fs/cap.git）改为非穷举措辞「如 cap.ai.chat/cap.bash/…，全量以 cap_list 返回为准」；:481 删「动态生成、永不漂移——不要依赖记忆中的动作清单」的虚假保证，改为「以 cap_list 返回为准；若报缺少参数，以错误文案列出的参数键名为准」；审批清单按 policy_permission.rs:281-315 修正（已核实）：删 cap.config（patch/reset_cli 直接生效），补 cap.data_root:set_root / cap.bash:run / cap.http / cap.registry:register。
2. ask_listener.rs:1293-1298 cap_list note 重写（已核实现文）：describe 形状说明改为「id/name/summary/note?/actions」；泛化 streaming 警示——streaming:true 能力（cap.stream.echo）仅 WS 流式通道、cap_dispatch 同步不可调，cap.ai.chat 为混合型例外（start/continue 可经 cap_dispatch 同步调用，RouterBus 对流式表目标同步 dispatch 自动回退 invoke，router/mod.rs:836-860 已核实），token 流经 WS chat-event。
3. router/mod.rs:706「需用户审批，Phase 0 暂不支持」补指路「bus 进程请改经主进程 cap_dispatch 调用（返回确认请求 id）」。

验收：`cargo check`；grep 断言「永不漂移」「各白名单能力」「tool_call_end 事件落前端」在 src-tauri 内清零。

### 4.7 C7 发布门槛（实施完成后依次真实执行并回报输出）

1. `cargo check`
2. `cargo clippy --lib`（新代码零新增 warning）
3. `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（命令门控双向检查）
4. `cargo build --bin polaris-mcp`——dispatch/bus server 的工具 description 属 MCP schema，改后不重编独立 bin 会让 AI 继续看旧 schema（AGENTS.md 已知坑，不可跳过）

同时确认：本次无 invoke 契约变化；describe 仅新增 id/name/example 键（mcp/voice 的 description→summary 为同义迁移），插件仓库无需同步。

---

## 5. 验收标准（汇总）

1. contracts 三 helper 单元测试通过（P1）。
2. `cargo check` 通过（全程）。
3. 全部 describe_contract 测试：能跑则**真实运行**并报告结果；本机 `cargo test --lib` 可用性存疑（AGENTS.md §九记不可用 vs commit ac8fed0d 自述已解锁）——以 cargo check 编译进 lib 为最低门槛，跑不了交 CI 兜底，**不把未运行的测试写成通过**。
4. `cargo clippy --lib` 无新增 warning。
5. `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。
6. `cargo build --bin polaris-mcp` 完成重编。
7. grep 断言：「永不漂移」「各白名单能力」「tool_call_end 事件落前端」在 src-tauri 内清零（P4）。
8. `derive_protocol` 单测：protocol 键集 == 提供 describe 的注册能力集（P3）。
9. 受影响既有单测（如 kv_capability.rs:230）保持绿。
10. **协议保守性**：cap_list 每项键 `{id, streaming, overridden, describe}` 不删不改语义；describe 既有键（summary/actions/note）不删不改语义，仅新增 id/name/example；流式/同步条目键集一致（四键）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 审计个别结论自标未核实 | 实施时逐条对源码复核；存疑只改文档措辞不动行为，若需改行为另立 spec |
| 一次改 26 能力回归面大 | P1 先以 cap.kv（最小）/cap.bash（中等）两样板定型 standard_describe 模板再铺开；describe_contract 测试 + KNOWN_ACTIONS 式常量巡逻防再漂移；按域分组提交便于定点回滚 |
| MCP schema 陈旧坑 | P5 显式 `cargo build --bin polaris-mcp` 门槛，不可跳过 |
| 协议破坏性 | 唯一语义修正是把文档改成与实现一致（AI 按错文档的用法本就失败）；bus_help protocol 段从 5 键扩为全量属纯增量 |

## 7. 实施分期与回滚

- **P0**：本 spec 评审定稿。
- **P1 契约层样板**：contracts 三 helper + 单测；迁移 cap.kv / cap.bash 两样板 → 模板定型。
- **P2 全量 describe**：按 §4.3/§4.4 修完 26 能力（含中文短名、首批 12 条 example、错误文案清单化、三处静默吞错）。
- **P3 bus_help 派生**：handle_bus_help_impl 重写 + derive_protocol 纯函数单测，删 tools_list_placeholder 与全部手写协议/示例。
- **P4 文档面收尾**：§4.6 措辞修正 + grep 清零。
- **P5 发布门槛**：§4.7 四命令通过后按域分组提交。
- **后续（不在本次实施）**：前端 /cap 斜杠命令消费标准 describe 契约；插件仓库如未来需要消费 describe 再做三处同步。

**回滚**：纯文档/文案/错误文案增量（无 invoke 契约变化），单提交 revert 即回滚；按域分组提交可定点回退。

---

## 附录 A：改完后 AI 视角样例

```
// cap_list.capabilities[] 中（cap.ai.chat，修正后）：
{ "id": "cap.ai.chat", "streaming": true, "overridden": false,
  "describe": {
    "id": "cap.ai.chat", "name": "AI会话",
    "summary": "AI 会话（流式）：启动/继续/打断/输入/计划审批/问题回答/表单/待办注册",
    "note": "start/continue 可经 cap_dispatch 同步调用（RouterBus 回退 invoke）；token 流经 WS chat-event 订阅",
    "actions": {
      "start":       { "params": { "message": "string（必填）", "options": "ChatRequestOptions?", "sessionId": "string?" },
                       "returns": "sessionId 字符串（JSON string，非 {sessionId} 包装）",
                       "example": { "action": "start", "message": "<用户消息>" } },
      "form_submit": { "params": { "formId": "string（必填）", "values?": "any", "private?": "bool", "read?": "string" },
                       "returns": "目标能力执行结果（collect 模式为 { collected: true }）" } } } }

// bus_help.protocol（派生，键 = 全部提供 describe 的已注册能力）：
"protocol": {
  "说明": "已注册能力的动作协议，聚合自各能力 describe()（与 cap_list 同源）；streaming:true 能力仅 WS 通道可调",
  "cap.ai.chat": { "name": "AI会话", "summary": "…", "note": "…", "actions": { …原样透传… } },
  "cap.kv": { "name": "键值存储", "actions": { "delete": { "params": { "key": "string（必填）" }, "returns": "{ deleted: true }" }, … } }, … }

// usage_examples（从 describe.example 派生）：
{ "tool": "cap_dispatch", "arguments": { "target": "cap.ai.chat", "payload": { "action": "start", "message": "<用户消息>" } } }

// 未知动作错误（contracts::unsupported_action，可自纠）：
cap.ai.chat 不支持动作: fom_submit（支持: start, continue, interrupt, send_input, approve_plan, reject_plan,
answer_question, respond_plugin_card, form_submit, form_skip, form_template_save, form_template_list,
register_pending_question, register_pending_plan, get_pending_plans, get_pending_questions,
clear_processed_plans, clear_answered_questions；协议见 cap.help show target=cap.ai.chat）
```

## 附录 B：本次规划已核实的抽查记录

- `contracts/mod.rs:302-321`：Capability trait + describe() 文档注释自称「单一事实来源」（读取核实）。
- `router/mod.rs:579-594`：同步分支 4 键、流式分支 3 键缺 `overridden`（读取核实）。
- `mcp_capability.rs:225-226`、`voice_capability.rs:814-815`：手写 `"id"`/`"description"` 键（读取核实）。
- `bus_mcp_server.rs:550-647`：手写 protocol 五键（:590-631，cap.git 段含 `diff` 幽灵动作）、手写 usage_examples（:632-645）、tools_list_placeholder（:551/:654-667）（读取核实）。
- `git_capability.rs:239-261` KNOWN_ACTIONS 常量及 :1019-1020 巡逻注释（grep + 读取核实）。
- 其余行号锚点来自规划材料审计结论，实施时逐条以源码复核。
- 本任务为只读规划，**未运行任何 cargo 命令**（P5 门槛属实施阶段）。
