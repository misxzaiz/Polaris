# opencode 集成优化 —— 需求分析

> 背景：opencode 引擎已完成基础接入（见 `plans/opencode-engine-integration.md` + `src-tauri/src/ai/engine/opencode.rs`），当前支持单轮/续接对话、模型选择、工具调用事件映射。
> 本文对照现有实现做差距分析，梳理下一阶段「集成优化」的需求边界与优先级。
> 状态：需求分析（未实现）。
> **Rev2（2026-10-17）**：基于 `opencode --help`（v2.0.30，与提交时实测同版本）补充 CLI 能力清单，修订批次 1/2 落地方案，详见「五、CLI 能力对照（Rev2 补充）」与各批次修订说明。

## 一、现状小结

- 接入形态：编译期内置引擎，`opencode run "<msg>" --format json --model <m> [--session <id>] --auto`，stdin=null。
- 事件：JSONL `step_start/text/tool_use/step_finish/error` → AIEvent；EOF 即完成信号。
- 模型：`get_opencode_models` 实时 spawn `opencode models`，免费模型排前，默认 `opencode/glm-5.3-flash-free`。

## 二、问题清单（按优先级）

### P0 —— 语义正确性（影响用户可见行为）

1. **中断被误报为错误**
   - 现状：`interrupt` 仅 `kill_process`；进程被杀后 stdout 管道关闭 → 读取循环走 EOF fallback 的「无产出」分支 → 向 UI 补发 `error("opencode CLI 异常退出") + SessionEnd(Error)`。用户主动中断却被当成引擎故障。
   - 这正是记忆 `ai-chat-interrupt-continue-root-cause` 一类「中断语义不清」的复发模式。
   - 需求：中断路径有明确归属——kill 前/后在 SessionManager 标记 `interrupted` 状态，EOF 线程读到该标记时改发 `SessionEnd(Interrupted)`（或前端约定的中断 reason），不再发 fallback error。**禁止用超时/延迟掩盖竞态**，标记写入与读取必须是明确顺序（kill → 状态 → EOF）。

2. **`continue_session` 用 `sleep(100ms)` 等 kill 生效**
   - 现状：`kill_process` 后 `thread::sleep(100ms)` 就 spawn 新进程。违反 AGENTS 原则「绝不用超时掩盖同步问题」——慢机器上旧进程未死，新旧两个 opencode 实例写同一 opencode session。
   - 需求：等待旧子进程**实际退出**（`Child::wait`，需 SessionManager 持有/暴露 Child 或 wait handle），拿到退出状态后再启动续接；或至少 kill → wait 带 timeout 上限、失败则明确报错。

3. **方案承诺的 `--standalone` 未落地**
   - `opencode-engine-integration.md` 风险 2 明确「用 `--standalone` 规避后台服务依赖」，但 `build_command` 没有该参数。opencode 默认可能拉起后台 server 进程，kill 时留下孤儿进程（Windows 32K 限制问题之外的第二颗雷），也让 `interrupt` 的进程树语义不完整。
   - 需求：确认 opencode v2.x 的 standalone 服务化行为后，要么加 `--standalone`，要么 kill 改进程树终止；结论回写方案文档。

### P1 —— 健壮性与协议失容性

4. **未知事件类型整行静默丢弃**
   - `#[serde(tag="type")]` 遇到 opencode 新版本新增的事件 type → 反序列化失败 → `parse_line` 返回 None → 仅 warn 后丢弃。版本升级后新事件类型（如 reasoning/image/compaction）全部不可见，属于「协议无运行时 schema 校验」缺口的实例。
   - 需求：未知 type 不丢弃——保留 `#[serde(other)]` / untagged 兜底变体后至少 debug 级记录 type 名与 sessionID；解析失败行计数进入 EOF 诊断摘要，便于版本漂移排查。

