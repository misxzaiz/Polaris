# 谋定（decision-journal）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> 一句话：把「决定」本身变成可复盘、可校准的资产——聊天里说「我选了 B，把握八成，三个月见分晓」即立此存照；到期复盘打分（兑现/部分/落空/作废）；积累久了得到你自己的**判断力校准曲线**：你自称 80% 把握的事，实际兑现率到底是不是 80%。

## 1. 目标与动机

生态缺口盘点（29 个已上架插件）：日晷管未来的日程、拾光机挖过去的会话、记忆熔炉炼记过的知识、口袋账本记花掉的钱——**没有任何插件记录「你做的决定」**。而决策是个人资产里复利最高的种类：架构选型、插件方向、采购、承诺，每天都在做，做完即忘，从不验证「当时想的是否兑现」。主流工具（Notion 模板 / Decision Journal App）只做记录，没有闭环：不逼你写可检验的预期、不提醒复盘、更没有把把握度与结果对账的**校准量化**（超预测/决策日记方法论的核心，个人工具界几乎无人实现）。

本插件给 Polaris 补上「判断力」这个维度：AI 对话式立此存照（工具描述内嵌方法论，逼出可检验预期与真实置信度）→ 到期清单复盘打分 → 校准曲线 + Brier 分数量化「你该不该信自己的直觉」→ 教训沉淀为经验卡，AI 后续决策时可引用（「你上次同类决定的教训是……」）。

## 2. 定位与差异化

- **立此存照的四要素**：背景、选项、所选项、**可检验的预期**（「预期 X 在 N 天内发生，把握 P%」）。工具层强制：`decided` 记录没有预期文本就无法创建——把方法论变成接口约束，而非文档劝告。
- **四态生命周期**：`open`（纠结中，只记问题与选项）→ `decided`（已定案，等复盘）→ `resolved`（已复盘）；旁路 `shelved`（搁置/作废，不计分校准）。
- **校准数学**（shared 核心纯函数）：把握分 4 桶（<50 / 50-69 / 70-84 / 85-100），每桶实际命中率 vs 自称把握；Brier = mean((score − p)²)，score 兑现=1 / 部分=0.5 / 落空=0，作废 void 不计分；bias = 命中率 − 平均把握，< −0.1 提示系统性过度自信。
- **AI 陪审**：MCP 工具描述内嵌方法论（预期怎么写才算可检验、复盘怎么对照偏差来源），宿主 AI 即分析师，零新增 AI 通道；面板「让 AI 复盘」一键把决策全文送进聊天。
- **跨端**：数据全在 cap.kv（`decision.*`），手机上立此存照、桌面复盘，同一份账。

## 3. 架构与跨域决策

零服务型插件（同口袋账本范式）：决策是低频稀疏数据，无后台探测/抓取需求，不引入常驻进程。

| 面层 | 方案 |
|---|---|
| 数据面 | 一切状态走 cap.kv（`decision.*`），面板/MCP 两方共享，跨端一致 |
| 计算面 | shared/decision-core.js 单一权威（归一化/状态机/到期判定/校准数学），面板与 MCP 只做 IO，口径不漂移 |
| 通信面 | 面板**零直连 fetch**（宿主 `__POLARIS_HOST_INVOKE__` → router_dispatch → cap.kv，blob iframe 无 CORS 面）；MCP 是宿主拉起的 stdio 进程，本机 HTTP 自发现直连；**零外网请求** |
| AI 面 | 宿主 AI 经 stdio MCP 读写，分析方法论内嵌工具描述，不新增 AI 通道 |

```
面板（React，blob iframe）          MCP server（stdio）           宿主 AI
   │ __POLARIS_HOST_INVOKE__          │ 自发现 127.0.0.1:port      │ tools/call
   └──────────┬───────────────────────┴──────────┬─────────────────┘
              ▼  router_dispatch                  │
          cap.kv（decision.* 键空间，单事实库）◀───┘
```

## 4. 键空间契约（权威，两方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `decision.settings` | 面板/MCP 写 | { schemaVersion: 1, reviewDefaultDays: 90 } |
| `decision.d.<id>` | 面板/MCP 写（按 id 幂等） | Decision 完整对象（见 §5） |

盘点键：`cap.kv list` 全量键 → 过滤 `decision.d.` 前缀。决策是稀疏数据（几十~几百条），无规模问题。

## 5. 数据模型（Decision v1）

