# 故人（tether）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> **已实施**：插件仓 commit `a5f1e44`（v0.1.0，已上架 index.json，已装进运行中 Polaris 待重启生效）。
> 实施结果与 spec 的偏差/补充：① 面板实为**六 Tab**（今日/故人/承诺/往来/透视/设置）——透视 Tab 首版遗漏入口，渲染验证时补上；② 真实桥冒烟揪出并修复 `ren_stats` 非法赋值目标 bug（`(map.get(k)=v)` 运行时 SyntaxError）；③ 面板渲染经 mock 桥 harness + IAB 截图验证（写入→落库→失联状态实时重算闭环已过）。
> 验证：core 单测 16/16 · 真实桥冒烟 24/24（跑完自清场）· esbuild build + tsc --noEmit · validate.js 36 插件通过。
> 一句话：把「人」变成可对话的资产——故人档案（关系/生日/渠道/常联系节奏）、往来流水（联系/便签/人情往来）、承诺闭环（我许的/我等的，逾期红黄渐深）、失联预警（按 cadence 的关系衰减榜）、见面简报（见人前一份上下文包）；AI 经 12 个 `ren_*` MCP 工具口语化管理（「我答应小张周五给方案」→立诺、「上周和王总聊了啥」→查流水、「明天见客户张总」→简报），面板六 Tab 跨端可用。

## 1. 目标与动机

生态缺口盘点（36 个已上架插件）：刻漏管时间去哪、算盘管 token 花销、口袋账本管生活账、日晷管日程、谋定管决定、问灶管吃——**没有一个管「人」**。todo 类工具管的是对自己的任务，管不了人际间的两样东西：**承诺**（答应别人的事、等别人兑现的事，没有 deadline 的最容易被忘）和**关系**（多久没联系了、对方生日快到了、上次聊到哪）。通讯录记号码，不记交往；CRM 是销售工具，把人当客户。

本插件把 Polaris 变成一本**人脉与承诺账本**：故人、往来、承诺、预警四本账同源（cap.kv），面板与 AI 双入口消费。定位是「私人」而非「客户管理」——数据最私密，所以**零外联**是设计决策而非偷懒。

## 2. 定位与差异化

- **双向承诺是第一公民**：todo 只有自己的事；这里承诺分「我许的（iowe）/我等的（owedme）」两向，带期限则逾期红、临期黄，闭环（done/cancelled）留痕。「欠人情」「等人回话」这类社会性 open loop 终于有地方落。
- **失联预警可解释**：每人与 `cadenceDays`（想多久联系一次）+ 全局 `driftGraceDays` 宽限；`daysSince = now - 最近一次联系`，超出 cadence 进黄榜、超宽限进红榜，展示「已 N 天未联系（节奏 M 天）」——不是黑盒分数。
- **见面简报（killer tool）**：`ren_prep` 一次给全：档案（怎么认识/渠道/生日临近提示）+ 最近往来（上次聊到哪）+ 未闭环承诺（别答应重复的事）+ 人情天平（gave/got 计数，中性呈现）。
- **口语化记账**：「昨天和张三吃了个饭聊到孩子上学」→ `ren_log` 一笔往来；「我妈生日是腊月…」→ 阳历 v1，农历如实告知边界。
- **人情往来（favor）**：记「帮了他/他帮我」两类事件，透视页按人给计数天平——呈现为往来记录，不折算成钱。
- **零外联架构**：人脉是最私人的数据，插件零网络请求、零后台服务（纯本地 cap.kv），浏览器跨域面为零；面板/MCP 两端共享同一事实库与同一计算核心。

## 3. 架构与跨域决策

| 面层 | 方案 |
|---|---|
| 数据面 | 一切状态走 cap.kv（`tether.*`），面板/MCP 两方共享同一事实库，桌面/手机/Web 三端一致 |
| 网络面 | **零外联**：无服务贡献、无 fetch——个人关系数据不出设备，天然无跨域/CSP/SSRF 面 |
| 面板通道 | 面板**零直连 fetch**：宿主 `__POLARIS_HOST_INVOKE__` → `router_dispatch` → cap.kv（与口袋账本同款，esbuild 打包 shared core） |
| 策略计算 | `shared/tether-core.js` 唯一权威：键常量、归一化、模糊找人、失联分级、生日推算、承诺分期、往来趋势、简报组装——面板（esbuild 打包进 bundle）/MCP 两方 require 同一份 |

