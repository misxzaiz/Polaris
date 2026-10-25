# cap describe 契约归一 · 实施记录

> 日期：2026-10-25 · 状态：**已完成（门禁全过）**
> spec：`plans/cap-describe-contract-unify-spec.md`（状态已改「已实施」）
> 方法：多 agent 工作流——27 cap 并行审计 → 独立复核 → 三视角规划 → 三评审 Borda 投票 → 按胜出方案施工。施工阶段 1-9 由工作流完成；`bus_help` 派生收尾与全量门禁由主会话完成（派生 ask 两次卡死于 provider，其文件产出经逐项核验后采纳）。

## 一、审计与投票结论（决策依据）

- **审计**：27 个 cap（26 生产 + cap.demo），发现 22 条 high、其余 medium/low；独立复核确认 117 条、推翻 0 条、补充 16 条。
- **投票**（Borda，3 评审委员）：`describe 契约归一` 5 分胜出（委员-2/-3 首位）；`示例先行·错误自纠` 4 分（委员-1 首位，其要点——错误文案自纠、example 字段——已并入胜出方案落地）；`cap 文档对齐最小修` 0 分。

### 审计 27 行摘要（severity / 问题数 / 首要问题）

| cap | 级别 | 数 | 首要问题 |
|---|---|---|---|
| cap.ai.chat | high | 17 | describe 把 form_submit 参数声明为 {sessionId, "form 字段"}，实现必填 formId 且不读 sessionId |
| cap.bash | med | 11 | run 的 returns 与 async 两种实际返回均不符；logPath 恒为空串 |
| cap.todo | med | 12 | list 声明 workspaceName，实现不读（静默无效） |
| cap.http | low | 9 | method 合法集合漏 TRACE |
| cap.fs | low | 9 | 无漂移；文件头注释字段清单漏 created（注释与 describe 不同源） |
| cap.data_root | med | 8 | 五个动作返回形状全部与实现不符（声明包装键，实现返回裸结构） |
| cap.config | med | 7 | note 暗示可经 get 读 modelProfiles/providerGroups，实现只认 section=full |
| cap.context | high | 10 | ide_report_file_structure 参数名 describe 写 context，实现读 structure |
| cap.history | med | 5 | list_claude_sessions 声明 workDir，实现完全不接收 |
| cap.hook | med | 3 | bus_help 三段完全无 cap.hook 条目 |
| cap.kv | med | 7 | delete 声明返回 { ok: true }，实现返回 { deleted: true } |
| cap.mcp | med | 9 | call 的 arguments 未标 required，缺省被 serde 拒绝 |
| cap.voice | med | 6 | library.add 实现接受可选 tags，describe 漏掉 |
| cap.registry | med | 7 | register.handler 只描述 forward 形态，plugin-rpc 已实现未入文档 |
| cap.help | med | 4 | index 返回实际含 overridden，describe 只写三键 |
| cap.stream.echo | med | 5 | protocol 段无条目；「白名单」说法名不副实（早已全量放开） |
| cap.prompt_snippet | high | 7 | create.variables 写 { name, ... }，实现要求 key/label/type 等，错误静默丢数据 |
| cap.pluginDiscovery | high | 10 | describe 写参数名 manifest，实现要求 sourcePath |
| cap.pluginServiceManager | high | 9 | start 实际还必填 installPath 与 contribution，文档只写 pluginId |
| cap.ui.render | med | 4 | modules 段完全缺席，AI 不知道两步用法 |
| cap.ui.theme | med | 8 | import 缺省补全语义声明无法在后端证实 |
| cap.ui.chat | high | 7 | summary 宣称可控制工具块折叠/Markdown 开关，patch 白名单无此类字段 |
| cap.ui.input | med | 7 | banner 参数串「tonne」拼写错误 + 自指空引用；tone 枚举等约束未入文档 |
| cap.self.inspect | med | 5 | status 返回声明漏 dataRootIsCustom |
| cap.self.mutate | med | 5 | setSlot 的 props 未列合法键白名单 |
| cap.git | high | 21 | protocol.cap.git 声明的 diff 动作不存在（幽灵动作） |
| cap.demo | low | 5 | 未注册生产总线，文档缺失是正确行为（审计前提记录） |