```ts
{
  id: 'd' + base36(ts) + rand,   // 决策 id
  schemaVersion: 1,
  createdAt, updatedAt,          // epoch ms
  title: string(≤80),            // 「迁移 RouterBus」
  question: string(≤500),        // 待决问题（open 必填；decided 后保留原文）
  context: string(≤2000),        // 背景与约束
  options: [{ id:'o1', name(≤40), note?(≤200) }],  // ≤6 项
  chosenId: 'o1'|null,
  rationale: string(≤1000),
  expected: { text(≤300), confidence: 0-100 } | null,  // decided 必填（可检验预期）
  tags: string[](≤8, 每个≤20),
  links: string[],               // 关联决策 id
  source: 'ai'|'panel'|'import',
  status: 'open'|'decided'|'resolved'|'shelved',
  decidedAt: epoch|null,
  reviewAt: epoch|null,          // null = 不定期（不进到期清单）
  shelvedReason: string(≤200),
  resolution: {                  // resolved 必有；重复盘覆盖
    outcome: 'hit'|'partial'|'miss'|'void',   // 兑现/部分/落空/作废
    score: 1|0.5|0|null,         // void → null（不计分校准）
    note(≤1000), surprise(≤500), lesson(≤500),
    resolvedAt: epoch,
  }|null,
}
```

状态迁移（core 守卫，非法迁移报错）：`create → open|decided`；`open→decided`(settle)；`open|decided→shelved`；`decided→resolved`(resolve，可重复=重复盘覆盖)；`update` 只改字段不改状态；`delete` 任意态。

## 6. MCP 工具（9 个，描述内嵌方法论）

| 工具 | 语义 | 方法论约束（写在 description） |
|---|---|---|
| `decision_create` | 立此存照/记下纠结。有 chosen+expected → decided，否则 open | 预期必须可检验（时间范围+可观察判据，拒绝「会更好」）；confidence 是真实把握不是愿望，用户说模糊表述（「挺有把握」）先追问数字；decided 缺预期直接报错，逼 AI 补齐 |
| `decision_settle` | open→decided 定案 | 同上；reviewInDays 缺省 settings.reviewDefaultDays |
| `decision_resolve` | 复盘打分 hit/partial/miss/void | 对照 expected 逐条核对；void 仅用于「前提消失/决定作废」（不计分）；surprise 记意料之外，lesson 沉淀可复用教训 |
| `decision_list` | 查询 status(all/open/decided/resolved/shelved/due)+tag+keyword | due = decided 且 reviewAt≤now |
| `decision_get` | 全文详情 | — |
| `decision_update` | 编辑字段（不改状态） | expected/reviewAt/tags/links 可改 |
| `decision_shelve` | 搁置（reason 可选） | 搁置不计分校准 |
| `decision_stats` | 校准报告：分桶表+Brier+bias 解读+最近教训+待复盘数 | n<5 提示样本不足 |
| `decision_delete` | 删除（confirm:true 必带） | — |

## 7. 面板（四 Tab，`dj-` CSS 前缀）

- **总览**：速览卡（待复盘 n / 纠结中 n / 已复盘 n / Brier+命中率一句话）→ 到期复盘清单（每项带逾期天数，进复盘表单）→ 最近动态。
- **决策**：状态 chips + 搜索 + 标签过滤；卡片列表（状态色标/把握/到期）；详情页（时间线 + 预期 vs 复盘对照 + 「让 AI 复盘」onSendToChat + 编辑/搁置/删除）；新建/编辑表单（选项增删、把握滑杆 0-100、复盘期限 30/90/180/365/不定期）。
- **校准**：SVG 校准曲线（x=自称把握桶，y=实际命中率，对角参考线）、Brier 大数字、bias 解读、样本量提示、经验卡（lesson）列表、按月复盘时间线。
- **设置**：reviewDefaultDays、JSON 导出、清空（二次确认）。
- 空状态给三条可点击示例 prompt（经 onSendToChat 送入聊天）。

## 8. 验收

1. `node --test test/run-tests.mjs` 全绿：归一化校验（confidence 边界/预期必填/选项匹配）、状态机合法与非法迁移、到期边界（reviewAt==now 算到期）、校准数学（固定样本精确对账分桶/Brier/bias、void 不计分）、导出。
2. `node test/mcp-verify.mjs`：stdio JSON-RPC 握手 + tools/list 9 工具 + mock kv 全链路 create→settle→resolve→stats。
3. `node test/smoke-real.mjs`（需本机 Polaris 运行中）：真实桥上全生命周期 + 清理复原。
4. `pnpm typecheck`（面板 tsc）+ esbuild 打包成功；`node scripts/pack.js` 产 zip；index.json 条目 + validate 通过。
