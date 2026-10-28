# 泉府 quanfu —— 贷款全生命周期台账插件 spec

> 状态：已定案，实施于插件仓 `plugins/quanfu`。
> 选型背景：2026-10-29 会话。46 插件域图上「贷款/负债」零占位（盘哨=股票行情持仓、口袋账本=日常消费、守闸/常契=订阅、车辖=车辆台账，均无摊销模型）。车辖/纸坊为今日并行会话成果（未提交），主动避开。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **需求盘子大且在扩大**：国有六大行个人住房贷款余额降幅逐年扩大——2023 年 −0.56 万亿、2024 年 −0.62 万亿、2025 年 −0.71 万亿（各行年报口径），提前还贷潮 2022 年兴起至今未退。
- **决策金额量级远超生活类插件**：「缩期 vs 减月供」的利息差在公开测算文章中案例达 8–20 万元（什么值得买/搜狐，检索核验）；用户在用 Excel 表格自算对比（博客园文章明示「建议用表格把两种方案净省利息并排对比」）——临时工作流信号。
- **重定价新政带来新增决策点**：2024-11 起存量房贷重定价周期可调整一次（可缩至 3/6 个月），重定价日选 1/1 还是放款日在知乎长期高频讨论——「下次重定价日」需要一个长期记录它的地方。
- **竞品格局（如实）**：手机端已有免费无广告计算器（还款计算器：组合贷+方案对比；Richify：缩期 vs 减供逐月模拟），纯计算不是差异化；但①全部无状态（每次重输）、②App Store 评价区可见「减少月供计算结果有误」类质量吐槽、③无家庭共享、④无对账（银行 App 只显示当前值不给 what-if）、⑤输入房贷明细到广告网页有隐私面。
- **本插件的差异化 = 持久台账 × 对话式 what-if × 家庭三端 × 纯本地**：问 AI「提前还 20 万缩期还是减供」，引擎基于**已建档的真实贷款**（含已记利率变更/提前还款流水）算三方案对比——这是无状态计算器给不了的。
- **未验证假设（如实）**：①使用频率是阶段性（决策期高频+每月 awareness+年度重定价），低于打卡类——以「长期台账价值」而非「高频」立足；②Polaris 用户中有活跃房贷人群的比例未知——插件零成本随工作台常驻，决策窗口出现时即在。

## 二、产品定义

- **名称**：泉府（quanfu）——《周礼·地官》泉府掌市之征布与赊贷，泉者钱也；古之官办借贷机构，今之家庭负债台账。
- **一句话**：把家庭「最大的一笔负债」变成可对话、可对账、会主动提醒的贷款台账——月供怎么构成、还剩多少本金、提前还一笔缩期还是减供省、下次重定价日何时到。
- **目标用户**：有房贷/车贷/经营贷/消费贷的家庭；正纠结提前还款的家庭；公积金+商贷组合贷家庭；夫妻共贷两端同看。
- **核心场景**：① 「我有笔商贷 100 万 30 年等额本息 3.6%，2021 年 3 月开始还」→ 建档即出当前状态（已还期数/剩余本金/结清日）；② 「提前还 20 万，缩期还是减月供？」→ 基准/缩期/减供三方案对比（省息、月供变化、期限变化）；③ 「这个月重定价了，利率 3.3%」→ 记利率变更，月供自动重推；④ 「银行说我本金还剩 65 万」→ 记对账点，账面 vs 银行漂移一目了然；⑤ 面板总览看每笔贷款进度环+临近事件（扣款/重定价/漂移）；⑥ 组合贷两笔子贷同组展示。
- **安全边界（硬约束）**：纯本地零网络（无服务进程、无外网请求、cap.kv 存储）；只做记录与测算，**不构成金融建议**（全部输出带口径声明）；不做银行对接、不抓 LPR（利率一律用户录入）、不算违约金（各行合同不同，仅 note 提醒）、不做理财推荐。

## 三、数据模型（cap.kv 键空间 `quanfu.*`，无服务进程，实体由面板/MCP 直写）

| 键 | 写者 | 内容 |
|---|---|---|
| `quanfu.loan.<id>` | 面板/MCP | 贷款 `{id,name,lender?,kind:'mortgage'\|'car'\|'consumer'\|'business'\|'other',principal(元>0),method:'annuity'\|'linear'\|'bullet',annualRate(%，4dp),startDate(首期还款日),termMonths(1..600),repricing?:{day:'MM-DD'\|'anniversary',cycleMonths:3\|6\|12},groupId?,note?,active,createdAt}` |
| `quanfu.ev.<occKey>` | 面板/MCP | 事件 `{occKey,type:'rate'\|'prepay'\|'checkpoint',loanId,date,rate?(%),amount?(元),mode?:'term'\|'payment',note?,at}`；occKey=`type\|loanId\|date`（同日同型覆盖=幂等） |
| `quanfu.settings` | 面板 | `{warnDays(扣款临近,默认3),repricingWarnDays(默认30),driftWarn(漂移提示阈值元,默认100)}` |