5. **长消息 32K 限制是硬死路**
   - 现状：超限只报错让用户「缩短消息」。编程场景（粘贴大段代码/大 diff）必然触发。
   - 需求：探索消息经临时文件/stdin 传递（opencode run 若支持 stdin 或 `--file` 类参数则接入；不支持则在错误文案中给出明确字数指引），并加**前置校验**（发送前检查长度）而非靠 OS error 206 事后报错。

6. **`is_available()` 恒 true**
   - 前端引擎列表对 opencode 永远「可用」，未安装游戏必须等 spawn 失败才知道。
   - 需求：`is_available` 缓存 `get_cli_path()` 结果（进程内缓存，避免每次 which/where），未找到时返回 false，前端据此显示安装引导（`install_guide` 已有文案）。

### P2 —— 体验与治理

7. **诊断日志级别过高**：stdout 逐行 `info`（含最长 300 字节 preview）+ stderr 每行 `warn`。生产数据流高频落盘。改为 debug 级；stderr 正常启动噪音不应全 warn，保留 error 级用于异常退出摘要。
8. **模型列表无缓存**：`get_opencode_models_impl` 每次调用实时 spawn CLI（476 行输出）。模型列表变化极低频，需求：增加 TTL/会话期缓存 + 失败降级返回上次成功列表。
9. **能力矩阵待验证项**：`image_input=false` 标注「待验证」，`env_keys` 映射（OPENAI_API_KEY 等）是否实际生效未经测试——决定会不会把 Polaris 模型 profile 的 key 泄漏进 opencode 环境。需求：实测后固化 metadata，必要时按模型 provider 精确注入。
10. **断线续接体验**：方案已知缺口——无历史回填、`--session` 续接重复计费。属于后续规划项，本阶段不阻塞，但应在前端 UI 层明示「新会话不含 opencode 侧上下文」。

## 三、非目标（本轮明确不做）

- 不做 provider/opencode.json 注入的完整方案（保留到模型 profile 统一治理时一并做）。
- 不拆分 `opencode.rs`（977 行尚可，未到拆分门槛）。
- 不动 AIEvent 协议结构（中断 reason 复用现有 SessionEnd 枚举值，若需新增 `Interrupted` 变体则走协议双端同步流程）。

## 四、建议实施顺序

| 批次 | 内容 | 验收 |
|---|---|---|
| 批次1（P0） | 需求 1 中断语义、需求 2 去 sleep、需求 3 standalone 结论 | 手动中断后 UI 无 error 误报；`cargo check` 通过 |
| 批次2（P1） | 需求 4 失容兜底、需求 5 长消息前置校验、需求 6 可用性检测 | 单测覆盖未知事件；可用性图标与实际一致 |
| 批次3（P2） | 日志降级、模型缓存、metadata 实测固化 | info 日志不再逐行刷屏；模型列表二次打开无进程启动 |

