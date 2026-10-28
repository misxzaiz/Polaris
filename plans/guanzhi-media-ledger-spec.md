# 观止 guanzhi — 书影音消费账本插件 spec

> 状态：已实施于插件仓 `02a7c35`（本文件为设计定案记录）。
> 日期：2026-10-29。插件 id：`guanzhi`，位置 `Polaris-plugin/plugins/guanzhi/`。

## 一、目标与定位

**一句话**：常驻工作台的书影音消费账本——看过的每一步都算数，想看的每一部都会再见到你。

**选型过程**：本期任务要求"先证明值得做再开发"。共发散 10+ 候选（记账/习惯/番茄/旅行/求职/证件哨兵/API 工具箱/提示词库/媒体追踪…），先经生态盘点排除已覆盖项（口袋账本=记账、relay-devkit=API 工具箱、page-sentinel=盯网页、日晷=日程提醒、故人=人脉生日），再对外部需求证据加权评分（痛点 20%/频率 15%/缺口 15%/差异化 15%/收益 15%/平台适配 10%/可行性 5%/成本 5%）。媒体账本 83/100 居首；次优「证哨」（域名/SSL 到期哨兵，RDAP 实现）约 68 分，因受众窄（仅域名主）留作备选。

**解决的真实问题**（外部证据，可追溯）：
1. Goodreads 长期停滞：Amazon 收购后功能冻结，r/goodreads「If Goodreads disappeared today, would you care?」、r/books「What would make you switch」等长帖多年持续；用户外流 StoryGraph/Fable/Literal。
2. 豆瓣体验绑架：安卓端误点广告强制拉起 App（豆瓣小组 2024《为什么豆瓣页面有这么多的广告？》），社区商业化侵蚀记录体验，「逃离豆瓣」长期话题。
3. 替代方案各有门槛：NeoDB（最主流替代）需理解联邦宇宙、选实例、注册账号；Ryot/Yamtrack/Movary 等自托管系需 Docker/服务器；Letterboxd 只管电影、Trakt 只管剧集——跨书影音游戏的全类目 + 零部署 + 本地私有的组合空缺。
4. 记录成本是根痛点：现有方案全部是「搜元数据→填表单」，记录本身成为负担，想看清单沦为死列表。

**差异化**：
- **对话式记账**（唯一核心创新）：「昨晚看完《流浪地球2》打9分」一句话入账，AI 凭常识补全年份/导演/类型；同体裁同名自动判重转状态（想看→在看→看完）。无任何主流竞品具备。
- **清单被激活**：推荐是确定性纯函数（躺龄 min(天/30,4) + 体裁定向 +1.5 + 当日盐 jitter），同日可复现、跨日轮换、附可解释理由与口味画像——不是黑盒打分。
- **年报纯派生**：完成数/评分均值/月度 12 柱/分体裁/年度十佳/心头好/最长短评，无需预生成，数据到哪年报到哪。
- **对比 NeoDB/Ryot**：零账号零部署零外联（连元数据 API 都不依赖，封面为体裁排版卡），Polaris 原生 AI 形态。
- **对比 Notion 模板**：跨端同步（cap.kv 单事实库，手机 Web 同看）+ MCP 工具对话入口。

## 二、范围

### MVP 做
- 记录模型：title/kind(book·movie·tv·anime·music·game·podcast·other)/status(wish·active·done·dropped)/rating(0-10 一位小数)/startDate/finishDate/year(1900-2100)/creator/genre/link(http s)/note(≤500)/favorite。
- 状态-日期语义（唯一权威 `applyStatusDates`）：wish 清日期；active 补开始日记今天、清陈旧完成日；done 缺完成日记今天；dropped 原样保留。新建与切换共用。
- 判重键：同体裁 + 标题（去全部空白 + 小写）；年份只在双方都有且不同时才区分（沙丘1984≠沙丘2021，一方缺年视为同作）。
- AI 工具 7 个：log（记账 upsert）/search/stats（透视+年报）/recommend/update/delete(confirm 门)/import（≤500 条，批内+账本双重判重，autoDates=false 不臆造日期）。
- 面板四 Tab：总览（KPI+进行中收尾+最近完成+想看最久+记一笔表单）/藏卷（搜索+三重过滤+状态流转）/年报（年份选择+月度柱+分体裁+评分档+十佳+心头好+最长短评）/设置（CSV/JSON 导出、JSON 导入、清空）。
- 体裁感知文案：想读/在读/读完 vs 想看/在看/看完 vs 想玩/在玩（KIND_VERBS 映射）。

