# 问津 wenjin —— 求职投递与面试作战台账插件 spec

> 状态：已定案，实施于插件仓 `plugins/wenjin`。
> 选型背景：2026-10-29 会话。青囊（家庭用药）与车辖（车辆台账）已由并行会话占位，本插件按生态域图另选无撞车的高价值空位。**求职域在 46 插件中零占位**，与 tether（人脉承诺）、常契/守闸（订阅钱契）、观止（书影音）、谋定（决策）均无域交叠——求职的核心是「投递管道 × 简历版本归因 × 面试复盘 × offer 结构对比」，四者都不是现有插件的模型。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **中文场景已验证**：知乎/人人都是产品经理/牛客均确认「海投 → 已读不回 → 焦虑 → 更多海投」恶性循环；投递一多「公司、岗位、JD、简历版本、面试时间、HR 联系方式全混在一起，表格忘记更新、难以复盘」（知乎 2032189120999638821）。
- **海外付费墙证明支付意愿**：Huntr 免费版限 ~100 张卡片、AI 功能 Pro（约 $5–40/mo）；Teal 追踪免费但 AI（匹配分/改写）锁在 Teal+（$29/mo）；r/jobsearch 长期存在「spreadsheet chaos」帖，免费模板「很快失控」。
- **开源真空**：GitHub 求职追踪器均为玩具级（XML 存储/MERN 教程/弃坑），无维护良好的本地优先+AI 方案；「privacy-first job tracker」还停留在 dev.to 文章。
- **隐私是真痛点**：在职找工作的人把投递记录放到别人服务器上是真实风险；本地优先是可辩护差异（对比 Huntr/Teal/求职方舟 AI 全部云端注册登录）。
- **桌面与 AI 强关联**：JD/简历/面试复盘全是长文本，桌面大屏编辑 + AI 对话式录入归因是形态优势；手机浏览器打开同一面板可在面试路上查时间地点。
- **未验证假设（如实）**：简历版本×回复率的归因分析是本插件的独特卖点，但「用户愿意按版本管理投递」是推断；MVP 以「简历版本可选填」降低门槛，让漏斗自然形成。

## 二、产品定义

- **名称**：问津（wenjin）——使子路问津（《论语·微子》），津者渡口也；「无人问津」的反面：每一份投递都有账可查。
- **一句话**：把「投了哪些公司、谁有回音、简历哪个版本有效、offer 怎么比」变成可对话、会提醒跟进的求职作战台账。
- **目标用户**：正在投递的求职者（在职看机会/裸辞冲刺/应届校招）；一次管理 10–100+ 投递的人；在意求职隐私、不想把记录放云端的人。
- **核心场景**：① 聊天里说「投了字节的前端岗，BOSS 上投的，JD 是……」→ AI 建档并把 JD 存档；② 「字节二面过了」→ 自动记事件、推进状态、可挂提醒；③ 面板「今日」看到哪些投递该跟进了、最近面试日程；④ 「投了 60 份有多少回音」→ 渠道漏斗与简历版本漏斗；⑤ 两个 offer 摆在一起按年化包+通勤比。
- **独有价值**：简历版本归因漏斗（哪版简历回复率高——Huntr/Teal 未做）× 事件线时间轴（进展即账本）× 跟进到期检测（N 天无进展主动点名）× offer 结构化年化对比 × 纯本地零账号 × AI 对话式 × 桌面手机同看。
- **安全边界（硬约束）**：只做记录、派生与提醒；**不做**招聘平台抓取、自动投递、「ATS 通过率」评分承诺；offer 对比与洞察不构成职业建议（README/面板/MCP 三处明示）。

## 三、数据模型（cap.kv 键空间 `wenjin.*`）

| 键 | 写者 | 内容 |
|---|---|---|
| `wenjin.company.<id>` | 面板/MCP | 公司 `{id,name,industry?,note?}` |
| `wenjin.app.<id>` | 面板/MCP | 投递 `{id,companyId,companyName,title,channel,status,jd?,salaryPosted?,location?,resumeId?,appliedAt?,archived,note?,createdAt,updatedAt}` |
| `wenjin.resume.<id>` | 面板/MCP | 简历版本 `{id,label,content?,note?,createdAt}` |
| `wenjin.event.<id>` | 面板/MCP | 事件 `{id,appId,type:'applied'\|'screen'\|'written'\|'interview'\|'offer'\|'result'\|'note',at,title?,detail?,questions?,outcome?,remindAt?,createdAt}` |
| `wenjin.offer.<id>` | 面板/MCP | offer `{id,appId,baseMonthly,months,bonusMonths,commuteMin?,remoteDays?,stockNote?,deadline?,note?,createdAt}` |
| `wenjin.settings` | 面板 | `{schemaVersion,followUpDays,remindLeadHours}` |
| `wenjin.meta` | **仅服务工具层** | 心跳（MCP/面板操作时顺带刷新） |

