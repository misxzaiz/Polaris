# sundial（日晷）——个人日程 / 提醒 / 倒计时插件 spec

> 状态：已实施（v0.1.0，插件仓 `plugins/sundial/`）。本文按 AGENTS.md 规范记录目标、契约与验收。

## 一、目标与定位

Polaris 插件生态（27 个）覆盖了记账/订阅/监控/备份/快传/闪卡等，唯独没有**个人时间管理**：
日程安排、重复事件、到期提醒、纪念日倒数、习惯打卡、外部日历（ICS）订阅。主应用 todo 是
AI 任务列表（一次性、无重复规则、无月视图），不构成重叠。本插件补齐这一日常刚需：

- **对话式入口**：聊天里说「周五下午3点提醒我取快递」「明天开始每天晚上10点背单词打个卡」「距高考还有几天」→ MCP 工具直接落库。
- **外部日历接入**：ICS/Webcal 订阅（Google 日历公开日历、课表、排班表），后台服务原生 fetch 同步——浏览器同源策略管不到服务进程，这是跨域问题的根治点。
- **三端同读**：cap.kv 数据面，桌面面板 / 手机 Web 打开同一面板看到同一份日程与提醒。
- **零依赖**：ICS 解析 / RRULE 展开 / 提醒计算全部手写纯函数（shared/core），与 feed-radar 手写 xml 同一纪律，全行为可离线单测。

## 二、架构与进程（平台契约）

| 进程 | 职责 | 跨域路径 |
|---|---|---|
| 面板（React，blob 注入） | 今日时间轴 / 月视图 / 事件管理 / 设置 | 零外网请求，全走 `__POLARIS_HOST_INVOKE__('router_dispatch')` |
| 后台服务（node，type=http） | ICS 订阅抓取同步、提醒投影计算、保留清扫、心跳 | **唯一外网抓取点**：原生 fetch + SSRF 守卫 + ETag 条件请求 |
| MCP server（node，stdio） | 7 个 AI 工具，读写 kv + 命令信箱 | 不抓外网，外网动作委托服务 |

## 三、键空间契约（权威，三方一致）

前缀 `sundial.`，逐键唯一写者（single-writer 纪律）：

| 键 | 内容 | 写者 | 读者 |
|---|---|---|---|
| `sundial.ev.<id>` | 事件定义（含 done/skip 发生标记） | manual 事件：面板/MCP 直写（id 幂等 + rev 失效信号）；ICS 事件：仅服务同步 | 三方 |
| `sundial.ics.<id>` | ICS 订阅定义 | 面板/MCP 写定义字段；服务写运行态（etag/lastFetchAt/…） | 三方 |
| `sundial.settings` | 设置（提醒默认/保留天数/ICS 间隔） | 面板/MCP | 服务读 |
| `sundial.reminders` | 当前到期提醒投影数组 | **仅服务** | 面板/AI |
| `sundial.ui.acked` | 提醒确认 map（rId → ack 时间） | **仅面板** | 服务读（过滤已确认） |
| `sundial.meta` | 服务心跳 | 仅服务 | 面板 |
| `sundial.cmd.ics.add.<n>` / `.refresh.<id>` / `.remove.<id>` / `.refreshAll.<n>` | 命令信箱（消费即删，先删后做） | 面板/MCP 写 → 服务消费 | — |
| `sundial.smoke.*` | 冒烟测试专用子前缀 | 冒烟脚本 | 100% 清理 |

事件量为个人级（数百），逐事件一键与 feed-radar 文章键同口径；保留策略自动清扫过期一次性事件。

## 四、数据模型与核心算法（shared/core.js 纯函数）

```
Event { id('e'+hash10), title, notes, kind:'event'|'habit'|'countdown',
        start( epoch ms；allDay 时 = UTC 零点并按 UTC 日期渲染 ),
        durationMin( allDay 按天×1440 ), allDay, rrule( ICS 语法子串 ),
        remind: number[]( 提前分钟，≤3 ), tags[], source:'manual'|'ics',
        icsId?, uid?, enabled, done: { occKey:'done'|'skip' }, createdAt, updatedAt, rev }
```

