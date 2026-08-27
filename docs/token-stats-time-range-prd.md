# Token 统计页 · 快捷时间选择与时间组件重构 — PRD

> 版本：v1.1（已实施） · 2026-08-27
> 范围：设置面板 → Token 统计 Tab 顶部筛选栏（`FilterBar`，`src/components/Settings/tabs/TokenStatsTab.tsx`）
> 新增组件：`src/components/Common/TimeRangePicker.tsx`、`src/utils/timeRange.ts`

---

## 1. 背景

### 1.1 现状

Token 统计页顶部 `FilterBar` 承担全部时间筛选，当前实现：

- **快捷预设**：硬编码 3 项 —— 今天 / 近7天 / 近30天（`TokenStatsTab.tsx:128-132`）
- **手动范围**：两个 `<input type="datetime-local">` + `~` 分隔符（`TokenStatsTab.tsx:159-165`）
- **刷新**：单个刷新 icon 按钮（`TokenStatsTab.tsx:167-170`）

选中预设 = 把 `startDate`/`endDate`（`YYYY-MM-DDTHH:mm:ss` 字符串）写死为 `datetime-local` 值；高亮通过 `isActivePreset` 字符串全等判断（`TokenStatsTab.tsx:133`）。

### 1.2 痛点

#### 交互不便

| # | 痛点 | 位置 |
|---|------|------|
| 1 | 快捷预设仅 3 项，无“昨天/前天/上周/上月/全部”等常用范围 | `:128` |
| 2 | 无“全部/不限”选项，看全量须手动清空两个时间框 | — |
| 3 | `datetime-local` 精确到秒，仅想按天看也被迫处理时间 | `:159` |
| 4 | `~` 起止分隔符语义弱，范围关系不直观 | `:162` |
| 5 | 预设高亮靠字符串全等，手动微调后高亮丢失，当前范围不可见 | `:133` |
| 6 | 刷新按钮仅 icon、无文字/区分，语义弱 | `:167` |

#### 视觉不统一

| # | 痛点 |
|---|------|
| 7 | `datetime-local` 原生控件与 Polaris 主题（圆角/字体/颜色）脱节，外观割裂 |
| 8 | 快捷预设、手动输入、刷新挤在一行，窄窗口换行杂乱，无“快捷 vs 精确”分组 |
| 9 | 预设按钮与普通按钮无视觉层级区分 |

---

## 2. 目标

1. 提供**更丰富的快捷时间范围**：昨天、前天、上周、上月、全部，并与现有今天/近7天/近30天统一管理。
2. **重构时间选择组件**，解决视觉割裂与交互不便：统一主题外观、快捷/精确分组、清晰的范围表达、可回退的“全部”。
3. 全部文案接入 i18n（zh-CN / en-US），避免重蹈本次 `tokenStats` 命名空间缺失覆辙。

### 非目标

- 不做自定义“任意快捷范围”的持久化记忆（后续版本）。
- 不改动数据层聚合逻辑（`getDailyTrends` 的 `30d` 固定窗口等留待后续）。
- 不引入第三方日期选择库（保持零新依赖，纯 CSS 自绘）。

---

## 3. 需求

### 3.1 快捷时间范围（新增）

| 项 | 语义 | 区间计算 | 默认显示 |
|----|------|---------|---------|
| 今天 | 今日 00:00:00 → 今日 23:59:59 | `dayStartInput(now)` / `dayEndInput(now)` | ✅（现状） |
| 昨天 | 昨日 00:00:00 → 昨日 23:59:59 | `daysAgoDate(1)` 同日首末 | 新增 |
| 前天 | 前日 00:00:00 → 前日 23:59:59 | `daysAgoDate(2)` 同日首末 | 新增 |
| 近7天 | 今天起往前 7 天滚动 | `daysAgoDate(6)` → 今日末 | ✅（现状） |
| 近30天 | 今天起往前 30 天滚动 | `daysAgoDate(29)` → 今日末 | ✅（现状） |
| 上周 | 上一自然周（周一 00:00 → 周日 23:59） | 依当前周起始日推算 | 新增 |
| 上月 | 上一自然月（1日 00:00 → 月末 23:59） | 上个月首/末日 | 新增 |
| 全部 | 不限时间范围 | `startDate=''`、`endDate=''` | 新增 |

**待定项（需拍板）：**