## 二、落地改动（按层）

| 层 | 文件 | 内容 |
|---|---|---|
| 契约层 | `src-tauri/src/contracts/mod.rs` | 三 helper：`standard_describe`（id 注入，标准形状 `{id,name,summary,note?,actions}`）、`validate_describe`（顶层键白名单/actions 非空/每动作 params+returns）、`unsupported_action`（自纠错误文案）；`Capability::describe()` 文档注释改写为标准形状；13 个单元测试 |
| 聚合层 | `src-tauri/src/services/router/mod.rs` | `described_capabilities` 每项跑 `validate_describe`（异常仅 `tracing::warn` 不阻断）；流式分支补 `"overridden": false`，与同步分支四键对齐 |
| 能力层 | `src-tauri/src/services/router/` 28 文件（+2881/−497） | describe() 全部经 `standard_describe` 归一（含审计建议中文短名）；逐条落实 22 条 high 与 medium 审计问题；未知动作错误分支改用 `unsupported_action`（错误即文档）；动作级 `example` 字段（usage_examples 派生源） |
| 派生层 | `src-tauri/src/services/bus_mcp_server.rs`（+280/−102） | bus_help 四段全部派生自注册表：`tools`=真实 tools_list（删除静态 placeholder）、`protocol`=`derive_protocol(described)`、`usage_examples`=`derive_usage_examples`（从动作级 example 渲染 bus_dispatch 调用）、`modules`=`MODULE_DOMAINS` 域导航+策略警示（入口按 dispatchable 自动判定，根除错标）；手写协议全删（含 cap.git 幽灵 diff 动作）；3 个单元测试 |
| 派生层 | `src-tauri/src/services/dispatch_mcp_server.rs` | cap_dispatch/cap_list 描述与实际对齐：删除「永不漂移」式过度承诺与静态能力举例，补 streaming 语义与管理面审批清单 |
| 协议面 | `src-tauri/src/services/ask_listener.rs`、`state.rs` | cap_list 响应 note 改写（标准 describe 键、streaming 语义、cap.ai.chat 混合型例外）；state.rs 注册注释指向前端消费点 |

## 三、门禁结果（全部通过）

| 门禁 | 结果 |
|---|---|
| `cargo check`（src-tauri） | ✅ 7m31s，0 error；改动文件零新增告警 |
| `cargo clippy --lib` | ✅ 总量 265（存量基线 ~274，净降）；逐条比对 diff hunk，**本次改动零新增告警**（flagged 项全部在改动区外，属死代码/doc 格式存量） |
| `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` | ✅ 41s（web-only 门控双向陷阱未触发） |
| `cargo build --bin polaris-mcp` | ✅ 6m35s，新 schema 已编入 bin |

**未执行**：`cargo test --lib`（本机 Tauri DLL 限制，AGENTS.md 已知边界）——新增 16 个单元测试仅编译级验证，未实际运行。

## 四、遗留项

1. **AGENTS.md 命令表坑**：`cargo check` 实际必须在 `src-tauri/` 下跑（清单唯一在 `src-tauri/Cargo.toml`，仓库根无清单），命令表「从仓库根目录执行」对本条不成立。建议修文档或标注 `--manifest-path` 用法——由你决定。
2. **新 schema 生效条件**：bin 已重编，但运行中的 AI 会话/桥进程需重启才加载（见记忆 polaris-mcp-schema-exe-staleness）。
3. **语义级验证未做**：AI 实际调用成功率需真实会话实测（本次验证到编译/静态检查级）。
4. **前端 `/cap` 斜杠命令**（中文别名补全、注入提示词、参数匹配）为已认可的后续工作，本次未动前端。
5. **工作区混有两批改动**：本次 cap 契约归一（src-tauri 为主）+ 你并行的 P0 web 安全部署闸（`web/`、`rate_limit.rs`、`lib.rs`、`models/config.rs`、前端 4 文件）——提交时建议分开成两个主题。
