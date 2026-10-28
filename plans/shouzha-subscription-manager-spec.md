# 守闸 shouzha —— 订阅与续费管家插件 spec

> 状态：2026-10-29 **已实施并验证**（插件仓 commit `db549c6`，未 push）。验证：core 单测 14/14、MCP 离线协议 18/18、真实桥冒烟 24/24（含自清理）、forge manifest 体检通过、esbuild 构建产 zip（42.3KB）。
> 目标读者：Polaris 维护者与后续迭代者。权威数据契约以本文件 §4 与插件 README 为准。

## 1. 一句话定位

把「散落在支付宝/微信/Apple/各 App 里的自动续费与会员订阅」变成一本可对话的**未来支出承诺账**：
每个订阅的金额/周期/下次扣费日/自动续费状态一目了然，到期前提醒、到期后对账、
试用转正红榜、年化成本排行、未来 12 个月现金流投影——守住每一笔沉默扣费的闸门。

## 2. 需求证据（为什么值得做）

- **立法层面**：《消费者权益保护法实施条例》2024-07-01 施行，第十条要求经营者在自动续费日期前以显著方式提醒消费者——问题普遍到需要立法（央视网 2024-07-04）。
- **真实损失**：央视新闻 2025-09 报道，有用户忘记关自动续费被扣数千元、有人自查发现比上次多了 15 个扣费项目。
- **入口分散**：微信（服务→钱包→支付设置→自动续费）与支付宝（我的→设置→支付设置→免密支付/自动扣款）各自为政，只能「看列表/逐个关」，无金额核算、无跨平台聚合、无历史（媒体建议「定期自查」——本插件即定期自查工具的形态化）。
- **平台内空白**：口袋账本记「过去花掉的」，日晷记「时间安排」；「未来周期性扣费承诺」无任何插件/宿主能力覆盖。

## 3. 竞品边界（不重复造轮子）

| 已有能力 | 边界 |
|---|---|
| pocket-ledger 口袋账本 | 过去支出流水；无周期承诺/续费日/对账语义。互补不重叠 |
| sundial 日晷 | 时间提醒无金钱语义（无金额/年化/价格史/对账）。用户用日晷管订阅＝用记事本管钱 |
| 支付宝/微信自动扣款列表 | 分平台、无核算、无提醒（提醒靠商家守法）、关完即走无沉淀 |
| Bobby 等订阅 App | 无 AI 对话、无桌面端、国内支付生态无适配 |

## 4. 数据契约（cap.kv `shouzha.` 键空间，单一权威 shared/core.js）

```
shouzha.sub.<id>  → Subscription（一订阅一键，低频写，读改写幂等）
shouzha.settings  → Settings
```

Subscription（camelCase，与宿主协议风格一致）：

```ts
{
  id: string                 // 's'+base36 时间戳+随机，makeId
  name: string               // ≤40 字
  category: string           // 视频娱乐/音乐/云盘存储/软件工具/生活服务/新闻资讯/游戏/通信/金融会员/其他
  vendor?: string            // 服务商（≤24 字）
  plan?: string              // 套餐名（≤40 字）
  amount: number             // 每周期金额（正数，≤1e6）
  cycle: 'month'|'year'|'quarter'|'week'|'custom'
  customDays?: number        // cycle=custom 时 1..3650
  nextRenewalDate: 'YYYY-MM-DD'  // 权威下次扣费日；过期未对账＝逾期红榜
  autoRenew: boolean
  status: 'active'|'trial'|'paused'|'cancelled'
  trialEndsAt?: 'YYYY-MM-DD'     // 试用转正日（status=trial 时应填）
  paymentMethod?: string         // 支付宝/微信/Apple/银行卡/其他（≤16 字）
  manageUrl?: string             // 管理/取消入口（http(s) only）
  note?: string                  // ≤300 字
  remindDaysBefore: number       // 默认 3（0..30）
  priceHistory: { date: 'YYYY-MM-DD', amount: number, note?: string }[]  // ≤60
  events: { ts: number, kind: 'create'|'renew'|'skip'|'pause'|'resume'|'cancel'|'resume_active'|'price', note? }[]  // ≤120
  cancelledAt?: 'YYYY-MM-DD'     // 取消时间
  cancelReason?: string
  createdAt: number; updatedAt: number
}
```

Settings：`{ schemaVersion, currencySymbol: '¥', defaultRemindDays: 3 }`（v1 最小化）。

键空间与现有 40 个插件零冲突（无 `shouzha.` 前缀使用者）。

## 5. 核心机制（共享核心 core.js 全部计算，面板/MCP 只做 IO）

1. **周期引擎**：`advanceDate(date, cycle, customDays)` 月序数推进（月末钳制 1/31→2/28）；
   `monthlyCost(sub)` 周期归一（week=52/12 份额、custom=天数/30.4375），年化=月均×12。
