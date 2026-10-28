# 车辖 chexia —— 家庭车辆养护与补能账本插件 spec

> 状态：已定案，实施于插件仓 `plugins/chexia`。
> 选型背景：2026-10-29 会话。原定方向「青囊（家庭用药）」检测到并行会话正在实施中（plugins/qingnang 由另一会话写核心/服务/MCP），**主动让域**，按生态域图另选无撞车的高价值空位。车辆域在 46 插件中零占位，与日晷（纯时间事件）、常契/守闸（订阅钱契）、算盘/口袋账本（消费记账）均无域交叠——车务的核心是「里程驱动的周期 + 法定证件到期 + 补能流水」，三者都不是现有插件的模型。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **法定周期是硬触点**：年检逾期补审罚 200 元、路上查处 20–200 元罚款；交强险脱保上路罚 **2 倍保费 + 扣车**，且脱保期间年检不予受理（检索核验）。证件/年检/保险到期是「忘一次就亏钱」的法定刚需。
- **盘子足够大**：公安部口径 2025 年底汽车保有量 **3.66 亿辆**、新能源 **4397 万辆**；新注册登记连续 11 年超 3000 万辆。
- **竞品付费墙化 + 口径僵硬（已核验的真实吐槽）**：小熊油耗已转会员付费（免广告=付费，App Store 评价区可查）；「必须两次加满油才能算油耗」是其评价区明确吐槽——**期间口径**（Σ补能量 ÷ 里程差）天然支持加半箱/充到 80%，是可辩护的差异化。
- **桌面/家庭共享真空（代理证据）**：模板站「汽车保养记录 Excel」有 73–469 个模板在售——桌面表格是真实存量习惯，但 Excel 无提醒、无统计、无多端；手机养车 App 全部单人视角，家庭两口子共车各加油时「账在我手机上」无解，三端同读正是 Polaris 面板的强项。
- **未验证假设（如实）**：「4S 店把保养提醒当获客线索、车主反感」只找到零散投诉帖，未构成系统性证据——本插件以「本地零账号零广告」为隐私卖点，但该卖点的市场强度是推断不是实证。

## 二、产品定义

- **名称**：车辖（chexia）——辖者，车轴之键也（《左传》「抽其车辖」）；一枚小销钉管住全车大事小情。
- **一句话**：把「车该保养了吗、保险年检什么时候到期、这车百公里多少钱」变成可对话、会主动提醒的家庭车辆档案。
- **目标用户**：家庭用车场景（一家多车 / 夫妻共车）；油车+电车混用家庭；想自己掌握养车节奏、反感提醒式营销的车主。
- **核心场景**：① 加完油对 AI 说「刚加油 350 块 42.3 升，里程 45230」→ 自动算期间油耗、刷新保养里程倒计时；② 面板看每辆车的养护进度条 + 证件红黄榜 + 每公里成本；③ 聊天问「交强险什么时候到期」「这车百公里多少钱」「机油该换了吗」；④ 手机浏览器打开同一面板，家人互相代记补能。
- **独有价值**：期间口径油耗/电耗（不要求加满）× 里程驱动养护预测（从补能里程序列推日均里程 → 保养里程点倒计时）× 家庭多车多成员共享 × 证件红黄榜 × 费用透视（元/公里、月度分项）× 纯本地零账号 × 对话式。
- **安全边界（硬约束）**：只做车务记录与提醒，**不做**违章查询、车辆估值、OBD 硬件接入、云端同步、保养商家推荐。

## 三、数据模型（cap.kv 键空间 `chexia.*`）