每批次完成后运行：`cargo check`（后端）+ `pnpm exec tsc --noEmit` / `pnpm lint`（若动前端）；改动命令层则补 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`。

## 五、CLI 能力对照（Rev2 补充，2026-10-17 实测）

版本确认：本机 opencode v2.0.30，与会话接入时实测同版本，协议无漂移。
真实事件流复测（`opencode run --format json`）：`step_start ×2 → text → EOF`，
**无 step_finish**，完成信号 = stdout EOF（与 `opencode.rs` 588-593 行「关键事实」一致）。
注意：`opencode.rs` 文件头部注释（11-15 行）仍写「step_start → … → step_finish」，
与 EOF 事实自相矛盾，批次 1 顺带修正（StepFinish 分支与单测保留，无害）。

### 5.1 尚未使用的 run flags

| Flag | 状态 | 对应缺口 / 新机会 |
|---|---|---|
| `--standalone` | 未用 | **确认可用**，直接落实需求 3（原「待确认结论」升级为落地项） |
| `--file, -f <path>` | 未用 | **需求 5 长消息的确定化解法**：消息写临时文件后挂载；同时实测图片是否走 --file（`image_input=false 待验证` → 能力定论） |
| `--thinking` | 未用 | 思考块输出；当前解析器无 reasoning 事件映射，接入前先确认 AIEvent 协议承载方式 |
| `--title <s>` | 未用 | 可把 Polaris 会话标题传给 opencode（体验项） |
| `--fork` / `--continue,-c` | 未用 | `fork_session: false → true` 候选 |
| `--agent <s>` | 未用 | agent 选择；前端 selector 能力位可从 `['model','profile']` 扩展 |
| `--server <url>` | 未用 | 远期方向（见 5.3） |

### 5.2 尚未使用的子命令

| 子命令 | 机会 |
|---|---|
| `session list/delete/export/import` | 需求 10 断线续接/历史回填的明确技术路径：`session export` 导出会话 JSON 回填 Polaris dialog |
| `serve` / `api` / `--server` | 远期重设计（见 5.3） |
| `acp` | 项目内无 ACP 基础设施（全仓 grep 无结果），仅记录，不展开 |

### 5.3 明确不做 / 远期

- `serve` + `api` 长驻服务架构（消除每次对话重复 spawn、根治 32K 限制）——属方向性重设计，
  需进程生命周期治理（守护、重启、端口/stdio 选型），不进本轮批次。
- `opencode.json` / provider 注入完整方案仍保留（见「三、非目标」）。

## 六、批次 1 实现 spec（2026-10-17，已过复审）

> **状态更新（2026-10-17）**：批次 1 已实施——T1 中断标记（独立集合，不受
> `kill_process` remove 影响）、T2 `ExitSignal`（Condvar bounded wait 替代
> `sleep(100ms)`）、T3 `--standalone` + 注释纠正 + `CREATE_NO_WINDOW`。
> 验证：`cargo check` 通过；`--no-default-features --bin polaris-web
> --bin polaris-mcp` 通过；`cargo clippy --lib` 无新增 warning；
> `--standalone` 真跑事件流格式不变。**待人工验收**：桌面端
> 「手动中断 → UI 无 error 误报、会话正常关闭」
> （本机 `cargo test --lib` 不可用，解析单测保留、未执行）。

### 复审确认的设计前提
- `--standalone` 实测可用（真跑 v2.0.30，事件流格式不变）。
- `Child` 所有权在 `spawn_event_reader` 读取线程内，`SessionManager` 只存 PID（taskkill /T /F 按树杀）。
- `SessionEndReason::Aborted` 已存在（`ai_event.rs:354`），协议复用无双端同步。
- **关键修正**：`kill_process` 成功后执行 `sessions.remove()`——`interrupted` 标记
  不能挂在 `SessionInfo` 上（EOF 线程将查不到），须用独立集合。

### T1 中断语义（会话级状态图）
```
interrupt(id)                       [调用线程，同步顺序]
  mark_interrupted(id)              # id + 真实 id + 全部别名 写入 interrupted_ids 集合
  kill_process(id)                  # taskkill /T /F → sessions.remove()

EOF 线程（spawn_event_reader 收尾）
  was_interrupted = is_interrupted(current_id) || is_interrupted(spawn_temp_id)
  clear_interrupted(...)            # 消费标记，防泄漏（正常结束后再点中断的脏残留由此兜住）
  ├─ true  → 只发 SessionEnd(Aborted)
  └─ false → 现有三分支（error / fall 或 text 完成 / fallback error）不变
```
- `continue_session` spawn 新进程前 `clear_interrupted`（第二轮正常对话）。
- `kill_process` 本身不标记（continue 内部清理语义 ≠ 用户中断）。

### T2 去 sleep（ExitSignal 机制）
```
start/continue_session              按会话初始 id 注册 Arc<ExitSignal>（Mutex<bool>+Condvar）
EOF 线程                            child.wait() 收割真实退出码 → signal(finished=true)
continue_session                    remove 信号 → bounded wait(2s)
  ├─ 拿到完成信号 → spawn 续接进程
  └─ 超时/无信号    → 明确报错，不 spawn