2. **对账闭环（核心差异机制）**：`nextRenewalDate < 今日` 且 status=active ⇒ **逾期待对账**，
   不静默滚周期；`renew`（确认已扣费，可记实付金额→priceHistory 检出涨价）推进下一周期；
   `skip`（已取消没扣）转 cancelled。AI 的 `sub_due` 每次都把逾期单置顶——「被扣了才知道」变「扣之前就有人盯」。
3. **试用红榜**：status=trial 按 trialEndsAt 排序，到期前 remindDays 天内红色横幅。
4. **透视**：月度/年度总成本、分类占比、年化 Top 排行、未来 12 个月逐月现金流、
   已取消订阅的「年化已省」累计（止损正反馈）。
5. **提醒触达**：无系统通知通道（与日晷同）⇒ 面板横幅+WebAudio 短音+AI 可见到期清单。

## 6. MCP 工具（stdio，零依赖，自发现与 lingxi 同）

| 工具 | 作用 |
|---|---|
| `sub_add` | 登记订阅（归一化校验，试用态可带 trialEndsAt） |
| `sub_list` | 检索（关键字/分类/状态/排序），返回含月均/年化 |
| `sub_due` | 到期+逾期+试用 三榜（AI 每天可问「最近要扣哪些钱」） |
| `sub_renew` | 对账：确认续费（记实付）/跳过（=取消）/暂停/恢复/取消 |
| `sub_update` | 改价/改周期/改下次扣费日/改备注等 |
| `sub_stats` | 成本总览/分类/排行/12 月现金流/已省 |
| `sub_history` | 单订阅价格史与事件流水 |
| `sub_delete` | 彻底删除（含二次确认参数 confirm=true） |

## 7. 面板（React，四 Tab：总览/订阅/透视/设置）

- **总览**：月均成本卡 + 三榜（逾期待对账/即将扣费/试用转正）+ 未来 12 个月现金流柱状。
- **订阅**：全量列表（状态过滤/搜索），行内操作（对账/暂停/取消/编辑），取消填原因。
- **透视**：分类占比条、年化排行、价格变动史、已取消与已省。
- **设置**：币种符号、默认提前提醒天数、CSV 导入导出、危险区（清空）。
- 样式遵循 pocket-ledger 惯用法（前缀类名 `sz-`、深色 token、8s 轮询跨端一致）。

## 8. 安全与隐私

- 纯本地 cap.kv，零外网请求、零后台服务；不存支付凭据/密码（note 字段提示勿存敏感信息）。
- manageUrl 仅 http(s)（core 层拒其他协议）；金额上限防误输入；events/priceHistory 截断防 kv 膨胀。
- 删除有两段式（cancel 可逆 → delete 需 confirm）。

## 9. 验收口径

- `node --test test/run-tests.mjs`：周期推进/月均归一/对账状态机/试用红榜/统计/CSV/归一化校验 全绿。
- `node test/mcp-verify.mjs`：MCP 协议形状 + 参数校验离线全绿。
- `node test/smoke-real.mjs`：真实桥端到端（登记→对账→改价→统计→清理，快照恢复不污染）。
- `pnpm typecheck`（面板）+ esbuild 打包 + pack 脚本产 zip。
- 平台门禁：图标白名单（Activity）、`enabledByDefault`+设置开关两层门、permissions 仅 aiToolAccess。

## 10. 后记：与「常契 changqi」的域撞车（2026-10-29，留维护者取舍）

实施完成后发现并行会话同日交付了同域插件**常契 changqi**（插件仓 `40de1b8`，先于守闸 `db549c6` 入库，spec 在 `plans/changqi-plugin-spec.md`）。两插件 index.json 条目共存（validate 均零错误），**不删改对方为前提**，差异与合并建议如下：

| 能力 | 守闸 shouzha | 常契 changqi |
|---|---|---|
| 对账闭环（扣费日过境=逾期红榜，不静默滚周期） | ✅ 核心 | 部分（advance 靠 lastConfirmedDate 下限） |
| 价格史 + 涨价检出 | ✅ 独有 | ✗ |
| 未来 12 个月现金流逐月投影 | ✅ 独有 | ✗（本月将扣） |
| 取消止损统计（年化已省） | ✅ 独有 | ✗ |
| CSV 往返（导入+导出+去重） | ✅ | 仅导出 |
| anniversary 锚点推导（1/31→2/28→3/31 不漂移） | ✗（平推） | ✅ 更优 |
| 五渠道取消路径引导 | ✗ | ✅ 独有 |
| 渠道维度透视 / 面板 harness 交互验证 | ✗ / ✗ | ✅ / ✅ |

两会话独立选中同一缺口，反向验证了需求判断。**建议**：二留一或合并——以守闸的「对账闭环+价格史+现金流」为骨架，吸收常契的「anniversary 锚点推导 + 五渠道取消引导」；合并后另一插件下架索引。此取舍属维护者决策，本次交付未越权处置对方成果。
