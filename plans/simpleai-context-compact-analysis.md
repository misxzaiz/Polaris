# SimpleAI 上下文压缩机制调研与优化分析

> 状态：**调研完成（含对抗分析），暂不实施**
> 创建：2026-10-18（2026-10-18 追加实测验证章节）
> 范围：`src-tauri/src/ai/engine/simple_ai/compact.rs` + `chat_loop.rs` + `history.rs`
> 结论一句话：压缩链路设计健壮（触发/选区/分段/回滚均合理），但存在 **1 个真实失效场景**（无 usage 兜底的字符估算在中文会话彻底失准，可能压不爆）与若干卫生问题（检查点不清理、两套检查点格式并存、路径双源、死代码）。

---

## 一、机制全景（已核实）

SimpleAI 的上下文压缩是 **Polaris 自研**（非 CLI 内置 `/compact`），核心在后端，前端只有 Progress 提示。

### 触发（chat_loop.rs:200）
- 指标：最近一轮请求的 `usage.input_tokens`（≈ 当前上下文大小）达窗口 **75%**（`COMPACT_THRESHOLD`）；不用跨轮累计值
- 无 usage 兜底：消息字符数 ÷ 4 估算 token（`CHARS_PER_TOKEN`）
- 窗口优先级：`ModelProfile.context_window` > 模型名后缀（`[1m]`→1M 等）> env `SIMPLE_AI_CONTEXT_WINDOW` > 默认 **200K**
- 熔断：压缩后一轮仍超阈 → 本 turn 不再压缩（`compact_exhausted`）

### 选区（compact.rs `select_compact_range`）
- 压缩 `[1, len-keep_recent)`：system 永不入摘要；尾部保留 **6** 条（`SIMPLE_AI_COMPACT_KEEP_RECENT` 可覆盖，最小 1）
- 边界按工具配对对齐（OpenAI 协议硬约束，切断 `assistant(tool_calls)`/`tool` 配对会 400）
- 区间 < 4 条 → 跳过

### 摘要（`summarize_range_rolling`）
- 待压区间 ≤ 窗口 50%（`SEGMENT_INPUT_BUDGET_RATIO`）→ 单次非流式摘要请求
- 超预算 → 滚动分段：只在 user 边界切段（保配对），最多 12 段（`MAX_SEGMENTS`），逐段「已有摘要 + 新片段」合并
- 输出预算 2048 token；截断（finish=length 且仅 reasoning 字段）→ 4096 + 抑制思考指令重试一次
- 序列化：tool 结果保头保尾截断（头 60% + 尾 40%，总上限 1000 字符）
- 请求重试 2 次 / 500ms 基数 / 60s 超时

### 替换与归档（`compact_history`）
- 压缩区间替换为单条 `[compacted summary]\n<摘要>` user 消息；`usage_acc.reset_last()` 天然一轮冷却
- 压缩前完整快照写 `<DataRoot>/simple-ai/context-checkpoints/<session_id>/<timestamp>.json`（`write_compact_checkpoint`）
- 非破坏：摘要为空或失败 → 自动回滚恢复原消息（`fallback_drop_oldest` 真删已降级为兜底，当前不会走）

### 历史预裁剪（history.rs，压缩之外的第二道防线）
- 每轮请求前对超长 assistant 文本输出逐条截断（4000 token/条），零 API 调用
- 只截断不删消息（保 user/assistant 严格交替 + tool 配对），`sanitize_tool_pairs` 清洗尾部孤儿配对

---

## 二、对抗分析结论（已实测/已核实）

### 实测数据（本机 2026-10-18）
```
%APPDATA%\Polaris\simple-ai       85 文件 / 12M
%APPDATA%\Polaris-dev\simple-ai  197 文件 / 5.4M
```
两数据根合计 ~282 文件 / 17MB（含 sessions/ 会话存档 + context-checkpoints/ 压缩检查点）。
**结论：磁盘占用当前无危机，但"只写不清理"的无限增长真实存在**（单次超长 agentic 会话的检查点 JSON 可达 2-5MB）。

### 逐条对抗（原优化清单 → 修正后）

