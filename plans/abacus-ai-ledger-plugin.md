# 算盘 abacus —— AI 花销账房插件 spec

> 状态：已实施于插件仓（13e896d + 8521edf，含并行会话补的服务级集成测试）。键空间契约权威在插件仓 `plugins/abacus/README.md`。实测（2026-10-28，真实桥冒烟）：50,249 条台账 / $290.96 累计成本 / 缓存节省 $713.20 / 656 次限流全部浮出。

## 目标与定位

把散落在三路本地数据里的 AI 用量算成一本账：**花了多少（token/钱）、花在哪（模型/项目/agent）、缓存帮你省了多少、哪里在漏钱（限流/重试/缓存未命中）**。

- 数据源（全部只读，沿用拾光机四源范式砍到三源）：
  1. **zcode**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage`（逐模型请求：provider/model/agent/mode/TTFT/duration/错误/重试/缓存 token）+ `turn_usage`（轮级重试放大）+ `session`（标题/目录）+ `tool_usage`（工具遥测）。实测 8402 请求 / 186 会话 / 10292 工具调用。
  2. **claude**：`~/.claude/projects/**/*.jsonl` 逐 assistant 消息 `usage`（含子 agent 侧链——对成本账**必须**计入，与拾光机索引口径相反并留注释）。实测 214 文件。
  3. **polaris**：`<dataRoot>/dialogs/*.jsonl` 首行 meta `tokenUsage`（146/391 文件有，含宿主算好的 `costUsd`，作为该源权威成本）。已知边界：session-v2 存储无 usage、simple-ai 新会话 meta 无 tokenUsage——插件如实显示 0，不掩盖；主仓补落盘是后续工作项。

## 口径地图（计价引擎的根，实测定案）

| 源 | input_tokens 语义 | 全价输入 = |
|---|---|---|
| zcode model_usage | **含** cacheRead+cacheWrite（73451−70464=2987 实证） | input − cacheRead − cacheWrite |
| claude JSONL | 不含（Anthropic 惯例） | input |
| polaris tokenUsage | 不含（ai_event.rs「未命中缓存的输入 token（全价）」） | input |

- 成本 = 全价输入×in + cacheRead×cacheRead价 + cacheWrite×cacheWrite价 + output×out（USD / Mtok）。
- **缓存节省** = Σ cacheRead×(in − cacheRead价)/1e6——你 98% 缓存命中率的真实价值第一次可见。
- 未计价模型只记 token，成本=null，不编数。

## 架构（沿用仓内已验证范式）

- `service/abacus.js`：type=http 服务（`/__health`），2s tick。启动全量扫（yield 纪律），5min 增量（zcode SQL 游标 / claude mtime 缓存 / polaris 首行 meta）；60s 心跳写 `abacus.meta`；30s 热读 settings/prices。**写入权威**：聚合面（summary/daily/models/projects/quality/sessions/meta）只由服务写；价目/设置只由面板（及 MCP 显式工具）写。
- 缓存：归一化台账条目落 `<appConfigDir>/abacus/cache/entries.jsonl`（去重键 src+rowKey，>120 天滚动丢弃），聚合每次全量重算（万行级，快）。
- **价目**：`abacus.prices` USD/Mtok 内置常见预设（可改可补）；显示价 = fxRate（默认 7.2，可改）折算。可选「LiteLLM 价目同步」：服务进程 fetch raw.githubusercontent.com 已知 URL（https + 公网 SSRF 守卫，与 amber 同款），面板/信箱触发。
- MCP（stdio，零依赖）：abacus_summary / abacus_models / abacus_projects / abacus_quality / abacus_sessions / abacus_prices / abacus_price_set 共 7 工具，全部只读 kv（除 price_set 显式写）。
- 面板：esbuild ESM（external react），5 Tab（总览/模型/项目/质量/设置），可见时轮询读 kv；rescan/同步走信箱（`abacus.cmd.<n>` → `abacus.result.<n>`）。
- 跨域铁律：默认**零外网**；唯一外网点是价目同步，且只在服务进程、只指已知 URL。

## 关键设计决定

1. **漏钱面板（质量透视）**：限流/错误分类计数、重试放大系数（model_usage 请求数 / turn_usage 轮数）、TTFT P50/P90、缓存疑似失效会话（cacheRead 占比 <20% 且输入 >100k）、未计价 token。
2. **项目归因**：zcode 用 session.directory、claude 用 cwd、polaris 用 workspacePath 的 basename；天键用本地时区。
3. **claude 子 agent 侧链计入成本**（isSidechain 行不丢，标 agent=claude-subagent）——成本账与记忆索引的口径差异在代码注释里写死。
4. **kv 体积纪律**：各聚合键 ≤ ~100KB（daily 120 天、projects 60、sessions 30），超限截断并标记 truncated。
5. **冒烟钩子**：env `ABACUS_SMOKE_ROOT` 把三源定位限制到测试目录（仅测试用），真实冒烟走真库断言三源出数。

## 验收

- `node scripts/validate.js` 绿；面板 esbuild + tsc 通过。
- 离线单测（口径归一/计价/聚合/claude 行解析/信箱协议）全绿。
- 真实桥冒烟：服务 port=0 独立跑连真库，断言 zcode+claude+polaris 三源出数、聚合>0、缓存节省>0（本机缓存命中 ~98%），跑完自清理测试键。
- 索引发布：pack + index.json（重读现文件、只新增本插件一行）。

## 提交

- 插件仓：`abacus 算盘 AI 花销账房 v0.1.0`（13e896d feat + 8521edf fix：同 k 后到者胜语义 + 并行会话集成测试收敛，zip sha256 31bb35e6…）。
- 本 spec 提交行：docs(plans): 算盘 abacus AI 花销账房插件 spec（已实施于插件仓）。