id 规则：`idFor(seed)=sha256(seed) 前 12 位`（f 前缀）；贷款按 `name` find-or-create 幂等（同 qingnang 惯例）。**语义锚**：startDate=第一期还款日；rate 事件 date=新利率生效的第一期还款日；prepay date=其日期 ≥ 该日的第一个扣款日生效；checkpoint=银行口径剩余本金快照（被动对账，不改账面）。

## 四、核心引擎（shared/core.js 纯函数，面板/MCP 同源；金额全程 2dp 分级舍入）

1. **三种还款方式逐期生成**：annuity（pmt=round2(P·r/(1−(1+r)^−n))，末期本金补差）、linear（princM=P/n，末期补差）、bullet（逐期息，到期还本）；interest=round2(余额×r)。
2. **事件分段重放**：按日期排序的 rate/prepay 事件把 schedule 切段；每个边界按当前 plan 模式重推——payment 模式（减供）：保持期数重推月供/月本金；term 模式（缩期）：保持月供/月本金解出新期数（annuity 解 n=ln(pmt/(pmt−bal·r))/ln(1+r)）；每次 prepay 的 mode 即此后 plan 模式。bullet 提前还款只减息不缩期（到期还本，如实标注）。
3. **whatif 三方案**：基准（不还）/缩期/减供各跑一遍完整重放 → 剩余总利息、省息、月供变化、期限变化、新结清日；缩期月供不足以覆盖利息时如实报不可行。
4. **状态投影**：loanState(loan, events, today) → 当前期数、下次扣款日与金额、当前利率、剩余本金、剩余总利息、已付利息/本金、本年已付、结清日、下次重定价日（repricing 配置推导）。
5. **对账漂移**：checkpoint.date 当日账面余额 vs 银行值 → drift；|drift|>阈值提示可能漏记利率变更/提前还款。
6. **年度构成**：schedule 按年桶化（本金/利息/已付），面板迷你柱图与 AI 年度复盘共用。
7. normalizeLoan/normalizeEvent/normalizeSettings 全部钳制与中文报错；addMonths 月末钳制（1/31→2/28）。

## 五、架构（复用平台已验证范式，同 qingnang/shouzha）

- **无后台服务**（同守闸先例：实体少、派生廉价、零跨域面）：面板与 MCP 各自经 shared/core 现算，口径同源。
- `mcp/server.js`：stdio JSON-RPC，7 工具 `quanfu_today / add / whatif / log / query / update / delete`；金额双单位（元 + `*Wan` 万，防 AI 换算错）；删除 confirm 门；贷款删除连带清事件。
- `src/` 面板四 Tab：总览（贷款卡进度+临近横幅+家庭合计）/ 测算（whatif 交互工作台，本地现算）/ 贷款（列表+详情+年度构成+事件流水+增改删）/ 设置（参数+导出导入+清空）；数据走 `__POLARIS_HOST_INVOKE__ → router_dispatch → cap.kv`；5s 轮询可见时启用。
- 图标 `AlertCircle`（白名单内，0 占用，到期提醒语义）；order 89（空位）。
- 发布：`node scripts/pack.js plugins/quanfu`；index.json 新增条目先手写再跑 publish-plugin.mjs 同步 sha（并发纪律：写前重读、只动自己的条目）。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：三种方式金标准手算例（首期/末期/利率 0）、分段重放（rate 前后月供跳变）、缩期/减供双模式（annuity+linear）、whatif 三方案与不可行路径、月末钳制、对账漂移、normalize 边界（负数/越界/非法日期）。
2. `node test/mcp-verify.mjs` 内存桥全流程：建档→whatif→利率变更→提前还款→对账→查询→更新→确认门→连带删。
3. `node test/harness-run.mjs` jsdom 无头渲染断言：四 Tab、贷款卡、测算对比卡、空态。
4. `node test/smoke-real.mjs` 真实宿主桥（Polaris 在运行时）：真 cap.kv 全链路 + 收割清理。
5. esbuild 自包含 + tsc strict；plugin.json / update.json / index.json 三处版本与 sha256 一致。
6. 面板与全部工具输出带「测算不构成金融建议，以银行实际计息为准」口径；零外网请求可 grep 实证。
