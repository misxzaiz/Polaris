# 问灶（ask-stove）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> 一句话：把「冰箱里有啥、今晚吃啥、周末买啥」变成可对话的资产——食材库存（五分区+临期红榜）、菜谱库（URL 一键导入/手动/AI 抽取）、本周计划、采购清单（计划缺料一键补齐+超市动线分类）、浪费透视；AI 经 12 个 `stove_*` MCP 工具口语化管理（「买了两斤排骨」→入库、「今晚 20 分钟能做啥」→带理由推荐），面板五 Tab 跨端可用。

## 1. 目标与动机

生态缺口盘点（30+ 已上架插件）：刻漏管时间去哪、算盘管 token 花销、日晷管日程、琥珀管网页、订阅雷达管资讯——**没有一个回答「吃」**。「今晚吃什么」是每天发生的决策负担；冰箱里的菜买回来忘了吃、过期扔掉是真金白银的浪费（与算盘「漏钱透视」同一哲学，搬到食材域）。现有美食 App（下厨房/Whisk）不做本地库存联动、不做对话式管理、不跨端同步到自建生态。

本插件把 Polaris 变成一台**灶房管家**：库存、菜谱、计划、采购、浪费五本账同源（cap.kv），面板与 AI 双入口消费。

## 2. 定位与差异化

- **口语化记账是第一公民**：用户对 AI 说「买了两斤排骨一把小葱，周末前吃完」，AI 解析后调 `stove_pantry_add`；说「番茄用掉了」调 `stove_pantry_consume`。面板只是这份数据的图形视图——这是纯美食 App 做不到的。
- **菜谱导入根治跨域**：菜谱站多反爬/跨域，面板浏览器侧 fetch 必挂；导入走 **cmd 命令邮箱 → 后台服务原生 fetch**（Node 无同源策略），配 SSRF 守卫（只放行公网 http(s)，拒绝环回/内网/链路本地/云元数据）、8s 超时、2MB 体量上限、正文清洗后限 8KB。抓回的正文给 AI 抽取结构化菜谱（`stove_recipe_save` 落库），面板也可「填入手动表单」。
- **同名不同叫法不打架**：内置常见同义词组（番茄/西红柿、土豆/马铃薯、鸡蛋/鸡蛋…30 组）+ 归一化（全角→半角、小写、去空白、去括注），库存与菜谱用料按归一名匹配——「冰箱有西红柿、菜谱要番茄」能对上。
- **灶签可解释**：每日推荐不是黑盒——评分引擎（shared core 确定性计算 + 日期种子抖动）输出理由：「清掉临期的番茄」「缺 2 样料」「30 分钟内搞定」「最近做过，换个口」。
- **采购按超市动线**：计划缺料一键补齐后，清单按 蔬果→肉蛋→水产→主食→调味→其他 分组，手机 PWA 里边逛边勾。
- **浪费诚实记账**：消耗分「吃了/扔了」两种去向，透视页给出浪费率、最常扔的食材、12 周趋势——把「下次少买点」变成有数据的话。

## 3. 架构与跨域决策

| 面层 | 方案 |
|---|---|
| 数据面 | 一切状态走 cap.kv（`stove.*`），面板/MCP/服务三方共享同一事实库，桌面/Web/手机三端一致 |
| 网络面 | 唯一外联点=后台服务原生 fetch（菜谱导入）；浏览器 CORS/CSP 面为零 |
| 面板通道 | 面板**零直连 fetch**：宿主 `__POLARIS_HOST_INVOKE__` → `router_dispatch` → cap.kv；长操作走 cmd/result 命令邮箱（与网哨/数据方舟同款） |
| 策略计算 | `shared/stove-core.js` 唯一权威：键常量、归一化、匹配、临期、推荐评分、采购聚合、浪费统计——面板（esbuild 打包进 bundle）/MCP/服务三方 require 同一份 |

