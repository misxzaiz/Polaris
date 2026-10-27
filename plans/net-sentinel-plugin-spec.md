# 网哨（net-sentinel）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> 一句话：把「网络本身」变成可对话的资产——后台原生服务持续探测（TCP 握手延迟/DNS 解析/丢包），断网与劣化边沿触发记进时间线，24h 热力图 + 7 天趋势可回看；AI 经 MCP 回答「现在网怎么样」「昨晚断过网吗」「github 这周延迟如何」。

## 1. 目标与动机

生态缺口盘点（28 个已上架插件）：pocket-host 盯本机 CPU/内存/磁盘、page-sentinel 盯网页内容变化、feed-radar 盯 RSS——**没有任何插件盯「网络链路本身」**。网速慢/掉线是最高频的基础设施痛点，但事后无从归因：是路由器、DNS、运营商，还是目标站的问题？「昨晚 11 点是不是断过网」没有任何工具能回答（Windows 事件查看器不行、路由器日志没人看）。

本插件把运行 Polaris 的电脑变成一台**轻量网络探针**：每 tick 对一组目标做 TCP 连接测量（握手 RTT、DNS 解析耗时、丢包），滚动落库 30 天；断网/恢复/单目标失联/延迟劣化边沿触发记事件；面板热力图 + AI 对话双入口。

## 2. 定位与差异化

- **探测语义 = 网络可达性，不是服务可用性**：TCP connect 被 RST（ECONNREFUSED）也算「通」（IP 应答即证明链路+DNS 通，且 SYN→RST 往返仍是有效 RTT）；仅超时/不可达/DNS 失败记丢包。这是纯 Node 可做的最接近 ping 的语义（无需 ICMP/管理员权限）。
- **DNS 与链路分离归因**：域名目标先 `dns.lookup`（OS 解析器，含 hosts）测 dnsMs，再对解析出的 IP 握手测 connectMs——「DNS 慢还是链路慢」一眼可辨。
- **锚点在线判定**：4 个默认锚点（223.5.5.5 / 119.29.29.29 / baidu / 1.1.1.1）≥2 个可达才算在线——单锚点失联不误报断网。
- **边沿触发不轰炸**：NetEventMachine 全部事件按「连续 N 轮 + 最小间隔 30min」限频，恢复事件带持续时间。
- **按需测速**：平时零大流量；测速走命令键（confirm + mb 上限 25 + SSRF 守卫：拒绝 localhost/私网，allowPrivate 显式放行给局域网 NAS 测速）。
- **跨端**：数据全在 cap.kv（`netmon.*`），手机打开同一面板看到同一份网络状态与事件线。

## 3. 架构与跨域决策

| 面层 | 方案 |
|---|---|
| 数据面 | 一切状态/桶/事件走 cap.kv（`netmon.*`），面板/MCP/服务三方共享，跨端一致 |
| 探测面 | 全部探测在后台服务原生执行（node net.connect + dns.lookup + http GET 测速）——浏览器 CORS/CSP 面为零 |
| 面板通道 | 面板**零直连 fetch**（宿主 `__POLARIS_HOST_INVOKE__` → router_dispatch → cap.kv），桌面/Web/手机三端同源 |

```
面板/MCP                     服务（探测引擎，唯一写者）
   │ cmd.speed / cmd.targets    │
   ├───────────────────────────▶│ tick 消费命令键（先删后做）
   │                            │ net.connect 探测 → 分钟聚合 → 小时桶
   │ 读 snapshot/meta/h.*/event │ 写 cap.kv（netmon.*）＋告警边沿评估
   │◀───────────────────────────┤
```