- **状态机**（app.status，事件联动 + 面板可改）：`wish 想投 → applied 已投 → screening 沟通中 → written 笔试 → interview 面试中 → offered 已有 offer → accepted 已接受`；终态 `rejected 被拒 / withdrawn 主动放弃`。**「无回音」不设状态**——由跟进检测派生，避免状态双写语义。
- **跟进到期（纯派生）**：status ∈ {applied,screening,written} 且最后事件时间距今不早于 followUpDays（含恰好第 N 天）→ 到期名单，展示「已 N 天无进展」；无事件回退 appliedAt/createdAt。
- **id 稳定规则**：`idFor(seed)=sha256(seed) 前 12 位`（company 按 normalize(name)；app 按 companyId|normalizeTitle；resume 按 normalize(label)；offer 按 appId（每投递一份 offer 档案，重复添加=更新）；event 按 appId|type|at(分钟精度)|detail 前 80 字——同刻同型同文幂等）。按名 find-or-create，天然幂等无并发双写。

## 四、核心派生（纯函数，shared/core.js 面板/MCP 同源）

1. **管道投影** `pipeline()`：状态计数 + 活跃列表排序（在投/面试中在前）。
2. **跟进检测** `followUps()`：到期投递列表，附 daysSinceLast。
3. **近期日程** `upcoming()`：event.remindAt / 事件时间在未来 remindLeadHours 内的面试/笔试列表。
4. **漏斗** `funnelBy(field)`：每投递判定 submitted/responded/interviewed/offered 四级，按渠道与按简历版本分组计数+转化率；样本 <5 时只出计数不出百分比（诚实口径）。
5. **offer 年化** `offerCompare()`：`annual = baseMonthly×(months+bonusMonths)`；年通勤小时 `commuteMin×2×250÷60`；按 annual 降序 + 与最优差额；期权/股票只记文本不计价。
6. **复盘问题库** `questionBank()`：event.questions 聚合去重计数 + 来源公司。
7. **CSV 导出/导入**：导出 applications.csv（公司/职位/渠道/状态/投递时间/最新进展/薪资/地点/简历/备注）；导入按 公司+职位 判重跳过，未知渠道→其他、未知状态→已投并在结果中报告。

## 五、架构（复用平台已验证范式，同 changqi/guanzhi 零服务样板）

- `shared/core.js` 纯函数核心（零依赖；内含 sha256 定 id）：normalize×5+settings、pipeline、followUps、upcoming、funnelBy、offerCompare、questionBank、CSV/JSON 导出导入、describeStatus。
- **零后台服务、零外网请求**：提醒是打开面板/调用 today 时的投影，不需要常驻进程（无推送通道，服务进程无法主动触达面板）；与 changqi/guanzhi 同型，减少故障面。
- `mcp/server.js`：stdio JSON-RPC，7 工具 `wenjin_today / add_app / log_event / add_offer / query / update / delete`；事件驱动状态联动（offer 事件→offered，result:fail→rejected）；appRef 支持 appId 或 公司+标题 定位。
- `src/` 面板四 Tab：今日（状态分布+跟进到期+近期日程）/ 投递（过滤列表+详情抽屉：时间线+JD+快记进展）/ 洞察（渠道漏斗+简历版本漏斗+复盘问题库+offer 对比）/ 设置（公司库+简历库+参数+导入导出）；数据走 `__POLARIS_HOST_INVOKE__ → router_dispatch → cap.kv`；15s 轮询可见时启用；无提示音（求职提醒非秒级时效）。
- 图标 `GitPullRequest`（投递→评审→合并的管道意象，白名单内且未占用）；order 71。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：normalize 边界（空名拒绝/公司名归一）、状态机联动、跟进到期（含边界=恰好 N 天）、漏斗四级归因（含 wish 不计入）、offer 年化与差额、问题库去重、CSV 导入判重与未知值降级。
2. `node test/mcp-verify.mjs` 内存桥全流程：校验拒绝→建档→事件推进→状态联动→跟进到期（时钟注入）→offer 年化→query→update→删除确认门。
3. 真实宿主冒烟 `smoke-real.mjs`（快照式清理）：真桥全链路。
4. 面板 harness 交互验证；esbuild 自包含 + tsc strict；plugin.json / update.json / index.json 三处版本与 sha256 一致。
5. 免责声明三处落地：不出现抓取/自动投递/ATS 通过率类功能与话术。
