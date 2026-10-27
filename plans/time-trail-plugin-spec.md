# 刻漏（time-trail）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> 一句话：把「这台机器的时间流向」变成可对话的资产——后台服务驱动 PowerShell 采集器记录前台应用与空闲状态，按天/小时/应用归集成时间账本，分类规则引擎把应用映射到七类；AI 经 MCP 回答「我今天干了啥」「这周写代码多久了」「帮我归类这些新应用」，面板给出实时当前应用、分类条、24h 时间带与 14 天趋势。

## 1. 目标与动机

生态缺口盘点（30+ 已上架插件）：日晷管「将要发生什么」（日程提醒）、拾光机管「AI 会话里说过什么」、算盘管「AI token 花在哪」、pocket-host 盯机器资源——**没有任何插件回答「我的时间实际流去了哪」**。「一天下来都不知道干了啥」「这周摸鱼了多少」是比断网更日常的困惑，且只有本机常驻服务能回答（ActivityWatch 要独立装一套、ManicTime 要账号）。

本插件把运行 Polaris 的电脑变成一台**轻量时间计步器**：每 tick 记录前台窗口归属（进程名 + 可选标题）与输入空闲状态，离线归集成天/小时/应用三级时间账本，滚动保留 90 天；面板与 AI 双入口消费。

## 2. 定位与差异化

- **零依赖原生采集**：PowerShell（系统自带）P/Invoke `GetForegroundWindow`/`GetLastInputInfo`，无需安装任何东西；采集器是子进程，父进程死亡即自杀（`Get-Process -Id $ParentPid` 看门狗），不留孤儿。
- **隐私分级默认**：默认**只记进程名不记窗口标题**（标题可能含邮件主题/聊天内容）；标题采集需面板显式开启，开启后单标题截断 80 字符、单应用每日 top 40、全部本地 cap.kv 不出机器。随时一键暂停（隐私模式）。
- **分类是视图不是数据**：落库的是原始 appKey（进程名）时间，分类规则（exact/prefix 两类规则）在读取时套用——改规则立即对全部历史生效，无需重算。内置常见 60+ 应用种子规则（dev/browse/meet/create/media/play/other 七类），未知应用由 AI 经 `timetrail_set_categories` 归类沉淀。
- **归因口径诚实**：两条采集线之间的间隙归给起点应用、上限 90s（休眠/采集器死亡不产生幽灵时间）；空闲超阈值（默认 180s 无输入）的时间记入 idle 桶，不算到应用头上；跨小时的心跳归给起始小时（≤60s 偏差）。
- **服务重启不双记**：天记录是服务内存权威副本，flush=全量覆写（非增量累加），启动时从 kv 装载续记——崩溃重启不会重复计时。

## 3. 架构与跨域决策

| 面层 | 方案 |
|---|---|
| 数据面 | 一切状态走 cap.kv（`timetrail.*`），面板/MCP/服务三方共享，跨端一致 |
| 采集面 | 全部系统采集在后台服务 + 其 PowerShell 子进程原生执行——浏览器 CORS/CSP 面为零 |
| 面板通道 | 面板**零直连 fetch**（宿主 `__POLARIS_HOST_INVOKE__` → router_dispatch → cap.kv），桌面/Web/手机三端同源；命令走 cmd/result 命令邮箱（与网哨同款） |

```
面板/MCP                        服务（归集引擎，唯一写者）           采集器（PowerShell 子进程）
   │ cmd.* / settings             │                                    │ 每 3s tick
   ├─────────────────────────────▶│ 消费命令键（先删后做）               │ JSONL{t,app,title,idleMs}
   │ 写 settings（暂停/阈值…）     │──── spawn( collector.ps1 ) ────────▶│ 仅变化/心跳时输出一行
   │ 读 snapshot/meta/day.*/cats  │◀────────── stdout JSONL ────────────│ 父死自检自杀
   │◀─────────────────────────────┤ 归集→天记录(20s flush)→快照(30s)     │
```