```
面板（跨端）                    MCP（AI）                     服务（Node http，唯一外联点）
  │ cap.kv 直读写（小对象）       │ cap.kv 直读写                 │ 心跳 stove.meta（60s）
  │ cmd.fetch.<n> 写入 ──────────┼─ cmd.fetch.<n> 写入 ────────▶ │ 消费命令键（先删后做）
  │ ◀轮询 stove.result.<n> ──────┼─ ◀stove.result.<n> ────────── │ SSRF 守卫→原生 fetch→正文清洗
  │                              │                              │ 孤儿 result >15min 清扫
```

## 4. 键空间契约（权威，三方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `stove.settings` | 面板/MCP 写 | `{v:1, expiringDays:1..30:5, suggestCount:1..10:3}` |
| `stove.pantry` | 面板/MCP 写（单对象原子换写） | `{v:1, items:[{id,name,qty:number\|null,unit,location,expiresAt:ms\|null,addedAt,updatedAt,note?}]}`，location ∈ `fridge/freezer/dry/condiment/other` |
| `stove.recipes` | 面板/MCP 写 | `{v:1, order:[id], byId:{id:{id,name,minutes,tags:[],ingredients:[{name,qty?,unit?}],steps:[],url?,source:'manual'\|'import'\|'ai',createdAt}}}`，上限 200 条、单条 steps 每条 ≤500 字 |
| `stove.plan` | 面板/MCP 写 | `{v:1, days:{'YYYY-MM-DD':{recipeId?\|null,note?\|null}}}`，写时裁剪保留今天±56 天 |
| `stove.shopping` | 面板/MCP 写 | `{v:1, items:[{id,name,qty?,unit?,category,done,addedAt,fromPlan?}]}`，category ∈ `veg/meat/seafood/staple/condiment/other` |
| `stove.history` | 动作方追加（尽力而为） | `{v:1, events:[{at,type:'add'\|'cook'\|'consume'\|'discard',name,qty?,unit?,recipeId?}]}`，FIFO cap 800 |
| `stove.meta` | 服务写（60s） | 心跳 `{v,pid,startedAt,lastTickAt,version,bridge}` |
| `stove.cmd.fetch.<nonce>` | 面板/MCP 写，服务消费=**先删后做** | `{action:'fetch_url', url, at}` |
| `stove.result.<nonce>` | 服务写，请求方读后删（孤儿 >15min 服务清扫） | `{ok, at, payload?:{title,text,url}, error?}` |

**已知边界（如实交代）**：`history` 为多写者追加（面板与 MCP 都可能消耗食材），读-改-写非加锁，双端同时动作可能丢一条事件——事件日志仅服务统计，允许尽力而为；核心状态（库存/菜谱/计划/采购）各为单对象整体换写，kv set 单命令原子，无 torn write。

## 5. 策略引擎（shared/stove-core.js）

- **归一化** `normName`：全角→半角、小写、去首尾空白、去中点/括注（「肥牛卷（火锅用）」→「肥牛卷」）；同义词组表 30 组任一成员归一到组首词。
- **匹配** `ingredientHit(ingredient, pantry)`：归一名相等，或一方归一后包含另一方（长度≥2 防误伤）。
- **临期** `expiringItems(pantry, days, now)`：`expiresAt != null && expiresAt <= now + days*86400e3`，含已过期（红榜置顶）。
- **灶签评分** `suggestServing(...)`：每菜谱 `score = +3×min(临期命中种数,3) − 2×缺料种数 − 8×(近7天做过) − 1×(minutes>30) + jitter(日期+id 播种 ×0..2)`，理由数组随分输出；全缺料的菜谱也可出现（AI/用户可自行判断采购），但排序靠后。
- **采购聚合** `fillFromPlan(plan, recipes, pantry, now)`：今天..+6 天已计划菜谱用料按归一名求和 → 扣减在库（未过期）→ 缺料项分类（关键词规则：肉/蛋/奶/蔬/果/鱼虾/米面油盐酱醋…），与清单已有未完成项归一名去重合并。
- **浪费统计** `wasteStats(history, days)`：used/discarded 计数与浪费率、top 丢弃食材、按周桶趋势（近 12 周）。
- **设置归一** `normalizeSettings`：越界钳制、非法回默认，返回 `{settings}` 或 `{error}`。

## 6. MCP 工具（12 个，AI 侧契约）

