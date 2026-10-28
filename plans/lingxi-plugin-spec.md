# 灵犀 lingxi —— 灵感孵化池插件 spec

> 状态：**已实施**（插件仓提交 `70ecd5e`，v0.1.0，index 37 条 validate 绿）。
> 单测 14/14、MCP 协议离线验证 7/7、真桥冒烟 15/15、`tsc --noEmit` 与 esbuild 构建全绿。

## 一、问题与定位

**想法的身后事没人管。** 笔记/收藏工具的终点是「存下来」：琥珀封存网页、书签考古救书签、
拾光机检索已发生的对话——但存进备忘录的念头 90% 再也不会被打开，想法池注定变成坟场。

灵犀的全部机制围绕三件事，这是它与「又一个笔记应用」的本质区别：

1. **让想法被再次见到** —— 到期回访队列（SRS 思想，无后台定时器、纯派生）
2. **让想法被推进** —— 成熟度管道（种子→嫩芽→轮廓→蓝图→落地）
3. **让想法相遇** —— 入池自动相关匹配 / 星系聚类与合并候选 / 随机碰撞头脑风暴

与生态互补：**谋定**管「决定之后」的校准复盘，灵犀管「决定之前」的孵化；
**拾光机**被动回忆已发生的对话，灵犀主动回访未成形的念头。

- **所有者**：插件仓 `Polaris-plugin/plugins/lingxi`（本 spec 为设计存照）
- **形态**：零后台服务（同口袋账本范式）——MCP stdio 进程 + 面板 bundle + shared core
- **权限**：仅 `aiToolAccess`；数据面 cap.kv `lingxi.*` 键空间，不出设备

## 二、机制定案（口径唯一权威：`shared/pond-core.js`）

### 回访 SRS（ideas 专用，非记忆卡片）

| 事件 | 效果 |
|---|---|
| 捕获入池 | 3 天后首访（`REVISIT_BASE_DAYS=3`） |
| 深化 / 再等等 | 间隔翻倍，上限 60 天 |
| 推进 | 间隔回 3 天（活跃孵化期保持高频） |
| 落地 / 归档 | 离开回访队列；恢复入池重置 3 天 |

到期 = 读时比较 `revisit.dueAt <= now`（**纯派生**，零定时器、零状态漂移）。
捕获时 AI 留一个**深化追问**存进 timeline，回访时作为「给未来自己的重启抓手」展示。

### 成熟度管道

`种子(0) → 嫩芽(1) → 轮廓(2) → 蓝图(3) → 落地(4)`；推进须给依据（进 timeline）；
到 4 状态收口 `status=done`、退出回访、星图变绿环。归档≠删除：沉寂可检索、可恢复。

### 相遇三件套

- **相关匹配**：CJK 连续段双元 + ASCII 词，BM25-lite（标题×3/标签×2/正文×1/URL×0.5 加权），
  命中 ≥2 token 才算相关，取 top3 且分数 ≥ max(0.35×top, 0.6)——宁缺勿滥。
  `lingxi_catch` 结果自动附相关旧想法，要求 AI 向用户提及（防重复、促合并）。
- **星系**：主标签（首标签，无标签归「未分域」）聚类；**合并候选** = 簇内 ≥3 条且 ≥2 条到轮廓以上。
- **随机碰撞**：抽 2-5 个想法 + 8 张视角卡之一（强制嫁接/反转假设/缩放十年/减半挑战/
  迁地他用/换人发问/旧配新/时间旅行），AI 主持、产出经用户确认后显式 `lingxi_catch` 入池。

### 星图（面板主视图）

canvas 确定性布局 `computeStarLayout`（黄金角簇心 + 散列抖动，同输入同输出）：
星系=主标签虚线圈；星等/大小=成熟度；红环=到期；绿环=已落地；暗星=归档。
点星开详情抽屉（时间线 + 深化/推进/再等等/归档/恢复/改题/让 AI 深化）。

## 三、接口

### MCP 工具（9 个 `lingxi_*`）