```
面板（跨端）                      MCP（AI）
  │ cap.kv 直读写（四单对象）       │ cap.kv 直读写
  │ 8s 轮询 + visibility 重取       │ 12 个 ren_* 工具
  └──────────── 同一 tether-core ─────────────┘
  journal 为双写者追加（读-改-写非加锁，尽力而为，与问灶 history 同一边界）
```

## 4. 键空间契约（权威，两方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `tether.settings` | 面板/MCP 写 | `{v:1, defaultCadenceDays:7..365:30, driftGraceDays:3..90:14, birthdayDays:1..90:14, dueWarnDays:1..30:3}` |
| `tether.people` | 面板/MCP 写（单对象原子换写） | `{v:1, order:[id], byId:{id:Person}}`；上限 500 人；Person=`{id,name(≤40),alias?(≤40),relation∈家人/伴侣/朋友/同事/客户/导师/同学/其他,tags[](≤8×12),howMet?(≤200),birthday?('MM-DD'\|'YYYY-MM-DD'),contacts:{phone?,wechat?,email?,other?}(各≤80),cadenceDays?(7..365\|null→默认),note?(≤500),pinned?,archivedAt?,createdAt,updatedAt}` |
| `tether.promises` | 面板/MCP 写 | `{v:1, byId:{id:Promise}}`；Promise=`{id,personId,direction∈iowe/owedme,text(≤200),createdAt,due?('YYYY-MM-DD'),status∈open/done/cancelled,closedAt?,closeNote?(≤200)}`；open 上限 200、闭环存档上限 500（超出裁最旧闭环） |
| `tether.journal` | 面板/MCP 追加（尽力而为） | `{v:1, events:[{id,at,personId,type∈contact/note/favor,channel?(contact:见面/电话/微信/视频/邮件/其他),direction?(favor:gave/got),text(≤300)}]}`，FIFO cap 2000（保最新） |

**已知边界（如实交代）**：`journal` 为多写者追加（面板与 MCP 都可能记往来），读-改-写非加锁，双端同刻并发可能丢一条事件——往来流水允许尽力而为；核心状态（档案/承诺/设置）各为单对象整体换写，kv set 单命令原子，无 torn write。生日 v1 仅阳历（`MM-DD` 或 `YYYY-MM-DD`，2月29日平年回退 3月1日），农历生日暂不支持。

## 5. 策略引擎（shared/tether-core.js）

- **归一化** `normalizePerson/normalizeEvent/normalizePromise/normalizeSettings`：越界钳制、非法回错误、文本截断、枚举收编（关系/channel/direction/status），非法 `birthday` 拒收（正则 + 真实日历校验）。
- **模糊找人** `findPerson(name, people)`：名/备注精确 → 名+备注唯一包含（≥2 字符防误伤）→ 多命中返回 `{ambiguous}` 列表交 AI 澄清。
- **失联分级** `driftList(people, events, settings, now)`：`lastAt` = 该人最近 `contact` 事件（无事件回退 `createdAt`）；`overdue = daysSince - cadence`；`overdue<=0` ok、`<=grace` warn、`>grace` lost；归档者剔除；输出含可解释文案与 overdueDays 排序。
- **生日推算** `nextBirthday(person, now)`：yearly 循环取下一个（今天=0 天），`MM-DD` 无年龄、`YYYY-MM-DD` 带将到年龄；平年 02-29 → 03-01。
- **承诺视图** `promiseBoard(promises, people, now, settings)`：open 按 `overdue（due<today，红）→ dueSoon（≤dueWarnDays，黄）→ 有期限其余 → 无期限` 分组；闭环单独列出；附带人员名解析。
- **往来趋势** `contactTrend(events, months=12, now)`：按月联系事件计数（近 N 月序列，供柱状图）；`favorBalance(events)` 按人 gave/got 计数。
- **见面简报** `personPack(person, events, promises, now, settings)`：档案段 + 最近 5 笔往来（倒序）+ 未闭环承诺（双向，带期限状态）+ 人情计数 + 失联/生日临近提示行。
- **日期输入** `resolveDateInput(input, now)`：`today/yesterday/今天/昨天/YYYY-MM-DD` → epoch（补记用），非法返回 null。

