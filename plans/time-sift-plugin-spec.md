# 拾光机（time-sift）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> 一句话：把 Polaris 已经拥有但从未被开采的资产——历史 AI 会话——变成可检索、可问答、可视化的个人记忆库。

## 1. 目标与动机

用户在 Polaris（dialogs JSONL 579 个）、session-v2（messages.db 63 个活跃会话）、Claude Code 原生（~/.claude/projects 214 个 / 452MB）、ZCode（~/.zcode 187 个 / 215MB）里积累了 **约 1000 个 AI 会话**。宿主只有：右侧滑出面板的关键词搜索（FTS5，仅列表）+ 设置页 token 统计（代理请求口径）。缺口：

1. **AI 无法检索用户历史**——cap.history 无 search 动作，AI 想回忆只能遍历逐个读。
2. **无任何足迹可视化**（热力图/年度统计）。
3. 已交付 20 个插件无一做"自有数据反哺"，本插件是第一个零冷启动插件：**装上即有全部历史价值**。

与记忆熔炉（主动制卡）互补：拾光机 = 被动全量记忆。

## 2. 数据源（全部只读，v0.1.0 四路）

| source | 位置 | 格式 | 归一化要点 |
|---|---|---|---|
| `polaris` | `<dataRoot>/dialogs/*.jsonl` | v3：首行 meta，后续 `{type:'msg',message:{id,type,content/blocks}}` | 按 message.id 去重；tokenUsage 直取 |
| `v2` | `<dataRoot>/session-v2/messages.db` + `state.db` | session_messages（content JSON blocks，version 去重）+ sessions_index（标题） | 排除 tombstoned；最新 version 胜 |
| `claude` | `~/.claude/projects/*/*.jsonl` | Claude Code JSONL | 只取 user/assistant 的 text 块；跳过 isSidechain/tool_use/tool_result |
| `zcode` | `~/.zcode/cli/db/db.sqlite` | session 表 + message/part 表（data JSON） | 只取 type:'text' part；跳 uiVisibility:hidden；tokens 取 turn_usage 聚合 |

索引口径：**只索引散文**（用户输入 + AI 回复文本），跳过工具调用/输出/reasoning——记忆价值在对话不在工具 I/O，体积降一个量级。

## 3. 架构（三方一库 + 本地索引）

```
面板（React bundle，宿主 invoke 通道；绝不直接 fetch）
  └─ cap.kv sift.* 键空间 ←→ service/sift.js（唯一读源/唯一写者）
        ├─ JSONL 源：30s stat 增量（mtime 触发重解析）
        ├─ SQLite 源：每 10min 全量拉取 diff
        ├─ 索引缓存：<appConfigDir>/time-sift/（catalog.json + blobs/<sid>.txt + postings.json）
        └─ node:sqlite 只读打开（≥22.5；缺失则降级仅 JSONL 源，meta 注明）
MCP server（stdio；sift_* 工具；timeline/stats 直读 kv，search/open 走命令信箱）
```

- **零外网请求、零跨域面**：本插件是纯本地数据插件，数据面走 cap.kv（跨端），源读取下沉服务进程 node fs/sqlite（面板无 fs）。
- **单写者**：catalog/stats/meta/结果键只有服务写；面板/MCP 写 settings 与 cmd 命令键（先删后做）。