`catch`（入池+相关匹配+追问）/ `search`（关键词/标签/类型/成熟度/状态）/ `get`（完整卡片）/
`deepen`（沉淀，间隔翻倍）/ `promote`（推进，落地收口）/ `revisit`（list 到期队列 + record
记录 deep/promote/snooze/archive）/ `constellation`（星系报告+合并候选）/ `collide`（随机碰撞）/
`archive`（归档/恢复）。连接层与 pocket-ledger 同款自发现（anchor.json→config.json→端口扫描，
md5 Bearer，仅 127.0.0.1）。

### 数据契约（cap.kv，权威描述见插件 README）

- `lingxi.idea.<id>` → Idea 一想法一键（低频写、读改写幂等）：
  `{ id, title≤60, raw≤2000, kind: idea|problem|resource|observation, tags≤6, maturity 0-4,
  status: active|archived|done, origin: ai|panel|import, url?, links[], createdAt, updatedAt,
  revisit: { dueAt, interval, history≤30 }, timeline≤40（新在前，kind ∈ catch|question|deepen|promote|revisit|archive|restore|edit） }`
- `lingxi.settings` → `{ schemaVersion: 1 }`（预留）

**并发语义**：跨端同改同一想法为毫秒级窗口、后者胜（与口袋账本同口径，README 已文档化）；
不同想法天然不同键。回访到期纯派生，无双写者问题。

### 面板

四 Tab：星图 / 回访（到期卡片流，带追问与四动作）/ 池子（快捕+过滤检索+列表）/ 统计
（漏斗/状态四格/近 8 周捕获/高频标签）。数据面全走 `__POLARIS_HOST_INVOKE__ →
router_dispatch → cap.kv`；面板与 MCP 经同一 `shared/pond-core.js`，口径不漂移。

## 四、跨域定案（本 spec 的硬约束回应）

**零浏览器直连外网**：面板没有任何第三方 fetch（那会撞 CORS）——数据面全在宿主通道内。
URL 线索**只存元数据不抓取**：要读网页，在对话里扔链接由 AI（宿主侧联网能力）提炼后
`lingxi_catch` 入池，或走琥珀封存后引用。MCP 进程只访问 127.0.0.1 宿主端口。
因此本插件零后台服务、零外网请求、零跨域暴露面；手机/Web 与桌面经 cap.kv 看到同一个池子。

## 五、验收（已全部执行）

- [x] `node --test test/run-tests.mjs` —— 14/14：归一化、SRS 全转移、timeline/history 截断、
      双元检索与相关匹配正反例、星系聚类阈值、碰撞确定性注入、星图确定性/全覆盖/边界、统计口径
- [x] `node test/mcp-verify.mjs` —— 7/7：握手、9 工具形状、参数校验先于触桥、未知工具 isError
- [x] `node test/smoke-real.mjs` —— 15/15（真实桥 9820）：双捕获取相关、kv 直读、检索/详情、
      深化翻倍、推进、强制到期后回访记录、星系、碰撞、归档恢复；**快照式清理**（只删本次新建键）
- [x] `npm run typecheck` + `npm run build`（79.1kb bundle）
- [x] `node scripts/validate.js` —— 37 插件全绿（含顺手修复 opts.zcode-bridge 存量 0.1.3 不同步）

## 六、实施中抓到的坑（勿重蹈）

1. **`findRelated` 小池保护反杀主场景**：初版 `corpus.length < 2` 直接返回空——而「池里只有
   1 条旧想法」恰是第二条想法遇见第一条的时刻。真桥冒烟抓到，改为 `< 1`。
2. **MCP 与面板事件文案必须同源**：面板有中文事件映射、MCP get 没有，冒烟断言「追问」失败。
   服务端补同一份 `EVENT_LABELS`。
3. **冒烟不得用陈旧快照写回**：强制到期若用深化/推进前抓的对象改字段写回，会把状态踩回去；
   必须重新 `kvGet` 再改。
4. zcode-bridge 上个提交只更新了 plugin.json 没同步 index（存量校验红）；且该校验器约定
   `versions[0]` 必须 = 顶层 version（最新在前）。

## 七、已知边界

- 无删除语义（只有归档）；碰撞产出不自动入库（入池皆有主）；相关匹配是词面相关非语义相关；
  星图确定性布局不防全部重叠（密集簇可接受）；双端同改同一想法后者胜（毫秒级窗口）。
- 发布后若 CDN 未推送，`@main` URL 需等 push 生效（与各插件同）。