## 6. MCP 工具（12 个，AI 侧契约）

| 工具 | 入参（摘要） | 语义 |
|---|---|---|
| `ren_overview` | — | 今日人情速览：逾期/临期承诺 + 生日 + 失联 top3 + 汇总，对话入口 |
| `ren_person_save` | `{id?/name, alias?, relation?, tags?, howMet?, birthday?, contacts?, cadenceDays?, note?}` | 建档/upsert（id 或精确名=改，否则新建） |
| `ren_person_list` | `{query?, relation?, tag?, archived?:'no'\|'only'\|'include'}` | 检索档案，附最近联系与失联态 |
| `ren_person_remove` | `{id/name, confirm:true}` | 删档（级联其承诺+往来，须确认） |
| `ren_log` | `{personId/name, type?, channel?, direction?, text, date?}` | 记一笔往来（联系/便签/人情），AI 从口语解析 |
| `ren_journal` | `{personId?, keyword?, type?, days?, limit?}` | 查往来流水（「上周和张三聊了啥」） |
| `ren_promises` | `{action:list/add/close/cancel/reopen, personId?/name?, direction?, text?, due?, id?, note?}` | 承诺全操作 |
| `ren_drift` | `{level?:'warn'\|'lost', limit?}` | 失联预警榜（可解释：N 天未联系/节奏 M 天） |
| `ren_birthdays` | `{days?}` | 未来 N 天生日（含年龄与今天提醒） |
| `ren_prep` | `{personId/name}` | 见面简报（档案+最近往来+未闭环承诺+人情天平） |
| `ren_stats` | — | 人情透视：关系分组、联系趋势、favor 天平、承诺构成 |
| `ren_settings` | `{action:get/update, ...patch}` | 节奏参数读写 |

AI 工作流约定（写进工具 description）：提人先 `ren_person_list`（找不到再问用户是否建档）；口语记往来→`ren_log`；承诺先确认方向与期限再 `ren_promises add`；「要见谁」→`ren_prep`；收尾建议用 `ren_overview` 收束。

## 7. 面板（五 Tab + 头部）

- **今日**：逾期承诺卡（红，一键闭环）→ 临期承诺（黄）→ 临期/今日生日（含年龄）→ 失联预警 top5（一键「记一笔」）；头部速览（故人数/待闭环/预警数）。
- **故人**：搜索 + 关系筛选 chips + 已归档开关；花名册（首字头像按关系配色、别名、最近联系「N 天前/从未」、失联徽标、置顶）；详情抽屉（档案字段、最近往来时间线、未闭环承诺、记联系/记人情/写便签/加承诺/编辑/归档/删除入口）。
- **承诺**：方向 chips（全部/我许的/我等的/已闭环）；新增表单（选人+方向+内容+期限）；行内逾期红/临期黄/无期限灰，闭环/取消/重开按钮。
- **往来**：全局流水按日分组（今天/昨天/日期），类型筛选 + 关键词；顶部记一笔表单。
- **设置**：节奏四参数；导出全部数据（JSON 下载）；清空全部数据（二次确认）；边界说明（生日阳历、journal 尽力而为）。

样式沿用主题暗色 token 风格（与口袋账本面板同族 CSS 变量体系，青瓷绿主色区分），入口 `activityBar` icon=`Users`（白名单 18 值内）、`order:84`、`panelType:'tether'`、`labelKey:'plugins.tether'`。

## 8. 验收

- [ ] `node test/run-tests.mjs` 全绿（归一化/模糊找人/失联分级边界/生日推算含 02-29/承诺分期/趋势/favor 天平/简报组装/日期输入/设置钳制/journal FIFO 裁剪）
- [ ] 真机冒烟 `node test/smoke-real.mjs`（9829 router-dispatch）：建档→记往来→立诺→速览→预警→简报→闭环→删档级联，全程真实 MCP + 真实 kv，跑完清场
- [ ] `npm run build`（esbuild）+ `npm run typecheck`（tsc --noEmit）通过
- [ ] `node scripts/validate.js` 索引校验通过；icon/order/labelKey 合规；zip 产出且 index.json sha256 一致
- [ ] 面板与 MCP 零直连外网 fetch（代码评审断言）；无 services 贡献
