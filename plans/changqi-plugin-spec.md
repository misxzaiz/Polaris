# 常契 changqi — 订阅契约账簿插件 spec

> 状态：已实施于插件仓（本文件为设计定案记录）。
> 日期：2026-10-29。插件 id：`changqi`，位置 `Polaris-plugin/plugins/changqi/`。

## 一、目标与定位

**一句话**：常驻工作台的订阅契约账簿——每一笔自动续费都被看见、被提醒、可果断取消。

**解决的真实问题**（外部证据）：
1. 自动续费取消链路割裂：App 内取消不彻底，还需到支付宝/微信/Apple 各自的深层设置里解约（新华网 2024《APP自动续费关了还在扣费？这样取消才彻底》），入口隐蔽（经济观察网 2025《勾选与取消难》），黑猫投诉平台相关投诉持续海量。
2. 扣费前无提醒：平台普遍不做显著续费前通知（黑猫投诉知乎盐选等工单反复出现"未收到提醒被扣费"）。
3. 桌面/Web 端缺位：Bobby（iOS，~4.7 星）验证"手动录入 + 本地隐私"模式成立，但 iOS-only 且更新停滞，桌面端无好方案（Subnesio/Subgrove 等评测口径）。
4. "订阅收费的订阅追踪器"悖论（r/sideprojects 热帖）：Polaris 插件免费本地，天然化解。

**差异化**：
- 对比支付宝/微信官方入口：跨渠道集中台账 + 续费前主动提醒（不依赖平台良心）+ 已取消归档留痕。
- 对比 Bobby：桌面常驻工作台、AI 对话式录入（"我在 iCloud 开了月度会员 6 元"一句话入册）、跨端（cap.kv 单事实库，手机 Web 同看）。
- 对比银行同步类（Rocket Money 等）：零凭据零上传，纯本地 cap.kv。

## 二、范围

### MVP 做
- 订阅台账：名称/每期金额/周期（weekly/monthly/quarterly/yearly/custom+天数）/周期锚点（上次或下次扣费日）/扣费渠道（alipay/wechat/apple/card/other）/分类/状态（active/trial/cancelled）/试用期截止/备注。
- 下次扣费日推导：从锚点步进到首个 ≥ 今天的扣费日；monthly/yearly 末日 clamp（anniversary 语义：名义日不变，仅当月 clamp）。
- 月度化口径：weekly ×52/12；monthly ×1；quarterly /3；yearly /12；custom ×(30.44/cycleDays)。
- 提醒投影（纯派生，零定时器）：今天将扣（红）≤remindDays（橙）≤7 天（黄）；试用转正预警（紫，trialWarnDays 默认 3）。
- 透视：月度化总额/年化/本月将扣笔数与金额/渠道分布/分类分布/Top 支出/试用期占用。
- 取消引导：五渠道静态取消路径文案（回应"取消链路割裂"），软取消自动附带。
- 已取消归档（保留历史可查）与删除（硬删需 confirm）。
- AI 工具 9 个：add/list/update/advance（确认已扣推进下期）/cancel/delete/upcoming/summary/cancel_guide。
- 面板三 Tab：总览（透视头 + 预警条 + 状态过滤 + 台账卡 + 内联录入表单）/统计/设置（提醒窗口/货币/CSV+JSON 导出/清空）。

### 不做（明确排除）
- 自动检测订阅（银行/账单解析）：需凭据与外部数据源，MVP 拒绝；录入摩擦由 AI 对话式录入化解。
- 系统级推送通知：插件平台无此能力，用面板预警条 + AI 查询（"这周要扣什么"）替代；与 sundial/quote-sentinel 的"提醒投影"同范式。
- 多币种汇率换算：仅记录与展示原币种符号。
- 共享/家庭订阅分摊。

## 三、架构（零服务纯本地，同 pocket-ledger 范式）

```
plugins/changqi/
├── shared/subs-core.mjs   # 计算权威：推导/月度化/透视/归一化/CSV（面板+MCP+测试共用）
├── mcp/server.js          # AI 工具层（stdio JSON-RPC，cap.kv 读写，自发现桥）
├── src/                   # 面板（React + esbuild → dist/panel.js）
└── test/                  # run-tests.mjs / mcp-verify.mjs / smoke-real.mjs
```

- **键空间**：`changqi.sub.<id>` 一条一键（规避列表并发覆盖，与 lingxi 同决策）；`changqi.settings` 设置。跨端经 cap.kv 单事实库，双端并发后到者胜（与 pocket-ledger 口径一致）。
- **数据面**：全部经 cap.kv（跨端放行）；无网络请求、无后台服务、无跨域面。
- **幂等**：按 id 覆盖写；advance 以 paidDate 写锚点，重复 advance 同日期幂等。

## 四、关键算法

- `nextChargeDate(sub, today)`：trial → trialEndsAt；cancelled → null；否则从 anchorDate 步进（monthly/yearly 按名义日 + 当月 clamp）到首个 ≥ today。
- `urgency(sub, today, settings)`：trial 且距 trialEndsAt ≤ trialWarnDays → trial 紫；0 天 → today 红；≤ remindDays → soon 橙；≤7 → week 黄；否则 calm。
- 归一化校验：金额正数、cycle 合法、custom 必带 cycleDays≥1、日期 YYYY-MM-DD、trial 必带 trialEndsAt。

## 五、验收

- 离线单测覆盖：月末 clamp（1/31→2/28→3/31 语义）、闰年 2/29、weekly/quarterly/custom、trial 优先、urgency 分级边界、月度化换算、透视聚合、CSV、非法输入拒绝。
- `test/mcp-verify.mjs`：内存桥 + 子进程全流程（校验拒绝/增改/推进/取消引导/透视/删除确认门）。
- `test/smoke-real.mjs`：真实桥冒烟（需 Polaris 运行），跑完清理全部 `changqi.*` 键。
- 面板 esbuild 构建 + `tsc --noEmit` 绿。