## 4. 键空间契约（权威，三方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `timetrail.settings` | 面板/MCP 写，服务读（60s + 启动） | { tickSec 2-15:3, idleSec 30-1800:180, captureTitles bool:false, retentionDays 7-365:90, paused bool:false } |
| `timetrail.snapshot` | 服务写（30s） | { at, version, tickSec, idleSec, paused, collector: alive/starting/dead/unsupported, current:{app,title?,since,idleSecNow}\|null, today:{activeSec,idleSec,switches,apps}, todayDate, lastErr? } |
| `timetrail.meta` | 服务写（60s） | 心跳 { version, pid, startedAt, lastTickAt, bridge, collectorPid?, collectorRestarts, lastLineAt?, retentionDays, captureTitles } |
| `timetrail.day.<YYYY-MM-DD>`（本地日） | **服务写**（当前日 20s 全量 flush；SIGTERM flush） | { v1, date, apps:{appKey:sec}, idleSec, hours:{h:{appKey:sec,_idle:sec}}, titles?:{appKey:{title:sec}}, switches, firstAt, lastAt } |
| `timetrail.cats` | 面板/MCP 写，读取方套用 | { v1, rules:[{match, kind:'exact'\|'prefix', cat}] }，cat ∈ dev/create/meet/browse/media/play/other |
| `timetrail.cmd.<nonce>` | 面板/MCP 写，服务消费=**先删后做** | { action: flush/collector_restart/purge_app/purge_all, app?, confirm? } |
| `timetrail.result.<nonce>` | 服务写，请求方读后删（>15min 孤儿清扫） | { ok, at, payload?, error? } |

保留清扫（每日 + 启动）：`timetrail.day.*` 早于 retentionDays 删除；孤儿 result > 15min 删除。

## 5. 采集与归集设计

- **采集器**（`service/collector.ps1`，Windows PowerShell 5.1 兼容，**UTF-8 BOM**——PS 5.1 对无 BOM 文件按 ANSI 解码会碎掉中文注释）：`-TickSec -IdleSec -ParentPid -CaptureTitle`；Add-Type P/Invoke 四个 user32 API；仅在（appKey 变 / 标题变 / 空闲态翻转 / 60s 心跳）时输出一行 UTF-8 JSONL（ConvertTo-Json 转义，非 ASCII 安全）。appKey=小写进程名去 `.exe`；`ApplicationFrameHost`（UWP 宿主）回退用标题作 appKey。锁定屏/无前台窗口输出 `kind:'none'`。冷启动（Add-Type 编译）实测 ~30s，服务常驻故为一次性成本。
- **归集**（`service/trail.js`）：行间间隙 `min(gap, 90s)` 归起点行；`idle=true` 归 idle 桶；应用切换且两侧均活跃时 `switches++`；行超时（>90s 无行）丢弃间隙。
- **采集器守护**：意外退出→指数退避重启（5s→5min）；暂停（paused）时**采集器保留运行**、服务侧丢弃行（落盘前截断，避免恢复时重付 30s 冷启动；恢复/暂停边界重置归因基线，不跨边界误归因）；非 Windows 平台 collector=unsupported，面板/MCP 优雅降级（历史数据仍可读）。
- **礼貌性**：3s 一个 tick 全部为 user32 内存调用（微秒级），仅变化时跨进程写一行；CPU 占用可忽略。
- **MCP 五工具**：`timetrail_today` / `timetrail_query`（days/date/app/cat 过滤 + 分类聚合 + 焦点指标）/ `timetrail_apps`（含未知应用清单）/ `timetrail_set_categories`（校验七类白名单）/ `timetrail_control`（pause/resume/status，confirm 语义）。

## 6. 验收

1. 单测 `test/run-tests.mjs` 全绿（归因间隙/空闲/跨天/分类规则引擎/UWP 回退/标题截断/保留清扫/快照形状）。
2. 冒烟 `test/smoke-real.mjs` 全绿：真实桥 + 假采集器（脚本化 JSONL）→ 快照/天记录/命令闭环/MCP tools/list 与读数/清理。
3. 面板四 Tab 真数据渲染；手机端打开同一面板可见同一账本（cap.kv 跨端一致）。
4. 隐私默认：未开标题采集时，kv 内任何键不含窗口标题文本。

## 7. 已知边界

- Windows 专用采集（非 Windows 只读历史）；UWP 应用以标题为 appKey（精度取决于标题开关）。
- 浏览器内「哪个网站」不采集（需要读 URL/历史，侵入性高）——标题开启后由 AI 从标题推断。
- 服务与采集器之间的行超时上限 90s：系统休眠恢复后的首段时间会被丢弃而非错记。