## 4. 键空间契约（权威，三方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `netmon.settings` | 面板写，服务读（10s） | { tickSec 5-120:10, timeoutMs 1000-10000:3000, latencyMs 100-10000:400, sustainRounds 2-12:6, retentionHours 24-2160:720, speedMb 1-25:10, speedUrl, paused } |
| `netmon.targets` | **服务写**（经 cmd.targets 原子改） | { v1, targets: [{id,label,host,port,kind,enabled}] }，kind ∈ gateway/anchor/normal，gateway host 可空=自动发现 |
| `netmon.snapshot` | 服务写（每 tick） | { at, version, tickSec, online, round:{tid:{ok,ms,dnsMs?,err?}}, targets:[…], recent:{tid:[[t,ms|null]…≤90]}, speeds:[≤3], speeding?, counts } |
| `netmon.meta` | 服务写（60s） | 心跳 { version, pid, startedAt, lastTickAt, bridge, gateway, degraded, lastBridgeErr, retentionHours } |
| `netmon.h.<YYYYMMDDHH>`（本地时） | 服务写（每 tick 写当前桶=写前持久，重启续写） | { v1, at, byTarget: { tid: [[minIdx, avgX10|null, max, loss, cnt], …≤60] } } |
| `netmon.event.<13位ts>` | 服务写，cap 200 | { type, at, summary, targetId?, value?, threshold?, durMs? }，type ∈ net_down/net_recovered/target_down/target_recovered/latency_high/latency_recovered |
| `netmon.speed.<13位ts>` | 服务写，cap 50 | { at, url, mb, ok, mbps?, durMs?, latencyMs?, err? } |
| `netmon.cmd.speed.<nonce>` / `netmon.cmd.targets.<nonce>` | 面板/MCP 写，服务消费=**先删后做** | speed: {confirm:true, mb, url?, allowPrivate?}；targets: {action: add/remove/enable/disable, target?, id?} |
| `netmon.result.<nonce>` | 服务写，请求方读后删（>15min 孤儿清扫） | { ok, at, payload?, error? } |
| `netmon.readAt` | 面板写 | 事件已读水位 |

## 5. 探测引擎设计

- **默认目标 7 个**：gateway（自动发现， refused 也算通）、锚点 223.5.5.5:53 / 119.29.29.29:53 / www.baidu.com:443 / 1.1.1.1:53、工作目标 github.com:443 / cdn.jsdelivr.net:443。
- **网关发现**：win `powershell Get-NetRoute`（属性名不随 locale 变）→ mac `route -n get default` → linux `ip route`；启动 + 每 10min 刷新；发现的网关写进 meta 与 gateway 目标（用户显式配置 host 则不覆盖）。
- **tick 流程**（默认 10s）：重入守卫 → 并发探测全部启用目标（每目标超时 timeoutMs）→ 分钟聚合（curMin）→ **每 tick 写当前小时桶**（含未满分钟，服务重启从 kv 续写）→ 快照落盘 → NetEventMachine 评估 → 命令消费（每 tick）。
- **礼貌性**：7 目标 × 6 轮/分 = 42 个 SYN/分 + DNS 查询，无压力。
- **保留清扫**（10min）：小时桶 > retentionHours、事件 > 200、测速 > 50、孤儿 result > 15min。
- **降级**：桥不可达时健康端点仍 200（防重启循环），degraded 写 meta（与 pocket-host 同款）。

## 6. MCP 工具（5 个 net_*）

| 工具 | 用途 |
|---|---|
| `net_status` | 当前在线状态 + 各目标最近延迟/丢包/DNS + 进行中事件（「现在网怎么样」「github 能连吗」） |
| `net_history` | 回看最近 N 小时（默认 1，上限 72）：分目标 avg/p95/max/丢包率/断网分钟数（「今天上午网怎么样」） |
| `net_events` | 事件流（断网/恢复/失联/劣化，带时间段）（「昨晚有没有断网」） |
| `net_speedtest` | 按需测速（confirm:true；mb ≤25；SSRF 守卫）（「帮我测下网速」） |
| `net_targets` | 目标管理 list/add/remove/enable/disable（「帮我盯一下 xyz.com:443」） |

## 7. 面板（4 Tab）

- **概览**：在线大状态（锚点判定）+ 目标卡片（延迟色阶 + 15min spark + 丢包/DNS 标签）+ 进行中事件条 + 最近测速。
- **历史**：范围 24h/72h/7d + 目标选择；小时桶热力条（颜色=avg/丢包）+ SVG 折线 + 聚合表（avg/p95/max/loss%）。
- **动态**：事件流 + 未读 badge（readAt 水位，同 pocket-host 交互）。
- **设置**：数值参数 + 目标编辑器（增删改/启用，经 cmd.targets）+ 测速 URL 与手动测速 + 服务状态/重启 + 清空数据。

## 8. 验收

- 离线单测：lib.js 纯逻辑全覆盖（聚合/桶编码/保留清扫/事件机边沿触发与限频/目标与设置规范化/SSRF 守卫/网关解析三平台）。
- 真实桥冒烟：服务拉起 → 快照含 ≥5 目标实时 round → 小时桶落库 → cmd.targets 增目标生效 → 本地 HTTP 2MB 测速闭环（allowPrivate）→ MCP tools/list 5 + net_status 读回真快照 → 清理 netmon.* 键。
- `node test/run-tests.mjs` 全过 + `test/smoke-real.mjs` 全过（需本机 Polaris 在跑）。