```
- 超时上限是「等真实退出」的兜底报错，非超时掩盖；正常结束后续接时信号已置位，wait 立即通过。
- 删除 `thread::sleep(100ms)`。

### T3 standalone + 顺带项
- `build_command` 加 `--standalone`（实测验证通过）。
- 修 `opencode.rs` 头部注释 step_finish 矛盾。
- `get_opencode_models_impl` 补 `CREATE_NO_WINDOW`。

### 验收
- 中断后 UI 无 error 误报；`cargo check`；`--no-default-features` 双 bin 通过；解析单测保留。

### 5.4 批次修订

- **批次 1（P0）**：需求 1 中断语义、需求 2 `Child::wait` 替代 `sleep(100ms)`、
  需求 3 直接加 `--standalone`、顺带修正 `opencode.rs` 头部注释矛盾。
- **批次 2（P1）**：需求 4 未知事件兜底；需求 5 落地 `--file` 临时文件方案 +
  发送前长度前置校验；需求 6 `is_available` 缓存；目标 2 顺带实测 `--file` 图片输入。
- **批次 3（P2）**：日志降级、模型列表 TTL 缓存 + 失败降级（Windows 侧补
  `CREATE_NO_WINDOW` 防闪黑框，发现于批次 1 复查 `get_opencode_models_impl`）、
  需求 9 env_keys 实测固化、`--thinking`/`--agent`/`--title` 能力位、
  `session export` 历史回填（规划为独立 spec）。

## Rev3（2026-10-17）：「Transport: The socket connection was closed unexpectedly」根因确认 + 错误文案映射

### 根因（进程树实测）

`opencode run` 是连接**共享后台服务**（`serve --service`）的客户端，
且**服务进程是 CLI 的子进程**（`Get-CimInstance Win32_Process` 实测确认）。
Polaris 中断会话 A 时 `taskkill /PID <A> /T /F` 会**连带杀掉共享服务**，
切断了同批连到该服务的并发会话 B 的 CLI↔服务 socket（Bun fetch），
B 即报 `Transport: The socket connection was closed unexpectedly...`。
日志旁证：`opencode.log` 中 `serve --service` 反复重启、
`session websocket connect failed`（connect-timeout）。
`--standalone` 落地后该连坐路径消失；残留概率为网络/provider 侧瞬态断连。

### 落地项（批次 1 追加，辅助优化）

- **错误文案映射**：`opencode.rs` 新增 `friendly_error_message`，
  在 `OpencodeEvent::Error` 推送前把已知 Bun/传输/认证类报错原文映射为
  友好中文（注明可重试），原始错误压缩为单行截 200 字符附带；
  未知文案原样透传，不吞 opencode 新版错误。单测 4 例。
- **瞬态重试**（未做，留批次 2 评估）：EOF「完全无产出」分支可重试一次，
  仅限无任何事件产出的会话，防部分输出重复。

### 实证验证（2026-10-17 复核，本机 opencode v2.0.30）

- **隔离性（测试 B，决定性）**：`Start-Process opencode.cmd run --standalone ...`
  建立 wrapper→CLI→`serve --stdio --port 0` 私有服务树；生成中途
  `taskkill /PID <wrapper> /T /F` 报告全树（含私有服务及其子进程 61384）终止。
  并发的旧会话 run ×2 与共享 `serve --service` 完全未受波及。
  击杀前后进程快照均在，未出现 Transport 报错泄漏。
- **事件流不变（测试 A）**：`run --standalone --format json` 输出
  `step_start → text`（「收到」，ses_eb871602fffe…），与解析器实测事实一致；
  进程退出后无 `serve --stdio` 残留进程。
- **wrapper 存活性**：Polaris 注册的 PID 为 cmd.exe wrapper；实测
  （9:47/9:50 两个会话）wrapper 与 CLI 同刻创建、子进程存活期间持续存活，
  PID 有效。「wrapper 早退 ⇒ taskkill 打在死 PID/PID 复用」降级为理论风险，
  列入批次 2 观察项（kill 后校验目标进程真实退出，替代对错误码 128 的成功翻译）。
- **遗留共享服务**：修复前二进制产生的孤儿 `serve --service`（PID 35404）仍在，
  仅服务旧版走共享路径的会话；重建/重启 Polaris 后失效进程可手工清杀。
  **`--standalone` 生效前提：重启 Polaris（dev/web 均需重新构建运行）。**


## Rev4（2026-10-17）：批次 2/3-速赢 实现 spec + MCP 桥接专项方案

> 本轮实测证据（v2.0.30 真跑，PowerShell/cmd 均确认）：
> 1. `run` 位置消息参数**必须存在**，空串/省略都报 "You must provide a message"；
>    使用 `--file <path>` 时位置参数可用 `"."` 占位，消息完整从文件送达（回复 OK 验证）。
> 2. 图片经 `--file` 挂载：无效 PNG 不报错但模型读不到内容 —— `image_input` 仍不能定论，
>    metadata 维持 `image_input=false`。
> 3. **step_finish 事实修正**：纯文本轮实测无 step_finish，但工具调用轮实测**有**
>    （reason=tool-calls、tokens 完整）。结论改为「按轮次可能出现/省略」，EOF 判定
>    不依赖它仍正确；批次 1 保留的 StepFinish 解析分支正当生效（还能白拿 Usage）。
> 4. 错误事件新增形态 `provider.no-route`（模型不可用）也走 stdout JSONL。
> 5. **MCP 桥接可行性实测通过**：工作目录放项目级 `opencode.json`（`"mcp": {"<name>":
>    {"type":"local","command":[...],"enabled":true}}`），run 会话内 MCP server 成功
>    注册并被模型调用（echo server 闭环 `ECHO:hello-polaris`）。

### 批次 2（P1）实现 spec

**R4-1 未知事件兜底（需求 4）**
```rust
enum OpencodeEvent { ..., #[serde(other)] Unknown }   // catch-all 变体
```
- serde 无法在 `other` 变体捕获 tag 值：type 名从原始行 JSON 提取 debug 记录。
- 解析完全失败（非 JSON 行）仍走 None + warn（语义不变）。
- EOF 诊断摘要增加 `unknown` 行计数，便于版本漂移排查。

**R4-2 长消息 `--file` 化 + 前置校验（需求 5）**
- 前置校验：`message.len() >= 6000` 字节即走文件路径（32K UTF-16 限制下留足
  escaping + 其余参数余量；6000*3=18K < 32K）。
- 落地：temp 目录写 `polaris-opencode-<uuid>.txt`（UTF-8）→ `run . --file <path>`；
  EOF 线程收尾 `remove_file` 清理；清理失败仅 debug（OS 会清 temp）。
- `build_command` 新增 `via_file` 分支；start/continue 共用；spawn 失败路径也清理。

**R4-3 `is_available` 缓存（需求 6）**
- 引擎字段 `cli_available: Mutex<Option<bool>>`（&self + interior mutability）。
- 首查执行 `get_cli_path()`，结果缓存；返回 false 让前端走 install_guide 引导。

### 批次 3-速赢 实现 spec

**R4-4 模型列表缓存 + 失败降级（需求 8）**
- `get_opencode_models_impl`：进程级 `Mutex<Option<(Instant, Vec<OpencodeModel>)>>`，
  TTL 300s 命中直接 clone；miss 执行 CLI，成功回写；
  **失败降级**：存在过期缓存则返回过期缓存（log warn），否则原错误上抛。

**R4-5 日志降级（需求 7）**
- stdout 逐行 `info` → `debug`；事件分支 info（step_start/text/tool_use/step_finish
  /error/EOF/子进程退出）全 `info` → `debug`（error 事件 warn 保留）；
  stderr 每行 `warn` → `debug`（fallback 摘要逻辑不变，warn/error 关键路径保留）。

### MCP 桥接专项方案（本轮只出方案，后续独立批次实施）

实测确认：**项目级 `opencode.json` 的 `mcp` 段是 opencode 的原生注入通道**（非
`opencode mcp add` 不污染全局；`--mcp-config` flag 不存在）。桥接设计：

```
start/continue_session（workspace = cwd）
  1. resolve_polaris_builtin_mcp_servers()   # 复用 mcp_config_service 现有能力
  2. 按会话过滤（ask/dispatch 依赖 --polaris-port/--polaris-token 动态参数）
  3. 写 <workspace>/.polaris/opencode.json   # fonts=不动用户自己的 opencode.json
     {"mcp": {"<server>": {"type":"local","command":[...args],"enabled":true}}}
  4. spawn opencode run（cwd=workspace）      # 项目级配置生效
  5. 会话结束不删（幂等重写；文件随 gitignore 建议）
```
- 关键差异 vs `opencode mcp add --global`：项目级配置目录隔离 dev/test 数据根，
  不写用户全局配置；server 参数含运行时 port/token，必须每会话重写（幂等覆盖）。
- 依赖决策点（留独立 spec 复审）：`.polaris/` 目录 workspace 路径约定、
  与用户已有项目 `opencode.json` 的合并策略（检测到已存在则跳过注入 + warn）、
  `polaris mcp` 命令需 `polaris-mcp` 可执行路径解析（参照 bin 注册表）。

### Rev4 实施记录（2026-10-17）

已实施（本节由实现时回写）：
- **R4-1**：`OpencodeEvent` 增加 `#[serde(other)] Unknown` 变体；解析处 debug 记录
  未知 type（serde 拿不到 tag 值，type 名从原始行 JSON 提取）+ `unknown` 计数
  进 EOF 摘要。单测 `parse_unknown_type_falls_back_to_unknown_variant`。
- **R4-2**：`MESSAGE_ARG_MAX_BYTES=6000` 前置校验；超过即写
  `%TEMP%/polaris-opencode-<uuid>.txt` 走 `run . --file <path>`（位置参数 "." 占位，
  实测消息完整送达）；EOF 收尾 `remove_file`，spawn 失败路径同样清理。
- **R4-3**：`cli_available: Mutex<Option<bool>>` 一次探测缓存；`is_available` 不再恒
  true，未安装返回 false 让前端走 install_guide 引导。
- **R4-4**：`get_opencode_models_impl` 进程级 `Mutex<Option<ModelsCache>>`，
  TTL 300s；实时拉取失败降级返回过期缓存（warn 标注 age），无缓存才上抛。
- **R4-5**：stdout 逐行 + 事件分支 info → debug；stderr 每行 warn → debug。
  **偏离 spec 说明**：EOF 汇总与 is_available 探测结果保留 info——每轮次仅一次、
  是「应用内无回复」问题的诊断锚点，spec 原文写为 debug 属措辞过度。
- 新增单测：`parse_unknown_type_falls_back_to_unknown_variant`、
  `message_threshold_splits_arg_and_file_routes`（**cargo test --lib 本机不可用，
  仅编译验证通过，未实际执行**）。

验证：`cargo check` / `--no-default-features` 双 bin / `--tests` / `cargo clippy --lib`
全部 EXIT=0；clippy 对改动文件无新增 warning（存量 6 个 never-read 字段为基线遗留）。

仍未做（后续批次）：需求 9 env_keys 实测固化（需真实 key 联通测试）、
`--thinking`/`--agent`/`--title` 能力位、`session export` 历史回填、
EOF 无产出瞬态重试（b9ffe1a2 Rev3 遗留）、MCP 桥接（Rev4 专项方案，方案已备、
实施需先定 `.polaris/` 目录约定与用户项目配置合并策略）。

## Rev3.2（2026-10-17）：修复后 dev 后端真实运行时端到端实证

> 驱动方式：dev 后端（target\debug\polaris.exe，9:57 启动，含 c03fa674 修复）经
> HTTP `/api/router-dispatch-stream` → `cap.ai.chat` 流式 `action=start`
> （engineId=opencode, model=glm-5.3-flash-free, workDir=真实工作区）发起真实会话，
> 与 UI 聊天同链路。鉴权/契约/API 形态详见本节末「驱动杂记」。

### 结果（全部通过）

1. **spawn 命令行含 `--standalone`（后端日志直接证据）**：
   `[OpencodeEngine] 执行命令: ...npm\opencode.cmd run ... --auto --standalone`；
   进程树实测：run 客户端的子进程是**私有** `serve --stdio --port 0`，
   不再连接共享 `serve --service`。
2. **事件流正常（自然完成会话）**：12 事件、unknown=0、finish=true text=true
   error=false、子进程退出 code=0、was_interrupted=false。`--standalone` 不影响
   stdout JSONL 事件协议。
3. **中断隔离（生成中途 `taskkill /PID <wrapper> /T /F`，与 `kill_process` 同语义）**：
   wrapper→run→私有 serve 全树终止；**无关进程零波及**（孤儿共享服务与另一
   活动会话均存活）。Polaris 侧记录 EOF（10 事件，外部击杀故 was_interrupted=false，
   语义符合预期——T1 中断语义已在 c03fa674 提交与单测覆盖）。
4. **遗留清理**：孤儿共享服务 PID 35404 已消失（自亡或手工清杀）；修复前二进制
   拉起的旧 run 客户端（无 `--standalone`）已自行退出。

### 现场观察（生产二进制仍为修复前）

验证期间用户生产版 `D:\app\polaris\polaris.exe`（PID 57004，9:11 启动，**修复前
二进制**）正拉起 2 个并发 opencode 会话，共享一个 `serve --service`——修复前风险
形态在真实使用中出现。**生产版需更新二进制后 `--standalone` 才生效**；此前的连坐
Transport 报错在生产二进制上仍会复现，属预期。

### 驱动杂记（复现入口，供后续回归使用）

- dev 后端 HTTP 鉴权：Bearer MD5(`config.web.token`)（Polaris-dev token 见
  `%APPDATA%\Polaris-dev\config.json`）；`/api/health` 无鉴权可用。
- 流式会话入口：`POST /api/router-dispatch-stream`，body 需 `req` 包裹层：
  `{"req":{"target":"cap.ai.chat","payload":{"action":"start","message":"…",
  "options":{"engineId":"opencode","model":"…","workDir":"…"}}}}`。
- 派发（dispatch）链路**发现独立缺陷（与齿箱1/2修复无关，单列）**：
  `dispatchTaskService.handleDispatchTaskRequest` 用同步 `aiChatDispatch`
  （`router_dispatch`）承载 start 动作 → `cap.ai.chat` 同步分支报
  「cap.ai.chat 不支持同步动作」→ 静默派发会话秒失败（对任何引擎）。
  start 应走 `aiChatDispatchStream`（`router_dispatch_stream`）。
  已在 dispatch_tasks.json 留痕，归入派发链路独立修复项。
- 另：`/api/dispatch-create-task` 命令路径注册任务但**不 emit** `dispatch-task-request`
  （设计如此：调用方自执行），外部驱动请用 ask_listener MCP dispatch 帧（
  端口/token 见 `%APPDATA%\<dataRoot>\.meta\ask-listener.json`，帧格式
  4 字节 LE 长度 + JSON）。

## Rev5（2026-10-17）：MCP 桥接实施（R5 批次）

### 实验证据（裁定 Rev4 遗留 3 决策点）

1. **`OPENCODE_CONFIG` env 不被 v2.0.30 认可**：环境变量指向含 `mcp` 段的配置后
   `opencode mcp list` 仍返回 "No MCP servers configured"（cwd 内外各测一次）。
2. **`opencode mcp add` 写 `<cwd>\opencode.json`（项目级）**：add 后文件出现在
   cwd；全局目录 `%USERPROFILE%\.config\opencode\` 当时无任何配置文件。
3. 决策点裁定：
   - `.polaris/` 嵌套目录约定【否决】：opencode 只认 cwd 根 `opencode.json`，
     嵌套目录配置不生效 → 注入文件直接写 `<workspace>\opencode.json`。
   - 与用户已有 opencode.json 的合并策略【裁定=跳过】：v1 不解析不合并（JSONC
     兼容未知 + 崩溃残留覆盖用户文件语义风险不可接受），检测到已存在 → warn
     + 本会话无 Polaris MCP 工具（引擎侧可观测）。
   - polaris-mcp 可执行路径解析【复用现状】：`ResolvedExternalMcpServer.command`
     即解析后的绝对 exe 路径，args 已含逐会话动态 `--polaris-port/--polaris-token`
     （launcher 上游按 aiToolAccess 过滤，无重复解析需求）。
4. **注入通道是 cwd 根文件 ⇒ Rev4 的「会话结束不删、幂等重写」策略废弃**：
   该策略本意配合全局/`.polaris/` 隔离；现文件直接落在用户工作区，必须
   会话 EOF 删除恢复原状。崩溃残留无破坏性（只向 cwd 内的 opencode 用户
   多暴露 Polaris 内置 MCP 工具，手删即恢复）。

### 实施记录

- `SessionFileCleanup`（新枚举）：会话期注入文件统一收尾抽象，R4-2 长消息
  临时文件与 R5 MCP 桥接文件共用；EOF 线程统一 `apply()`，spawn/build
  失败路径显式清理（防早退泄漏）。
- `build_opencode_mcp_config(&[ResolvedExternalMcpServer]) -> serde_json::Value`
  纯函数：`{"$schema": ".../config.json", "mcp": {<name>: {"type":"local",
  "command":[<cmd>, ...args], "enabled": true}}}`（形状经 clean-room 实验闭环：
  echo stdio server 注册成功且被 GLM 模型调用）。
- `write_mcp_bridge_config(workspace_dir, servers) -> Option<SessionFileCleanup>`：
  无 server / 已有 opencode.json / 序列化或写入失败 → None（跳过注入）。
- `spawn_event_reader` 签名 `msg_file: Option<PathBuf>` →
  `cleanup_files: Vec<SessionFileCleanup>`。
- `launcher.rs` OpenCode 分支：由「不注入（使用自带工具）」改为注入
  `opts.mcp_servers`（引擎内桥接），沿用上游 aiToolAccess 过滤结果。
- 新增单测 5 个：config 形状 ×2、写入+EOF 删除恢复 ×1、已有配置跳过且
  不改用户文件 ×1、无 server 不落盘 ×1。

### 验证（如实：测试运行受限）

- `cargo check` EXIT=0；`cargo check --no-default-features --bin polaris-web
  --bin polaris-mcp` EXIT=0（命令门控双方向）；`cargo clippy --lib` EXIT=0，
  改动文件零新增 warning。
- 单测**编译**通过（lib 测试 exe 链接完成），但**运行受阻于本机已知 DLL
  限制**（`cargo test --lib` → `STATUS_ENTRYPOINT_NOT_FOUND`，测试 exe 加载
  即挂；与历史记录一致，非本批改动引入）。5 个新单测未在真实 runtime 执行。
- 生产级端到端（dev 后端注入真实 Polaris 内置 server 的 opencode 会话调用
  MCP 工具闭环）**未做**：当前效果背书 = clean-room echo 实验闭环 +
  opencode mcp add 对同一文件形状的认可。

### 已知边界

- 工作区已有 opencode.json → MCP 注入不生效（v1 策略），合并策略留后续批次。
- Polaris 崩溃可能残留 `<workspace>\opencode.json`（语义无破坏性）。
- 仍未做（沿用 Rev4 清单）：env_keys 实测固化（需真实 key）、`--thinking`/
  `--agent`/`--title` 能力位、`session export` 历史回填、EOF 无产出瞬态重试、
  已有配置合并策略。