| # | 原建议 | 对抗结论 | 修正级别 |
|---|---|---|---|
| 1 | P0 检查点清理（磁盘膨胀） | 实测 17MB 无危机，但无限增长真实；清理应在**写入路径**做（写前扫描总量超限删最旧），非启动时扫盘 | **P2** |
| 2 | P1 `latest_checkpoint_path` 死代码 | 全仓唯一引用是自身测试；**删不如让清理逻辑复用**（LRU 定位最旧/最新正好用它），一举两得 | **P2** |
| 3 | P2 路径硬编码违反 DataRoot 单点 | `compact.rs` 从 `custom_env`/进程 env 读 `POLARIS_DATA_ROOT` 是**有意的双源兼容**：SimpleAI 可能跑在 MCP 独立进程，`data_root()`（OnceLock 单例）未初始化会 panic（`unified_requirement_repository.rs:84` 同款注释为证）。但同模块 `store.rs` 却用 `data_root()`，**同一模块两种取法本身不一致**。低风险改法：保留 env 优先 + `data_root()` 兜底，删掉 `custom_env["POLARIS_DATA_ROOT"]` 非标准键来源 | **P2** |
| 4 | P2 `CHARS_PER_TOKEN=4` 低估中文 | **不能全局改**！同一常数两个场景**方向相反**：history.rs 截断场景低估 = 更早截断 = 更保守（对）；compact.rs 触发场景低估 = 触发偏晚（错）。真正问题不是"4 不准"，而是**同一常数复用两个方向相反的语义** | **P2（最值得做）** |
| 5 | P2 分段预算提到 0.75 窗口 | **原建议错误**。0.5 窗口分段比 0.75 更安全：分段目的是「压缩请求自身不 400」，50% 远低于 75% 触发线留足余量。算术验证：触发时 last_input≈0.75 窗口，待压区间/0.5 窗口 ≈ 1.5 → 极端只需 2 段，12 段上限几乎永不触达（是冗余保护，合理） | **撤销** |
| 6 | P2 keep_recent 加前端 UI | 加 UI 需动 ModelProviderTab + 类型 + i18n + 测试（4 处联动），参数几乎无人调，不值。值得做的是**按 token 动态保留**（保留区目标"最近 1-2 组工具交互"，6 条是条数近似） | 改动态化（P2） |
| 7 | P1 压缩发 `context_compacted` 事件 | **收益被高估**：前端 `appendContextCompactBlock` 需要 preTokens/postTokens，SimpleAI 的 last_input 是近似、postTokens 只能估算 → 显示"省了 50k token"是**假精确**，比不发更误导。要么不发（现状可接受），要么只发条数不发 token | **降 P3** |
| 8 | P3 摘要代际标识 | 收益最低，不影响任何功能，仅排查辅助 | **保留 P3，可不做** |

---

## 三、修正后值得做的前三名

1. **压缩触发时机修正**（唯一有真实行为影响的项）
   - 中文会话压缩触发偏晚（75% 触发时实际可能已 90%+）→ 压缩请求自身有 400 风险
   - 与 history.rs 保守截断方向冲突，是**设计层面不自洽**
   - 改法：压缩触发侧 CJK 加权（~1.5-2 字符/token）或更依赖真实 usage，**不动 history.rs 的保守常数**

2. **检查点写入路径 LRU**（一次改两个卫生问题）
   - 写前扫描 `context-checkpoints/<session_id>/`，超每会话 N 个或全局总量上限时删最旧
   - 顺手让死代码 `latest_checkpoint_path` 被复用（激活）

3. **`data_root()` 接入（低风险改法）**
   - 保留 env 优先 + `data_root()` 兜底；移除 `custom_env["POLARIS_DATA_ROOT"]` 键
   - 消除同模块双源歧义，守住 AGENTS.md §3.3 红线

---

## 四、关键代码锚点

| 位置 | 说明 |
|---|---|
| `src-tauri/src/ai/engine/simple_ai/compact.rs:38` | `DEFAULT_CONTEXT_WINDOW = 200_000` |
| `compact.rs:58` | `CHARS_PER_TOKEN = 4`（与 history.rs 同常数、反向语义） |
| `compact.rs:145` | `select_compact_range`（选区 + 配对对齐） |
| `compact.rs:350` | `summarize_range_rolling`（滚动分段） |
| `compact.rs:566` | `compact_history`（替换 + 检查点 + 回滚） |
| `compact.rs:684` | `write_compact_checkpoint`（只写不清理） |
| `compact.rs:734` | `latest_checkpoint_path`（死代码） |
| `compact.rs:612-618` | env 手工取 DataRoot（双源） |
| `chat_loop.rs:152-162` | context_window 优先级推导 |
| `chat_loop.rs:200-223` | 压缩触发 + 熔断 |
| `history.rs:16-21` | `approx_token_count`（保守截断，勿改） |

---

## 五、注意事项（留给实施者）