## 4. 键空间契约（权威，三方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `sift.settings` | 面板/MCP 写，服务 30s 热读 | `{sources:{polaris,v2,claude,zcode}, excludeKeywords[], maxMsgChars, sqliteRefreshMin}` |
| `sift.meta` | 服务（60s 心跳） | version/pid/bridge/degraded/indexing 进度/catalog 概况/各源状态 |
| `sift.cat.head` | 服务 | `{count, chunks, rev, builtAt}` |
| `sift.cat.<n>` | 服务 | 目录分块（≤200 条/块）：sid/source/title/engineId/workspace/createdAt/updatedAt/msgCount/proseChars/tokens?/costUsd? |
| `sift.stats.total` | 服务 | 总计卡：sessions/messages/proseChars/activeDays/firstDay/lastDay/bySource/tokens 覆盖口径 |
| `sift.stats.daily` | 服务 | 按天聚合（本地时区）：`{'YYYY-MM-DD': {s,m}}` |
| `sift.cmd.search/open/reindex.<nonce>` | 面板/MCP 写 → 服务先删后做 | 命令信箱 |
| `sift.result.<nonce>` | 服务写，请求方读后删 | `{ok, data|error, at}`；服务 tick 顺带清 >1h 孤儿 |
| `sift.smoke.*` | 仅冒烟 | 冒烟测试独立子前缀，100% 清理 |

sid 规则：`<源字母>+sha256(稳定键)前10位`（polaris=externalId、v2=conversation_id、claude=sessionId、zcode=session.id）。

## 5. 检索设计

- 分词：CJK 连续段切双元（bigram，单字成段则单字）+ 拉丁/数字段（小写，≥2 字符）。
- 倒排：term → sid[]（上限 512，超出晋级 commonTerms 不再过滤）；查询 term 命中 common 则放弃该约束（文本扫描兜底）。
- 流程：terms 求交 → 候选按（标题命中+3、新近加分）排序取前 ~120 → 逐个读 blob 验证并计数 → 按命中数×覆盖×新近排序出 topN（默认 12，上限 30），附 ±160 字符片段（面板端高亮）。
- open：按 sid 读 blob 消息窗口（around=命中消息序号 / offset 分页），单消息截断（MCP 1200 字符 / 面板 2500），总字节上限防 kv 256KB。

## 6. 面板（四 Tab）与 MCP 工具

- **搜索**：关键词+源筛选+时间范围 → 命中片段列表 → 点击进阅读器（命中上下文）。
- **足迹**：总卡（会话/消息/散文/活跃天）+ GitHub 风格 26 周热力图（内联 SVG，零依赖）+ 源分布 + Top 活跃日。
- **时光机**：按天分组的会话列表（目录分页、筛选）→ 阅读器。
- **设置**：服务状态卡（自举 start 三步）+ 索引概况/重建 + 源开关 + 排除词 + 隐私说明（数据不出设备）。

MCP 工具 5 个（中文 description 写适用句式）：`sift_search`（「我之前是不是解决过…」）、`sift_open_session`、`sift_timeline`（「上周三我干了啥」）、`sift_stats`、`sift_reindex`（confirm 护栏）。

## 7. 验收（三层全绿 + 如实报告）

1. 离线单测 `node test/run-tests.mjs`：分词/倒排增删/片段/四源解析/聚合/版本去重。
2. 构建 `npm run typecheck && npm run build`。
3. 真实桥冒烟 `node test/smoke-real.mjs`：护栏（已有 sift.* 业务键拒跑）→ 起真服务 → 写 mock 会话文件进临时源目录（冒烟专用 settings 指向临时目录，不碰真实数据根）→ 验证索引/检索/信箱闭环 → MCP stdio initialize→tools/list→tools/call → 自清理。
4. 打包：`node scripts/pack.js plugins/time-sift` → sha 写回 index.json（先重读现文件）→ update.json 同步 → `node scripts/validate.js`。

## 8. 已知边界（如实）

- SQLite 源需 node ≥22.5（node:sqlite）；不可用时自动降级为 JSONL 双源并在 meta 注明。
- 只扫实例 0（`<root>/dialogs`），instances/n 不扫；session-v2 只读最新 version，历史版本不入索引。
- claude 源跳过 sidechain；zcode 源跳过 reasoning part（体积与隐私考虑）。
- tokens 只在源里有时才统计（polaris meta / zcode turn_usage / claude usage 行），UI 标注覆盖口径，不臆造。
- 双 Polaris 实例并发会各建索引（罕见场景，README 记录，未做租约）。
