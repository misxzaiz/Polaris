# 金匮 jinkui —— 家庭保单与保障台账插件 spec

> 状态：已定案，实施于插件仓 `plugins/jinkui`（commit 904ef77，v0.1.0 已上架 index.json）。
> 选型背景：2026-10-29 会话。家庭台账系列（药匣/车辖/泉府/票匣/常契/守闸）之后的空位域：**人身与家庭财产保险**。46+ 插件域图中「保单」零占位——车险归车辖（chexia.doc 管 交强险/商业险到期）、贷款归泉府、订阅归常契/守闸，均与保单模型（缴费期×保障期×宽限期×复效）不同构。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **忘缴费有法定后果**：长期险逾期未缴→60 天宽限期（保障仍有效）→中止期（2 年内可申请复效，**期间出险不赔**）→逾 2 年未复效合同终止（中国人寿/中宏官方口径多源核验）。忘一次=真金白银的保障真空。
- **孤儿保单是行业结构性问题**：代理人离职后无人提醒续费、无人解释条款、家人甚至不知道保单存在（汇丰人寿「保单管理」页将此列为典型场景）。
- **隐私恐惧有实证**：腾讯微保被指将用户数据泄露给第三方保险公司致电销骚扰（知乎爆料帖）；南方都市报 2025-08 调查保险中介 App 用户协议存在「偷窥条款」（收集上网记录/不可拒收营销/共享合作伙伴）。**「本地零上传零账号」是对该恐惧的直接回答，不是空喊卖点。**
- **现有方案缺口（已核验）**：① 保司官方 App 只看自家保单，跨公司无统一视图；② 第三方工具多为经纪人获客件——上传云端+推销导向（什么值得买六款评测：多为手动录入、功能单一）；③ 移动端本地工具是表单驱动单机件，无对话、无桌面、无家庭三端；④ 网友自制 Excel 保单一览表（百度知道）证明桌面归集习惯存在，但无提醒无透视。
- **缺口分析是市场验证过的付费能力**：深蓝保以「按家庭结构自动分析保障缺口」为核心卖点——本插件以确定性口径（四大件覆盖矩阵）免费复现，不做产品推荐。
- **未验证假设（如实）**：家庭平均保单张数未见权威公开口径，推断为 3–15 张/户（重疾/医疗/意外/年金渗透率高），不影响 MVP 价值；「家庭共享看保单」的频次是推断。

## 二、产品定义

- **名称**：金匮（jinkui）——匮者，柜也；《史记》「藏诸金匮石室」，金柜藏重要文书。保单正是一个家庭最该锁进金柜的纸。
- **一句话**：家庭保单保险库——每张保单可对话、缴费/宽限期会主动提醒、全家保障缺口一眼看穿，数据不出本机。
- **目标用户**：为全家配置过商业保险（重疾/医疗/寿险/意外/年金/家财）的家庭；保单散落多公司多渠道、说不清「都买了啥、啥时候缴费」的投保人。
- **核心场景**：① 对 AI 说「给娃买了份 50 万的重疾，平安的，年缴 4000，缴 20 年，2023 年 5 月生效」一句话入柜；② 面板看缴费红黄榜（宽限期红/30 天内缴费黄）、等待期、满期倒数；③ 聊天问「我妈的重疾什么时候缴费」「全家医疗险都有吗」「今年保费一共多少」；④ 每年缴费确认一句「这份已经交了」→ 账本推进；⑤ 退保/复效/理赔随手记流水。
- **独有价值**：宽限期/中止期状态机（法定口径投影）× 四大件缺口矩阵（确定性现状透视，非推销）× 家庭多成员多保单三端同读 × 对话式入柜 × 12 个月保费现金流 × 纯本地零上传。
- **安全边界（硬约束）**：只做保单记录/提醒/现状透视，**不做**产品推荐、保费对比、理赔代办、保单文件解析上传、对接任何保司接口。输出一律带「不构成投保建议」口径。

## 三、数据模型（cap.kv 键空间 `jinkui.*`）

| 键 | 写者 | 内容 |
|---|---|---|
| `jinkui.member.<id>` | 面板/MCP | 成员 `{id,name,relation:'self'\|'spouse'\|'child'\|'parent'\|'other',birthYear?,note,createdAt}` |
| `jinkui.policy.<id>` | 面板/MCP | 保单 `{id,name,kind:'medical'\|'critical'\|'life'\|'accident'\|'annuity'\|'property'\|'other',insuredId,holderId?,company?,policyNo?,coverage?,coverageNote?,premium?,freq:'yearly'\|'half'\|'quarter'\|'monthly'\|'single',payYears?,startDate,endDate?,waitingDays?,fileNote?,note?,endedAt?,endReason?:'surrender'\|'terminated',createdAt}` |
| `jinkui.ev.<occKey>` | 面板/MCP | 事件 `{occKey:'type\|policyId\|date',type:'pay'\|'claim'\|'endorse'\|'reinstate'\|'surrender'\|'other',policyId,date,amount?,note,at}` |
| `jinkui.settings` | 面板 | `{graceDays:60,warnDays:30}` |