- **周起始日**：周一（默认）还是周日？
- **上周/上月用自然周/自然月，而非滚动区间**：语义与字面一致，但与“近7天/近30天”的滚动口径不同。若希望统一口径，可改为“近7天已覆盖”而不再新增。
- **预设总量达 8 项**，一行放不下 → 需分组或折叠（见 §5）。

### 3.2 时间组件重构

**统一外观**：所有控件（select、快捷按钮、日期输入、刷新）统一为 Polaris 主题 token（`bg-background-surface`、`border-border-subtle`、`text-text-*`、圆角 `rounded-md`、字号 `text-xs`），消除原生 `datetime-local` 样式割裂。

**分组表达**：筛选栏划分为清晰的逻辑区：

```
[ 引擎 ▼ ] [ 模型 ▼ ]   ‖   [快捷: 今天|昨天|前天|近7天|近30天|上周|上月|全部]   ‖   [ 开始日期 ] ~ [ 结束日期 ]   [ 刷新 ]
```

- 用分隔符 `‖`（细竖线）区分“维度筛选 / 快捷范围 / 精确范围”。
- 快捷与精确范围互斥：选快捷即填充精确输入框；手动改输入框则取消快捷高亮。

**起止范围表达**：用“开始 → 结束”双输入，替代单一 `~`；两端输入框标签化（可选 `title`/placeholder 提示）。

**“全部”处理**：选中“全部”时 `startDate/endDate` 置空，精确输入框显示为空，并高亮“全部”按钮；用户手动填任一输入框则退出“全部”。

**刷新**：保留 icon，补 `title` 提示；文案入 i18n。

---

## 4. 交互流程

1. 进入 Token 统计 Tab → 默认选中“今天”（现状保持）。
2. 点击任一快捷项 → 立即填充 `startDate/endDate` 并触发重查，该项高亮。
3. 手动修改任一起止输入框 → 快捷项高亮清除，按手动值查询。
4. 点击“全部” → 清空两输入框，`buildFilters` 不加时间过滤，查询全量。
5. 点击“刷新” → 按当前生效范围重新拉取（`refreshData`）。

---

## 5. 方案设计（已实施）

### 5.1 快捷预设抽离 + 分组

`presets` 提为模块级配置常量 `PRESETS`，带 `id/labelKey/group`，按 4 组渲染（单日/区间/周期/全部），组间用细分隔线：

```ts
type PresetGroup = 'day' | 'rolling' | 'period' | 'all'
interface PresetConfig { id: string; labelKey: string; group: PresetGroup }
```

高亮由「字符串全等」改为按 `activePreset`（预设 id）匹配；自定义范围时 `activePreset = null`。

### 5.2 联动日历范围选择器（TimeRangePicker）

**核心决策**：放弃「两个分离 datetime-local 输入框」，改为**单触发器 + 自绘日历弹层**，从根本上解决外观割裂与「选另一边麻烦」两个痛点。

- **同一面板内连点两日期**：点第 1 天标为「开始」→ 悬停实时预览 → 点第 2 天完成并自动收起面板。
- **智能重置**：结束点早于开始点 → 自动作为新的开始。
- **点同一天两次 = 单日**。
- **跨月**：面板内上月/下月翻页。
- **清空**：回到不限（start/end 置空）。
- **纯 CSS 主题化**（Polaris token 类名），零第三方依赖。

### 5.3 时间范围工具（timeRange.ts）

集中承载起止计算，`TokenStatsTab` 与 `TimeRangePicker` 共用：

- `startOfDay/endOfDay/addDays/todayStart/todayEnd`
- `dateToUnixSeconds(d)` — Date → Unix 秒（组件转给 store）
- `presetRange(preset)` — 返回 `[Date, Date]`；`all` 返回 `null`（不限）

> 周一为一周起点（ISO）；`lastWeek` = 上一自然周（周一 00:00 ~ 周日 23:59）；`lastMonth` = 上一自然月（1 日 ~ 月末）。

### 5.4 状态与数据流

- 状态从「datetime 字符串」改为 **`Date | null`**（`start`/`end`）。
- `buildFilters` 用 `dateToUnixSeconds` 转 Unix 秒；`s` 和 `e` 均非空才设置 `startDate/endDate`。
- 「全部」预设 → `start=end=null` → `filterParams` 不带时间范围 → store 返回全量。
- `onPreset(id)`：设 `activePreset` + 回填 `start/end` + 重查；`onRangeChange(s,e)`：清 `activePreset` + 重查。

