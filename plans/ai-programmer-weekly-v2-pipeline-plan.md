# 方案：AI 程序员一周新闻 · 周报管线（v2）

> 日期：2026-10-18
> 关系：本方案是 `ai-programmer-weekly-spec.md`（v1，交互式 HTML 周报，**视觉层**）的上游管线规划。
> v1 回答「周报长什么样」；v2 回答「周报怎么持续、自动地产出来」。
> 状态：**规划中**，均未实现（今天_two_mcp 工具与 polaris-scheduler 均可用，可先行 M1）。

## 目标

把「收集一周 AI 程序员新闻」从一次性对话任务，升级为 Polaris 内的可持续管线：

**采集（确定性）→ 汇总（AI 会话）→ 产物（交互式周报 + 归档）→ 触达（会话 + 通知）**

## 现状盘点（调研结论 2026-10-18）

| 底座 | 现状 | 结论 |
|---|---|---|
| scheduler | 功能完整，任务存 `<DataRoot>/stores/scheduler.db`；`TaskCategory` 已有 `'news'`；`executorType` 支持 `chat/command/http/plugin:<id>:<executor>` | 可直接用，零代码 |
| 会话触发链路 | `TaskDueEvent` → `schedulerStore.handleTaskDue()` → `start_chat`（`src/hooks/useAppEvents.ts:69`、`src/stores/schedulerStore.ts:428`） | 已通 |
| 采集 | `cap.http.request` 可抓 http/https（含 RSS/HTML，二进制 base64） | 兜底可用，无搜索依赖 |
| 记忆/归档 | `cap.kv`（持久 KV）+ 数据根目录写入 | 归档可落 `<DataRoot>/digests/` |
| 专家 | `save_agent`（polaris-dispatch MCP）可建全局专家 | prompt 策略可复用、可迭代 |
| 已有缺口 | 无任何新闻/RSS 功能实现；cap.scheduler 未上总线（48 命令停留 `commands/scheduler.rs` 旧路径） | 不阻塞 v2，M3 再议迁移 |

## 架构（文字图）

```
[每周一 09:00]  ← ScheduledTask: cron, category=news, executorType=chat,
      │            engineId=默认, workDir=Polaris 根, notifyOnComplete=true
      ▼
scheduler_daemon ──TaskDueEvent──▶ 前端 start_chat
      │                                │
      │                     专家 ai-news-digest（system prompt）
      │                                │
      │              ┌─────────────────┴─────────────────┐
      │              ▼ 采集层（确定性，不用选搜索）        ▼
      │   cap.http.request 逐源抓取 RSS/Atom：        AI 汇总层：
      │   - hnrss.org/frontpage（HN 热帖）            去重 → 分组
      │   - simonwillison.net/atom/everything        （模型/工程实践/
      │   - techmeme.com/feed.xml                     生态/治理 4 组）
      │   - techcrunch.com AI RSS                    每条给
      │   （源清单存 cap.kv：news.sources.v1，         「对程序员的启示」
      │     用户可增删）                                    │
      │                                                ▼
      │   原始条目 ──cap.kv──▶ news-collector:lastRun   产物层：
      │                                        ├─ Markdown 归档
      │                                        │   <DataRoot>/digests/
      │                                        │   ai-programmer/2026-W43.md
      │                                        ├─ 交互式 HTML 周报
      │                                        │  （v1 spec 模板唤起
      │   会话内消息卡片 ◀─────────────────────┘   preview_html 渲染）
      │                                                │
      ▼                                                ▼
notifyOnComplete 通知用户              （可选）cap.todo 建「本周关注」3 条
```

所有者与幂等：任务状态单权威在 scheduler.db；归档文件名带 ISO 周号（`2026-W43`），重跑覆盖同周文件（不叠加写入）；KV 索引以 `lastRun` 为单位覆盖。

## 里程碑

### M1 —— 零代码改动，立即可用（半天内）
1. `save_agent` 创建全局专家 `ai-news-digest`：system prompt 内置源清单、分组规则、产物格式（对齐 v1 内容结构）、归档指令（写入 digests 目录 + KV 索引）。
2. `polaris-scheduler` 建任务：cron `0 9 * * 1`（每周一 09:00），`executorType=chat`，`category=news`，prompt 复用专家。
3. 手动跑一次 `scheduler_run_task` 验证全链路。

**验收**：到点自动开会话 → 抓源 → 产出周报 Markdown 落 digests 目录 → 会话内可见 HTML 周报 → 通知触达。

### M2 —— 模板沉淀与查看入口（需少量前端改动）
1. HTML 周报模板抽为静态文件（存数据根 `templates/`），专家产出只填数据 → 视觉与内容解耦（v1 原型即模板 v0）。
2. digests 目录查看：复用 `cap.fs`（只读）+ 既有会话卡片渲染，做一个「往期周报」列表入口（可挂在 Scheduler 分类的 news 任务详情里，不新开面板）。
3. 源清单管理：`cap.kv` + 设置表单（最小化，M2 可先不做 UI）。

### M3 —— 产品化（可选）
1. `'news'` 分类升级一等公民：SchedulerPanelPRO 模板「AI 周报」开箱即用。
2. 新闻/周报专属视图面板（往期归档、源健康状态、上次抓取结果）。
3. 顺带把 scheduler 高频命令上 RouterBus（对齐 AGENTS.md 迁移方向，独立主题另开 spec）。

## 风险与边界

- **搜索不可用兜底**：采集层全部走 RSS 直链，不依赖 websearch；任一源失败跳过并在周报末尾标注「源健康」。（本次会话 websearch 持续报 `cancelled`，已验证只有 webfetch 可用。）
- **单源格式漂移**：RSS 结构变化由专家 prompt 兜底（抓不到就报失败，不静默产出空周报）。
- **web 侧隔离**：任务在 Polaris 自己的 AI 引擎中执行，工具集与会话一致（cap.* 可用）；与 OpenCode 会话工具集无关。
- **产物膨胀**：digests 按周归档，KV 只存索引；不做全文检索（M3 再议）。
- **不改协议**：v2 不动 scheduler 模型字段（`category: 'news'` 复用既有枚举），无 Rust/前端类型同步负担。

## 不做（本阶段）

- 不做通用 RSS 阅读器（范围收敛到周报）。
- 不做 Rust 侧新 capability（cap.http/cap.kv 足够）。
- 不做自动发布（邮件/网页托管）；产物分享仍走单文件 HTML（对齐 v1 验收）。