id 稳定规则：`idFor(seed)=sha256(seed) 前 12 位`；成员按 `member|名字`、保单按 `policy|被保人|险种|公司|产品名` 定 id，按名 find-or-create 幂等（同 qingnang 范式）。事件 occKey 同日同型覆盖（同 quanfu）。纯 kv 零服务（quanfu 模板），派生一律 core 现算不落快照键。

## 四、核心派生（纯函数，shared/core.js 两方同源）

1. **缴费进度**：`paidUntil = max(pay/reinstate 事件日)`（无事件=startDate，投保即缴首期）；`periodsPaid` = startDate 到 paidUntil 按 freq 步进期数；`totalPeriods = payYears × 每年期数`（趸交=1，缴费年限未记=未知、按持续续缴提醒）；`nextPayDate = paidUntil + freq 个月`（anniversary 语义，月末钳制；缴费期满/趸交/已终止=null）。
2. **保单状态机**（policyStatus，法定口径）：已退保（surrender 事件晚于最近 reinstate）→ 已终止（手动）→ 已满期（endDate 过境）→ 等待期中（startDate+waitingDays）→ 有效 → 宽限期（nextPayDate 后 graceDays 内，保障仍有效尽快补缴）→ 中止期（宽限期后 2 年内，出险不赔可复效）→ 效力终止。**一年期短险无宽限期**（缴费 1 期且保障期≈1 年判定），到期即满期态。
3. **缴费日历**（paymentCalendar）：未来 N 天应缴清单（含宽限期内逾期单红色置顶）。
4. **四大件缺口矩阵**（gapMatrix）：成员 × [医疗/重疾/寿险/意外] 网格——有效（含等待期/宽限期）保单计数与保额合计，缺格高亮；年金/家财/其他单列信息层。中止期/退保/满期不计入覆盖（如实）。
5. **12 个月保费现金流**（premiumFlow）：在册且缴费期内保单的未来 12 个月逐月应缴分桶 + 年合计。
6. **家庭合计**（familyTotals）：在保单数/年缴保费（freq×每年期数年化）/累计已缴/累计理赔。

## 五、架构（复用 quanfu 已验证范式，纯 kv 零服务）

- `shared/core.js` 纯函数核心（零依赖；sha256 确定性 id）：normalize×3+settings、日期工具（dayKey/parseDayKey/dayDiff/addMonths/addDays/月末钳制/闰年）、缴费进度、状态机、缴费日历、缺口矩阵、现金流、家庭合计、describePolicy、exportAll。
- `mcp/kvclient.js`：端点自发现 + router_dispatch 透传 cap.kv（quanfu 同款实测样板，不改协议）。
- `mcp/server.js`：stdio JSON-RPC，6 工具 `jinkui_today / add(member|policy) / log(pay|claim|endorse|reinstate|surrender) / query(policies|detail|events|calendar|gap|stats) / update / delete`；AI 侧对话式入柜；delete 需 confirm=true。
- `src/` 面板四 Tab：总览（合计卡+缴费红黄榜+等待期+满期榜）/ 保单（过滤+列表+详情+表单）/ 透视（缺口矩阵+现金流+理赔流水）/ 设置（成员管理+参数+导入导出）；数据走 `__POLARIS_HOST_INVOKE__ → router_dispatch → cap.kv`；5s 可见轮询（键集 diff+90s 全量兜底）。
- 图标 `ClipboardList`（保单清单意象，18 白名单内）；order 84；permissions 仅 `appConfigRead + aiToolAccess`。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：日期工具边界（月末钳制/闰年/非法日期）、normalize 边界（kind/freq/枚举拒收、日期矛盾、endReason-endedAt 成对）、缴费进度（趸交/缴费期满/未知缴费年限/补缴推进）、状态机全转移（宽限/中止/复效/退保/满期/等待期/短险无宽限）、缺口矩阵（缺格/中止不计入/保额合计）、现金流分桶、家庭合计年化、describePolicy。
2. `node test/mcp-verify.mjs` 内存桥 spawn 全流程：6 工具、按名自动配成员、判重拒建、状态机投影、confirm 门、连带删、成员删保单拒、清场。
3. `node test/harness-run.mjs` jsdom 渲染：四 Tab 有种子数据渲染不崩、红黄榜/矩阵/合计出现、表单写入内存 kv。
4. `node test/smoke-real.mjs` 真宿主快照式清理冒烟（需 Polaris 运行中）。
5. esbuild 面板自包含 + tsc strict；plugin.json 过 forge_lint；update.json / index.json 三处版本与 sha256 一致后上架。
6. 面板与工具输出均带「只做记录与现状透视，不构成投保建议」口径；无任何产品推荐/保费对比功能。