### 5.5 i18n

`tokenStats` 命名空间新增：`allModels`、`refresh`、`preset.*`（8 项）、`presetGroup.*`（4 组）、`timeRange.*`（placeholder/clear/pickStart/pickEnd/weekdays），zh-CN / en-US 双写。

---

## 6. 数据模型

本次仅前端交互改动，**无后端/数据层改动**。`TokenFilterParams`、`getDailyTrends`、`getTopSessions` 均不变。

- 组件内状态由「datetime 字符串」改为 **`Date | null`**；`buildFilters` 经 `dateToUnixSeconds` 转回 Unix 秒，语义与后端接口完全一致。
- 「全部」= `start/end` 均为 `null` → `filterParams` 不携带时间范围 → store 返回全量。
- 移除了原 `dayStartInput/dayEndInput/toLocalInput/daysAgoDate/inputToUnix` 等字符串工具，收敛到 `utils/timeRange.ts`。

---

## 7. 验收标准（AC）

| # | AC | 状态 |
|---|----|------|
| 1 | 快捷区显示全部 8 项（今天/昨天/前天/近7天/近30天/上周/上月/全部），按 4 组清晰展示 | ✅ |
| 2 | 点击“昨天/前天”查询对应单日；“上周/上月”查询对应自然周/自然月 | ✅ |
| 3 | 点击“全部”清空时间范围，查询全量数据，且“全部”按钮高亮 | ✅ |
| 4 | 用日历选择自定义范围后，快捷项高亮清除，按所选范围查询 | ✅ |
| 5 | 时间范围控件为自绘日历，与 Polaris 主题统一，无原生 `datetime-local` 割裂外观 | ✅ |
| 6 | zh-CN / en-US 切换后，快捷项、分组、日历提示完整翻译，无中文残留 | ✅ |
| 7 | 分页、Top 请求、按时间/模型视图在新范围下数据正确 | ✅ |
| 8 | 无新增第三方依赖 | ✅ |

---

## 8. 风险与边界（已实施决策）

- **周起始日**：固定为周一（ISO），在 `timeRange.ts` 注释文档化；影响“上周”边界。
- **自然月 vs 滚动**：`lastMonth`（整自然月）与 `rolling30`（滚动30天）语义不同，UI 分组（周期/区间）已区分。
- **“全部”与默认“今天”**：默认进页为“今天”，可点“全部”切全量、再点“今天”回默认。
- **窄窗口布局**：8 项预设按 4 组折行，`FilterBar` 用 `flex-wrap` 允许换行，避免横向溢出。
- **时间精度**：Token 统计按天粒度，日历选择器覆盖需求；如需精确到时分秒可后续在日历底部加时间微调（本次未做）。

---

## 9. 后续待办（不在本次范围）

- 自定义快捷范围保存（localStorage 持久化用户常用范围）。
- 日历面板底部加时分秒时间微调（当前按天粒度）。
- 数据层支持任意滚动窗口（当前 `getDailyTrends` 固定 30d）。
- 时间粒度切换（按天/周/月聚合趋势图）。

---

## 10. 实施记录（2026-08-27）

| 文件 | 变更 |
|------|------|
| `src/utils/timeRange.ts` | 新增：日期范围工具 + `presetRange` + `dateToUnixSeconds` |
| `src/components/Common/TimeRangePicker.tsx` | 新增：联动日历范围选择器（单触发器 + 自绘日历弹层） |
| `src/components/Settings/tabs/TokenStatsTab.tsx` | `FilterBar` 预设抽离分组；接入 `TimeRangePicker`；状态改 `Date\|null`；移除字符串时间工具 |
| `src/locales/zh-CN/settings.json` | 新增 `preset.*`/`presetGroup.*`/`timeRange.*`/`allModels`/`refresh` |
| `src/locales/en-US/settings.json` | 同上英文翻译 |
| `docs/token-stats-time-range-prd.md` | 本 PRD 更新到 v1.1 |

**验证**：esbuild 语法校验全绿；本机 node_modules 损坏（tsc 因缺 `node`/`vite/client` 类型无法整仓编译），已手动审查类型（`Date | null` 收窄、`returnObjects` 断言、hooks 顺序）。