- 改 `data_root()` 接入**必须带初始化探测/兜底**，否则 MCP 独立进程场景可能引入 panic 回归
- 压缩触发估算若加 CJK 加权，**不要��� `history.rs`**——那是保守截断，方向相反
- 检查点 LRU 清理与 `store.rs` 的 `sessions/` 存档是两回事，别混删
- SimpleAI 不发 `context_compacted` 事件是**有意现状**（无真实 postTokens），接入前先想清楚 token 数字的真实性
- 前端 `ContextMeter.tsx:39` 已区分 simple-ai/claude-code 有运行时压缩，文案不需要动

---

## 六、实测验证（2026-10-18）

### 6.1 本机 lib 测试不可跑（与 AGENTS.md 一致）
`cargo test --lib ai::engine::simple_ai::compact` → `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139），
Tauri DLL 启动限制。验证方式只能是 `cargo check` 编译通过 + 磁盘/算术实测。

### 6.2 检查点实测：规模远小于预期，但发现两套格式并存
```
%APPDATA%\Polaris\simple-ai\context-checkpoints\d4ee08ce-...\  （2026-07，旧格式）
  checkpoint-0001.jsonl  85KB
  checkpoint-0002.jsonl  85KB
  manifest.json          362B（latestGeneration:2 + checksum 索引）
%APPDATA%\Polaris-dev\simple-ai\context-checkpoints\simple-ai-1791707357756-120\  （2026-10-11，当前格式）
  1791707448766.json     23KB（archived_count:20）
```
- **当前每会话仅 1-2 个文件、23-85KB**——"无限增长"的担忧被实测大幅削弱（P2 而非 P0 实锤）
- **发现旧写入者已删除**：jsonl+manifest 含 `generation`/`stableConversationId`/`bootstrapEnd`/
  `recentTailStart`/`briefing`/`checksum` 字段，Rust 侧与前端已无任何写入者；
  git 历史 `fdc69b23 Revert "批量更新：AI引擎、前端、后端服务及新文件"` 佐证是**已回滚的旧代机制遗留**，
  磁盘上 7 月的文件至今无人清理 → **佐证"检查点无清理逻辑"论断成立**，且遗留了死格式
- 旧格式内容更丰富（含 modelProfileId/model/wireProtocol/bootstrapEnd），若未来做"压缩回查"可参考

### 6.3 CJK 估算偏差：从"触发偏晚"修正为"兜底路径彻底失准"
实测量级（脚本验证，`CHARS_PER_TOKEN=4`）：
```
中文 1110 字符：估算 277 token，实际参考 ~740 token（1.5字/token）→ 低估 267%
英文 3960 字符：估算 990 token，实际参考 ~990 token（4字/token）→ 基本准确
触发推算（窗口 200K，估算 150K=75% 触发时）：
  纯中文会话实际已达 ~400K token = 200% 窗口
```
- **主路径无此问题**：`usage_acc.add(usage.input_tokens)` 用的是流末真实 usage
  （chat_loop.rs:475），不受字符估算影响
- **兜底路径真实存在且会走到**：`finish_usage()` 依赖上游返回 usage 包
  （OpenAI 需 `stream_options.include_usage`，Anthropic 分两次累积，Responses 从
  `response.completed` 取）；**上游不报 usage / 流中断 / 超时提前退出时 `last_input` 保持 0**
  → 走 `estimate_tokens` 字符估算兜底 → 纯中文会话**永远压不爆**（估算永远到不了 75%）
- 修正记忆文档第 4 条：不是"触发偏晚"，是**兜底路径在中文场景彻底失效**。
  修复方向不变（CJK 加权或更依赖真实 usage），但严重度从 P2 提到 **P1**

### 6.4 分段算术验证：0.5 窗口 → 理论 2 段，撤销 0.75 建议成立
```
触发时待压区间 ≈ 0.75W；每段预算 = 0.5W → 理论段数 = ceil(0.75/0.5) = 2
serialize 截断（tool 结果 100K 字符 → 1000 字符）使实际输入远小于估算 → 段数只会更少
结论：12 段上限（MAX_SEGMENTS）是冗余保护，几乎永不触达；0.5 分段比 0.75 更安全
  （每段 50% 窗口远低于 75% 触发线，压缩请求自身不 400）
```

### 6.5 验证对结论的影响
| 论断 | 验证前 | 验证后 |
|---|---|---|
| 检查点无限增长 | P0 | **P2**（实测 23-85KB/会话；真问题是无清理机制 + 死格式遗留） |
| 中文估算失准 | P2 触发偏晚 | **P1 兜底路径彻底失效**（纯中文会话压不爆） |
| 分段预算 0.5 vs 0.75 | 撤销 0.75 | 确认 0.5 正确（理论 2 段） |
| lib 测试可跑 | 未验证 | **不可跑**（Tauri DLL 限制，与 AGENTS.md 一致） |