| 键 | 写者 | 内容 |
|---|---|---|
| `chexia.car.<id>` | 面板/MCP | 车辆 `{id,name,kind:'fuel'\|'ev'\|'phev',plate?,initialOdometer,note}` |
| `chexia.energy.<id>` | 面板/MCP | 补能 `{id,carId,date,odometer(≥initialOdometer),amount(L/kWh>0),cost(元≥0),filled,station?,note,at}`（odometer 必填，油耗/电耗的生命线） |
| `chexia.item.<id>` | 面板/MCP | 养护项 `{id,carId,name,cycle:{kmInterval?,monthInterval?}至少其一,lastOdometer?,lastDate?,active,note}` |
| `chexia.svc.<id>` | 面板/MCP | 维保记录 `{id,carId,date,odometer?,type:'maintenance'\|'repair'\|'inspection'\|'insurance'\|'other',desc,cost?,vendor?,note}` |
| `chexia.doc.<id>` | 面板/MCP | 证件 `{id,carId?(空=个人证件如驾驶证),type:'交强险'\|'商业险'\|'年检'\|'驾驶证'\|'行驶证'\|自定义,expiry:'YYYY-MM-DD',remindDays?,note}` |
| `chexia.settings` | 面板 | `{docWarnDays,itemWatchKm,itemWatchDays,costWindowDays}` |
| `chexia.snapshot` | **仅服务** | 全家车辆派生快照（里程/日均里程/期间能耗/元每公里/养护状态/证件榜/月度费用） |
| `chexia.meta` | **仅服务** | 心跳 |

id 稳定规则：`idFor(seed)=sha256(seed) 前 12 位`——车辆按 `车名`、养护项按 `carId|name` 定 id，按名 find-or-create 幂等（同 qingnang）。

## 四、核心派生（纯函数，shared/core.js 三方同源）

1. **期间口径能耗**：`per100 = Σamount / (末里程 − 首里程) × 100`，窗口内全部记录不分加满与否；`kmSpan < 30km` 时拒绝出数（诚实标记），输出注明「首尾存量相近时更准」。
2. **日均里程**：窗口内（maxOdo − 窗口首 odo）/ 跨越天数；无记录回落 (odo−initialOdometer)/建档天数；再无则 null。
3. **养护项投影**：km 轴 `dueKm=lastOdometer+kmInterval`、`kmLeft=dueKm−currentOdo`、`daysLeft=kmLeft/日均里程`；时间轴 `dueDate=lastDate+monthInterval`（月加法钳制月末）、`daysLeftDate`；双周期取**更紧者**；状态 overdue/due/watch/ok。
4. **证件红黄榜**：expired / soon(≤remindDays) / ok，按 expiry 升序。
5. **费用透视**：窗口内补能+维保按月分桶、按类型小计、`costPerKm=Σcost/Δkm`。

## 五、架构（复用平台已验证范式，同 sundial/qingnang）

- `shared/core.js` 纯函数核心（零依赖；sha256 用于确定性 id）：normalize×5+settings、期间能耗、日均里程、养护投影、证件榜、费用透视、describeItem、exportAll。
- `service/chexia.js` 后台服务（type=http + /__health）：tick 重算全家快照写 `chexia.snapshot`（内容不变不写）、心跳、15s 实体缓存 + 增量日志；**零外网请求**。
- `service/kvclient.js`：端点自发现 + router_dispatch 透传 cap.kv（sundial/qingnang 同款实测样板，勿改协议）。
- `mcp/server.js`：stdio JSON-RPC，6 工具 `chexia_today / add(car\|item\|doc) / log(energy\|svc) / query / update / delete`；AI 侧对话式记账；energy 的 odometer 必填护栏。
- `src/` 面板四 Tab：概览（车辆卡片+证件红黄榜+养护进度）/ 补能（流水+口径说明+分车统计）/ 车务（养护项+维保记录+证件管理）/ 设置（车辆+参数+数据）；数据走 `__POLARIS_HOST_INVOKE__ → router_dispatch → cap.kv`；15s 轮询可见时启用。
- 图标 `Target`（仪表盘意象，白名单内）；order 79（挨着日晷 78）。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：normalize 边界（里程回退/负数/缺 odometer 拒绝）、期间口径（含加不满/里程差过小拒绝出数）、日均里程回落链、养护投影（km/时间/双周期取紧、月加法月末钳制、闰年）、证件榜、费用透视、describeItem。
2. `node test/mcp-verify.mjs` 内存桥全流程：建档→立养护项→补能→油耗出数→维保联动锚点→证件榜→更新→删除确认门。
3. 真实宿主冒烟 `smoke-real.mjs`（快照式清理）：真桥全链路。
4. esbuild 面板自包含 + tsc strict；plugin.json / update.json / index.json 三处版本与 sha256 一致。
5. 面板与工具输出均带「只做记录，不构成维修/保险建议」口径；无任何商家推荐/违章查询类功能。
