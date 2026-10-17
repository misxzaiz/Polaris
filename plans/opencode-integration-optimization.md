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