- **RRULE 子集**：`FREQ=DAILY/WEEKLY/MONTHLY/YEARLY`、`INTERVAL`、`BYDAY`（周/月第 n 个星期几）、
  `BYMONTHDAY`、`BYMONTH`、`UNTIL`、`COUNT`。展开窗口按需计算，单次上限 500 个发生。
- **时区策略（如实边界）**：`Z`（UTC）、`TZID`（先取 ICS 自带 VTIMEZONE 的 STANDARD/DAYLIGHT
  换算规则，缺失时回落内置固定偏移表，DST 区在规则缺失时可能偏差 1 小时）、浮动时间=本机时区。
- **提醒投影**：`remindAt = 发生开始 - offset`（全天事件锚定当天本地 09:00）；到期窗口
  `[remindAt, 发生开始+30min]`，被 done/skip/acked 抑制；服务重启可确定性重算，无送达标记键。
- **习惯连击**：computeStreak 按计划发生从今天（或昨天）向前数连续 done。
- **倒计时**：未来一次性/每年纪念日的下一次发生 → D-N 卡片数据。

## 五、MCP 工具（7 个，中文描述带适用句式）

`sundial_add`（加事件/习惯/倒数日，AI 负责自然语言→结构化时间）、`sundial_query`（today/tomorrow/week/upcoming/all + 关键词/标签）、
`sundial_update`、`sundial_delete`（confirm 门）、`sundial_done`（打卡/完成/跳过某次发生）、`sundial_ics`（add/list/remove/refresh）、
`sundial_today`（今日+明日摘要 + 未确认提醒——AI 晨间「今天有什么安排」入口）。

## 六、面板（4 Tab）

**今日**（到期提醒横幅 + 提示音 + 「知道了」；时间轴含现在线；习惯打卡勾选；倒计时卡片区）、
**日历**（月视图内联 SVG/网格，点天看当天）、**事件**（列表 + 搜索 + 添加/编辑表单：重复规则下拉/提醒提前量/标签；ICS 订阅管理）、
**设置**（服务管理卡含自举 start、默认提醒、保留天数、导出 JSON/清空confirm）。移动端：响应式 + 40px 触控目标 + supportsFullscreen。

## 七、验收（三层，全绿才算完成）

1. 离线单测 `node test/run-tests.mjs`：rrule 展开（各 FREQ/BYDAY/UNTIL/COUNT/INTERVAL）、ICS 解析
   （UTC/TZID/全天/EXDATE/VTIMEZONE）、提醒投影（ack/done 抑制、全天 09:00 锚定）、streak、SSRF 守卫、
   规范化边界——行为级断言。
2. 构建门 `tsc --noEmit` + esbuild（React external）。
3. 真实桥冒烟 `node test/smoke-real.mjs`：护栏检查 → 真实 kv 读写 → 写入真实 ICS 订阅（真实外网抓取，
   服务同步入库）→ 提醒投影出现 → MCP initialize/tools/list/tools/call 闭环 → 全前缀自清理 N/N。
4. 打包：`node scripts/pack.js plugins/sundial` → index.json 手动追加条目（@main URL + sha256）→ update.json 同步 → validate.js。

## 八、如实边界（README 同步）

- 提醒为**应用内触达**（面板横幅/提示音 + AI 问答可见）；主应用暂无插件可用的系统通知通道，拿到后本插件可平滑接入。
- ICS 时区：内嵌 VTIMEZONE 正确处理；无 VTIMEZONE 且属 DST 时区的 TZID 回落固定偏移，可能偏差 1 小时（内置表覆盖常见时区）。
- RRULE 不支持：BYSETPOS、BYWEEKNO、RDATES；月视图长期事件按展开窗口渲染。