| 工具 | 入参（摘要） | 语义 |
|---|---|---|
| `stove_overview` | — | 今日灶签+临期红榜+今日计划+采购待办+库存概数，对话入口 |
| `stove_pantry_list` | `query?,location?,expiringDays?` | 查库存（可只看临期/某分区） |
| `stove_pantry_add` | `items:[{name,qty?,unit?,location?,expiresAt?(YYYY-MM-DD),note?}]` | 批量入库（AI 先从口语解析再调用） |
| `stove_pantry_consume` | `names:[], action:'used'\|'discarded', qty?(缺省=整份清掉)` | 按归一名消耗，写 history |
| `stove_recipe_list` | `query?,tag?,maxMinutes?` | 菜谱检索 |
| `stove_recipe_import` | `url` | 服务端抓取（cmd 邮箱），返回 `{title,text}` 供 AI 抽取 |
| `stove_recipe_save` | `{name,minutes?,tags?,ingredients[],steps[],url?}` | 抽取后落库（归一化用料名） |
| `stove_recipe_remove` | `id` | 删菜谱 |
| `stove_plan` | `action:'get'\|'set'\|'clear', day?, recipeId?, note?` | 本周计划读写（day=YYYY-MM-DD） |
| `stove_suggest` | `maxMinutes?,preferTag?` | 灶签推荐（带理由），可指定约束 |
| `stove_shopping` | `action:'list'\|'add'\|'toggle'\|'remove'\|'clear_done'\|'fill_from_plan', items?/name?` | 采购清单全操作；`fill_from_plan` 一键补齐 |
| `stove_stats` | `days?:1..365` | 消耗/浪费透视 |

AI 工作流约定（写进工具 description）：口语入库→`pantry_add`；「今晚吃啥」→`suggest`（必要时先 `pantry_list`）；URL 导入→`import` 后自行抽取→`save`；建议用户确认去向（used/discarded）再 `consume`。

## 7. 面板（五 Tab + 头部）

- **今日**：灶签卡（推荐 N 条+理由+「就吃这个」→写今日计划）；临期红榜（已过期红/临期黄，一键「吃掉了/扔了」）；今日计划行。
- **库存**：五分区（冷藏/冷冻/干燥/调味/其他）折叠组；添加表单（名/量/单位/分区/到期日）；条目操作（编辑、吃掉、扔掉）；顶部临期计数徽标。
- **菜谱**：搜索框+标签筛选；卡片列表（名/时长/标签/缺料数）；详情抽屉（用料对照库存：✓有/✗缺、步骤）；导入条（URL→「抓取预览」→「填入表单」或「发给 AI 提取」via `onSendToChat`）；手动新增表单。
- **本周**：今天起 7 天行（日期/ weekday/已选菜谱或备注），点击弹出选择（菜谱搜索/自由文本备注/清空）；周计划概览。
- **采购**：分类分组清单，勾选/删除/清空已完成；「按本周计划补齐」按钮（结果提示新增 N 项）。
- **设置**：临期窗口天数、推荐条数；服务状态（心跳/桥接）；导出全部数据（JSON 下载）；清空数据（二次确认）。

样式沿用主题暗色 token 风格（与数据方舟面板同族 CSS 变量体系），入口 `activityBar` icon=`Beaker`（白名单 18 值内）、`order:83`、`panelType:'askStove'`、`labelKey:'plugins.askStove'`。

## 8. 验收

- [ ] `node test/run-tests.mjs` 全绿（归一化/同义词/匹配/临期/推荐评分与理由/采购聚合与去重/浪费统计/设置归一/计划与历史裁剪）
- [ ] 真机冒烟 `node test/smoke-real.mjs`（9829 router-dispatch）：settings/pantry 写读、cmd 邮箱抓公网 URL 成功、SSRF 拒内网 URL、孤儿 result 清扫
- [ ] `npm run build`（esbuild）+ `npm run typecheck`（tsc --noEmit）通过
- [ ] `node scripts/validate.js` 索引校验通过；icon/order/labelKey 合规；zip 产出且 index.json sha256 一致
- [ ] 面板零直连外网 fetch（代码评审断言）；服务 fetch 全部过 `isFetchableUrl` + 超时 + 体量上限
