# 青囊 qingnang —— 家庭用药与药箱管家插件 spec

> 状态：已实施，插件仓提交 `58c8fa1`（plugins/qingnang，v0.1.0，已入 index.json）。
> 选型依据：市场调研（2026-10）+ Polaris 插件生态领域地图（健康/用药域零占位）。

## 一、产品机会（证据摘要）

- **市场已验证到千万用户级**：Medisafe 10M+ / MyTherapy 12M+ 用户；Apple Health 内置用药（iOS16+）为最大隐形竞品但无库存/续药。
- **WHO 锚点**：慢性病长期治疗依从率仅 ~50%（WHO 2003《Adherence to Long-Term Therapies》，20 年未改善）。
- **付费墙出走潮**：Medisafe 2024-12 起免费版限 2 种药、2026 转订阅；r/androidapps 用户集体求替代，明确要 "work offline, no signups"。
- **全球产品空白**：「家庭药箱维度」（全家药单 × 库存 × 效期 × 补货）无任何主流产品覆盖——现有 App 全部只算「这盒药还剩几粒」单处方维度。需求侧硬数据：83.7% 受访者囤药、87.8% 家庭从不清理小药箱、全国年产过期药约 1.5 万吨。
- **桌面端空白**：桌面用药管理几无规模玩家；家庭药箱是多字段表格型管理=桌面强项、手机弱项。家庭常开电脑是提醒的冗余第二通道（不受手机厂商杀后台影响，dontkillmyapp.com 收录的行业级痛点）。
- **照护客群付费意愿最强**：r/eldercare、r/AgingParents 子女远程管理父母用药是高频主题。
- **生态空位**：Polaris 已有 43 插件，账本类（常契/守闸/观止/算盘/口袋账本）、时间类（日晷/刻漏）、记忆类（熔炉/灵犀）均有人占位；**健康/用药为零**，且与日晷（日程提醒）无域撞车——药事的对象是「药×人×库存×效期」，日晷是「事件×时间」。

## 二、产品定义

- **名称**：青囊（qingnang）——华佗青囊，医者所携药囊。
- **一句话**：把「谁该吃什么药、家里还剩什么药、哪盒快过期」变成可对话、会主动提醒的家庭健康资产。
- **目标用户**：有慢性病长期用药者本人；为父母/伴侣/孩子管药的家庭照护者；有囤药习惯、担心过期浪费的家庭。
- **核心场景**：① 早晚打开 Polaris 看今天全家药单、一键打卡；② 对 AI 说「我妈每天早晚各一片氨氯地平」一句话建档；③ 药箱页看库存还能吃几天、哪些药快过期、该买什么；④ 聊天里问「布洛芬过期没」「今天还有谁要吃药」。
- **独有价值**：家庭多成员档案 × 共享实体药箱库存（FEFO 先到期先用派生）× 效期红黄榜 × 补货预测 × AI 对话式 × 本地存储健康数据不出设备 × 三端同读（手机浏览器打开同一面板打卡）。
- **安全边界（硬约束）**：只做药事记录与提醒，**不做**医疗建议、相互作用检查、剂量推荐；README/面板/MCP 三处明示免责。

## 三、数据模型（cap.kv 键空间 `qingnang.*`）

| 键 | 写者 | 内容 |
|---|---|---|
| `qingnang.profile.<id>` | 面板/MCP | 成员档案 `{id,name,kind:'human'\|'pet',note}` |
| `qingnang.med.<id>` | 面板/MCP | 药品 `{id,name,spec,form,unit,note}` |
| `qingnang.batch.<id>` | 面板/MCP | 批次 `{id,medId,qty,expiry:'YYYY-MM-DD',note}`（多盒囤货各一批次） |
| `qingnang.reg.<id>` | 面板/MCP | 用药方案 `{id,profileId,medId,dose,times:['08:00'],freq:{type:'daily'\|'weekly'\|'interval'\|'cycle'\|'prn',weekdays?,intervalDays?,onDays?,offDays?},startDate,endDate?,active,note}` |
| `qingnang.log.<regId\|date\|time>` | 面板/MCP | 服药记录 `{status:'taken'\|'skip',amount,at}`（occKey 幂等） |
| `qingnang.settings` | 面板 | `{graceMin,lowDays,expiryWarnDays,soundOn}` |
| `qingnang.doses` | **仅服务** | 今日应服投影 `{at,date,items:[{occKey,profileId,profileName,medId,medName,amount,unit,time,dueAt,state:'now'\|'overdue'}]}` |
| `qingnang.meta` | **仅服务** | 心跳 |

**库存为纯派生**（单一事实=批次+打卡记录，无可写库存键，天然幂等无并发写）：
`remaining(med) = Σ batch.qty − FEFO消耗(taken 打卡按时序归因到最早到期批次)`；过期批次不计入可用量，单列「待清理」。修正口径=盘点后编辑批次 qty。

## 四、架构（复用平台已验证范式，同 sundial/guanzhi）

- `shared/core.js` 纯函数核心（面板/MCP/服务三方同源）：normalize×4、occurrencesForDate、FEFO stockFor、consumptionRate、refillForecast、expiryBands、adherence、todayPlan、describeFreq。
- `service/qingnang.js` 后台服务（type=http + /__health，PluginServiceManager 托管）：tick 重算今日应服投影、心跳、过期批次扫描；**零外网请求**。
- `service/kvclient.js`：端点自发现 + router_dispatch 透传 cap.kv（clip-relay/page-sentinel 实测样板，勿改协议）。
- `mcp/server.js`：stdio JSON-RPC，6 工具 `qingnang_today / add / log / query / update / delete`，AI 侧对话式建档记账。
- `src/` 面板：今日 / 药箱 / 方案 / 设置 四 Tab；数据走 `__POLARIS_HOST_INVOKE__ → router_dispatch → cap.kv`；到期应服 WebAudio 提示音（同日晷）；5s 轮询可见时启用。
- 图标 `Activity`（白名单内）；order 76（挨着日晷 78）。

## 五、验收

1. `node test/run-tests.mjs` 离线单测全绿：freq 四型展开（含跨月/闰年/吃停周期）、FEFO 归因（跨批次/过期剔除）、补货预测回落口径、依从率、normalize 边界、occKey 幂等。
2. 真实宿主冒烟：服务拉起有心跳；MCP 建档→打卡→库存派生→今日投影全链路；面板四 Tab 可用。
3. esbuild 面板构建自包含；plugin.json / update.json / index.json 三处版本与 sha256 一致。
4. 免责声明三处落地；不出现任何「建议用量/相互作用」类输出。
