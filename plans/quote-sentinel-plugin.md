# 盘哨 quote-sentinel 插件 spec

日期：2026-10-28 ｜ 状态：实施中 ｜ 仓库：`D:\space\base\Polaris-plugin\plugins\quote-sentinel`

## 一、目标与定位

**盘哨 = 常驻 Polaris 的 A股/ETF/指数行情哨兵**：盘中自选实时行情、到价/涨跌幅提醒、持仓盈亏、AI 自然语言查行情（MCP 工具）。

- **用户**：持仓/关注 A 股与 ETF 的开发者与 AI 重度用户（Polaris 常驻工作台，与 VSCode 之于 leek-fund、uTools 之于爱盯盘同构）。
- **需求证据**：leek-fund（VSCode）实测 242,444 安装；uTools 生态两个成熟同类（爱盯盘、摸鱼行情）；Chrome 扩展/Windows 桌面悬浮窗/另一 VSCode 插件——同一需求在每个工作台形态被反复重造；Polaris 生态 38 插件实证零覆盖。
- **差异化**：现有同类全部无 AI 集成；盘哨经 MCP 工具直接回答「我的自选怎么样了」「茅台涨过 1350 提醒我」。

## 二、范围（MVP）

**支持**：沪/深/北场内标的（股票、ETF/LOF、指数）；批量实时行情（腾讯主源→东财备源→缓存兜底）；当日分时（腾讯 ifzq）；名称/代码搜索（腾讯 smartbox）；到价与涨跌幅提醒（交易日单次去重）；持仓成本与盈亏；桌面+手机 Web 一致状态（cap.kv）。

**明确不做（P1 候选）**：场外基金实时估值（监管已于 2026-07 彻底下线，fundgz 接口死亡；官方净值模式为 P1）、港股/美股（腾讯字段布局不同，MVP 搜索命中即提示不支持）、K 线历史、自动交易（永不）。

## 三、架构（复用 page-sentinel 三件套）

```
面板(React, esbuild ESM) ─┐
MCP server(stdio, 零依赖) ─┼─→ cap.kv (qsent.* 键空间, SqliteStorage) ←─┐
后台服务(node, 原生fetch) ─┘                                            │
     │ 唯一外网抓取者（面板/AI 永不直连外网 → 跨域问题根治）              │
     └─ 腾讯 qt.gtimg.cn (GBK, Referer gu.qq.com) ──失败──→ 东财 push2 (JSON)
                └─全失败→ 上一轮缓存兜底（state 标 source:'cache'）
```

- **唯一写路径**：行情状态/提醒触发只由服务写；面板与 MCP 写定义（自选/持仓/提醒规则）+ 命令键，服务消费命令后删除。
- 命令模式（伪 IPC）：`qsent.cmd.quote.<n>`（即时查）、`qsent.cmd.search.<n>`（搜索）、`qsent.cmd.minute.<id>`（分时）→ 结果写 `qsent.quote.<n>` / `qsent.search.<n>` / `qsent.minute.<id>`，消费方轮询读。

## 四、键空间契约（三方权威）

| 键 | 写者 | 内容 |
|---|---|---|
| `qsent.settings` | 面板/MCP | `{pollSec, offHoursPollSec, redUp, indexes[]}` |
| `qsent.watch.<id>` | 面板/MCP | `{id(=sh600519 形式), code, name, type, createdAt}` |
| `qsent.state.<id>` | 服务 | `{price, prevClose, open, high, low, pct, chg, volume手, amount万, turnover, time(yyyyMMddHHmmss), fetchedAt, source}` |
| `qsent.minute.<id>` | 服务 | `{date, prevClose, points[{t,p,vol,amt}]}` |
| `qsent.alert.<aid>` | 面板/MCP | `{id, code, type(price_above/below/pct_above/below), value, note, enabled, lastFiredDate}` |
| `qsent.alert.feed` | 服务 | 触发历史数组（cap 100） |
| `qsent.position.<id>` | 面板/MCP | `{cost, shares}` |
| `qsent.meta` | 服务 | 心跳 `{lastPollAt, lastSource, watches, alerts, lastError}` |
| `qsent.readAt` | 面板 | 提醒已读水位 |

## 五、接口

- **服务**：type=http，`/api/health`（宿主健康检查用 `/__health`，桥不可达仍 200 防误杀）；tick 1s 消费命令；盘中（工作日 09:15–11:35 ∪ 12:55–15:10，UTC+8）按 `pollSec`（默认 20，clamp 10–300）轮询，盘外按 `offHoursPollSec`（默认 300）。
- **MCP 工具（10）**：`qs_overview` / `qs_quote_query` / `qs_search` / `qs_watchlist_list` / `qs_watchlist_add` / `qs_watchlist_remove` / `qs_position_set` / `qs_alert_set`(upsert) / `qs_alert_list` / `qs_alert_remove`。
- **代码规范化**：显式前缀 `sh|sz|bj` 优先；裸 6 位按规则（60/68→sh，51/56/58/50→sh ETF，00/30→sz，12/15/16/18→sz 基金，43/83/87/92→bj）；`000xxx` 裸码默认深市股票（指数须显式 sh 前缀或走搜索）。

## 六、安全与合规

外网只读公开行情端点（无密钥无写入）；无用户敏感数据出站；提醒触发只写本地 kv；面板加「非投资建议」声明；不做实时估值（规避监管红线）。

## 七、验收

1. `node --test test/` 全绿：normalize、tencent/em 解析（对真实录制字节）、alerts 引擎、交易时段、GBK 解码、mock 桥端到端。
2. `node test/mcp-verify.mjs`：10 工具 stdio 全流程。
3. `node test/smoke-real.mjs`（本机 Polaris 运行中）：真实桥 + 真实行情接口 + 面板读路径，自清理。
4. `npm run typecheck` + esbuild 构建成功；`node scripts/pack.js` 出包。
5. 真实数据验收：茅台/平安银行/上证指数/300ETF/北交所样本解析数值与接口原始值一致。