### 不做（明确排除）
- 外部元数据 API（TMDB/豆瓣/Bangumi 抓取）：反爬与漂移风险大、需网络权限；MVP 由 AI 常识补全元数据，海报走排版卡设计。后续可做「用户自带 TMDB Key 的可选增强」。
- 豆瓣 CSV 导入解析：列结构需实测真实导出样本，MVP 拒绝臆造列映射；当前导入格式为观止 JSON / AI 整理数组。
- 重看/重读记录（同一作品仅一条，状态机不表达第二次完成）：模型复杂度不成比例，重看感受走更新短评。
- 社交/联邦/共享：与定位（个人私有账本）相反。

## 三、架构（零服务纯本地，同 changqi 范式）

```
plugins/guanzhi/
├── shared/guanzhi-core.js  # 计算权威：归一化/状态-日期语义/判重/透视/年报/推荐/CSV/导入（面板+MCP+测试共用）
├── mcp/server.js           # AI 工具层（stdio JSON-RPC，cap.kv 读写，anchor→config→端口扫描自发现）
├── src/                    # 面板（React+esbuild --external:react → dist/panel.js；model.ts 严格类型映射）
└── test/                   # run-tests.mjs(43组) / mcp-verify.mjs(内存桥) / smoke-real.mjs(真桥) / harness.tsx
```

- **键空间**：`guanzhi.work.<id>` 一条一键（规避列表并发覆盖）；`guanzhi.settings` 预留。
- **数据面**：全部经 cap.kv；无网络请求、无后台服务、无跨域面；permissions 仅 appConfigRead+aiToolAccess。
- **推荐可复现**：jitter 用 djb2 hash(today|id)，同日确定、跨日轮换。

## 四、关键算法

- `applyStatusDates(status, start, finish, today)`：状态机日期语义唯一权威（见上）。
- `sameImportWork(a,b)`：kind 相等 + normTitle 相等 + 年份不冲突（双方都有且不同才区分）。
- `recommend(works, today, {kind?, count?})`：continueList=active 按开始日升序（先收尾）；picks=wish 池按分数取 N；taste=分体裁均分+topGenres（多分隔符拆分）。
- `computeYearReport(works, year)`：finishDate 前缀过滤 → perKind/monthly[12]/ratingBands/top10（分数 desc→完成日 desc）/longestNote/wishCarryover。

## 五、验收（实际执行结果）

- 离线单测 43/43（`node test/run-tests.mjs`，全合成日期不依赖真实时钟）。
- MCP 全流程离线验证通过（内存桥 + stdio JSON-RPC：校验拒绝/记账状态机/判重更新/检索/问账/推荐/更新/删除确认门/导入/未知工具）。
- **真桥冒烟 14/14**（本机 Polaris 运行中，真实 MCP server 走 anchor 自发现 9820 端口，快照式清理 4 键无残留）。
- `tsc --noEmit` strict 通过；esbuild 面板 bundle 77.3kb；harness 构建通过。
- index.json 条目已插入（tier beta，sha256 8b895f11…），`scripts/validate.js` 观止项全绿（存量 watchtower 版本不一致非本次引入）。
- 未验证项：面板活体视觉点检（IAB webview 本会话无法附着）；发布 tag/CDN（遵循仓库惯例本地 commit 不 push，`publish-plugin.mjs <id> --push` 时自动 tag）。

## 六、后续路线（按价值排序）

1. 豆瓣 CSV 导入适配（实测官方导出列结构后做列映射+1-5 星→0-10 换算）——最大迁移桥梁。
2. 可选 TMDB/GoogleBooks 增强（用户自带 Key，cap.http 服务侧抓取海报缓存 cap.fs）——补排版卡的信息密度。
3. 观止周报卡片（chatCards：本周完成 N 部 + 一条心愿轮换）。
4. 重看/重读多段记录（引入 entries 子表）。
