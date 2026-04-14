# 费用追踪功能规划文档

> 版本：1.0.0
> 日期：2026-04-14
> 状态：规划中

---

## 一、功能概述

为 Polaris 添加费用追踪和预算控制功能，让用户可以实时了解 API 使用成本，并设置预算限制。

### 目标用户

- 需要控制 API 成本的用户
- 团队管理员（成本核算）
- 频繁使用 API 的开发者

### 核心价值

1. **成本透明**：实时显示每次对话成本
2. **预算控制**：设置预算上限，防止超支
3. **使用分析**：了解成本分布和使用趋势
4. **决策支持**：帮助选择合适的模型

---

## 二、费用数据来源

### 2.1 CLI 输出中的费用信息

```json
// stream-json 格式的 result 事件
{
  "type": "result",
  "total_cost_usd": 0.16135,
  "usage": {
    "input_tokens": 32235,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "output_tokens": 7
  },
  "modelUsage": {
    "GLM-5": {
      "inputTokens": 32235,
      "outputTokens": 7,
      "costUSD": 0.16135
    }
  }
}
```

### 2.2 关键字段

| 字段 | 含义 |
|------|------|
| `total_cost_usd` | 本次对话总费用（美元） |
| `usage.input_tokens` | 输入 Token 数 |
| `usage.output_tokens` | 输出 Token 数 |
| `usage.cache_read_input_tokens` | 缓存读取 Token |
| `usage.cache_creation_input_tokens` | 缓存创建 Token |
| `modelUsage` | 按模型的详细使用情况 |

### 2.3 CLI 预算控制

```bash
# 设置最大预算
claude -p --max-budget-usd 1.0 "Your prompt"
```

---

## 三、UI 设计

### 3.1 实时费用显示

在对话区域底部显示当前会话费用：

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│ [对话内容...]                                               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ 💰 本次: $0.016 | 会话累计: $0.234 | 今日: $1.50           │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 输入消息...                                             │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 费用统计面板

```
┌─────────────────────────────────────────────────────────────┐
│ 📊 费用统计                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │                    本月费用趋势                          │ │
│ │     $5 ┤                                                │ │
│ │        │         ╭──╮                                   │ │
│ │     $3 ┤    ╭────╯  ╰────╮                              │ │
│ │        │    │              ╰───                         │ │
│ │     $1 ┤────╯                                            │ │
│ │        └──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──            │ │
│ │          1  5  10 15 20 25 30                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌──────────────┬──────────────┬──────────────┐            │
│ │    今日      │    本周      │    本月      │            │
│ │   $1.50     │   $8.23     │   $32.45    │            │
│ │  ↗ +12%    │  ↘ -5%     │  ↗ +8%     │            │
│ └──────────────┴──────────────┴──────────────┘            │
│                                                             │
│ ─── 按模型分布 ───                                          │
│                                                             │
│ Sonnet  ████████████████░░░░  68%  $22.07                  │
│ Haiku   ████████░░░░░░░░░░░░░  25%  $8.11                   │
│ Opus    ████░░░░░░░░░░░░░░░░░  7%   $2.27                   │
│                                                             │
│ ─── 按会话分布 ───                                          │
│                                                             │
│ 1. 多轮对话优化     $4.23   13%                            │
│ 2. Git 面板重构     $3.87   12%                            │
│ 3. MCP 配置开发     $2.56   8%                             │
│ ...                                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 预算设置面板

```
┌─────────────────────────────────────────────────────────────┐
│ ⚙️ 预算设置                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 启用预算控制                                                 │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [✓] 启用预算警告和限制                                  │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ 预算限制                                                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ○ 无限制                                                │ │
│ │ ◉ 每日预算                                              │ │
│ │   $ [5.00]                                              │ │
│ │ ○ 每月预算                                              │ │
│ │   $ [100.00]                                            │ │
│ │ ○ 单次对话预算                                          │ │
│ │   $ [1.00]                                              │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ 预算警告                                                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 当使用达到预算的 [80]% 时显示警告                       │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ 超限行为                                                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ◉ 显示警告，允许继续                                    │ │
│ │ ○ 阻止新对话，需要确认                                  │ │
│ │ ○ 完全阻止，直到预算重置                                │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.4 预算警告弹窗

```
┌─────────────────────────────────────┐
│ ⚠️ 预算警告                          │
├─────────────────────────────────────┤
│                                     │
│ 今日费用已达到 $4.50                 │
│ 预算限制: $5.00 (90%)               │
│                                     │
│ 剩余额度: $0.50                     │
│                                     │
│ 建议使用 Haiku 模型以节省成本。     │
│                                     │
│ [ ] 今日不再提醒                    │
│                                     │
│     [了解详情]    [继续使用]        │
└─────────────────────────────────────┘
```

### 3.5 组件拆分

| 组件 | 功能 | Props |
|------|------|-------|
| `CostDisplay` | 实时费用显示 | `sessionCost`, `dailyCost` |
| `CostStatsPanel` | 费用统计面板 | `stats` |
| `CostChart` | 费用趋势图表 | `data`, `period` |
| `BudgetSettings` | 预算设置 | `config`, `onChange` |
| `BudgetWarning` | 预算警告弹窗 | `usage`, `budget` |
| `ModelCostBreakdown` | 按模型费用分布 | `data` |

---

## 四、数据模型

### 4.1 TypeScript 类型

```typescript
// src/types/cost.ts

export interface CostRecord {
  id: string;
  sessionId: string;
  timestamp: Date;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
}

export interface CostStats {
  today: number;
  todayChange: number;
  week: number;
  weekChange: number;
  month: number;
  monthChange: number;
  byModel: Record<string, number>;
  bySession: Array<{ id: string; name: string; cost: number }>;
  dailyTrend: Array<{ date: string; cost: number }>;
}

export interface BudgetConfig {
  enabled: boolean;
  type: 'none' | 'daily' | 'monthly' | 'per-session';
  limit: number;
  warnPercent: number;
  actionOnLimit: 'warn' | 'confirm' | 'block';
}

export interface BudgetStatus {
  used: number;
  limit: number;
  percent: number;
  remaining: number;
}
```

### 4.2 数据存储

```typescript
// 费用记录存储
// 使用 IndexedDB 或 localStorage

interface CostStorage {
  records: CostRecord[];
  lastUpdated: Date;
}

// 配置存储
interface Config {
  budgetConfig?: BudgetConfig;
}
```

---

## 五、后端实现

### 5.1 费用记录服务

```rust
// src-tauri/src/services/cost_service.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostRecord {
    pub id: String,
    pub session_id: String,
    pub timestamp: DateTime<Utc>,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub model: String,
}

pub struct CostService {
    db_path: PathBuf,
}

impl CostService {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            db_path: config_dir.join("costs.db"),
        }
    }

    pub async fn record(&self, record: CostRecord) -> Result<(), String> {
        // 写入 SQLite 或 JSONL 文件
    }

    pub async fn get_stats(&self, period: StatsPeriod) -> Result<CostStats, String> {
        // 查询统计数据
    }

    pub async fn get_records(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<CostRecord>, String> {
        // 查询指定时间范围的记录
    }
}
```

### 5.2 Tauri Commands

```rust
// src-tauri/src/commands/cost.rs

#[tauri::command]
pub async fn record_cost(record: CostRecord) -> Result<(), String> {
    // 记录费用
}

#[tauri::command]
pub async fn get_cost_stats() -> Result<CostStats, String> {
    // 获取统计数据
}

#[tauri::command]
pub async fn get_budget_status() -> Result<BudgetStatus, String> {
    // 获取预算状态
}

#[tauri::command]
pub async fn set_budget_config(config: BudgetConfig) -> Result<(), String> {
    // 设置预算配置
}

#[tauri::command]
pub async fn get_budget_config() -> Result<BudgetConfig, String> {
    // 获取预算配置
}
```

### 5.3 与对话集成

修改事件处理，自动记录费用：

```typescript
// src/stores/conversationStore/eventHandler.ts

function handleResultEvent(event: ResultEvent) {
  // 记录费用
  if (event.total_cost_usd) {
    recordCost({
      sessionId: event.session_id,
      costUsd: event.total_cost_usd,
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
      // ...
    });
  }

  // 检查预算
  checkBudgetAndWarn(event.total_cost_usd);
}
```

---

## 六、前端实现

### 6.1 Store 设计

```typescript
// src/stores/costStore.ts

import { create } from 'zustand';

interface CostState {
  // 当前会话费用
  sessionCost: number;
  // 统计数据
  stats: CostStats | null;
  // 预算配置
  budgetConfig: BudgetConfig;
  // 预算状态
  budgetStatus: BudgetStatus | null;
  // 加载状态
  loading: boolean;

  // Actions
  recordCost: (record: CostRecord) => Promise<void>;
  fetchStats: () => Promise<void>;
  fetchBudgetStatus: () => Promise<void>;
  setBudgetConfig: (config: BudgetConfig) => Promise<void>;
  resetSessionCost: () => void;
  addSessionCost: (cost: number) => void;
}
```

### 6.2 服务层

```typescript
// src/services/costService.ts

import { invoke } from '@tauri-apps/api/core';

export const costService = {
  async recordCost(record: CostRecord): Promise<void> {
    return invoke('record_cost', { record });
  },

  async getStats(): Promise<CostStats> {
    return invoke('get_cost_stats');
  },

  async getBudgetStatus(): Promise<BudgetStatus> {
    return invoke('get_budget_status');
  },

  async setBudgetConfig(config: BudgetConfig): Promise<void> {
    return invoke('set_budget_config', { config });
  },

  async getBudgetConfig(): Promise<BudgetConfig> {
    return invoke('get_budget_config');
  },
};
```

---

## 七、实现计划

### Phase 1: 数据存储（1天）

1. 创建 SQLite/JSONL 数据存储
2. 实现 CostService
3. 实现 Tauri commands

### Phase 2: 费用记录（1天）

1. 集成到对话事件处理
2. 自动记录每次对话费用
3. 实现实时费用显示

### Phase 3: 统计面板（1天）

1. 创建费用统计面板
2. 实现趋势图表
3. 实现按模型/会话分布

### Phase 4: 预算控制（1天）

1. 创建预算设置界面
2. 实现预算警告逻辑
3. 实现超限处理

### Phase 5: 优化完善（0.5天）

1. 数据导出功能
2. 国际化支持
3. 性能优化

---

## 八、用户场景

### 场景 1：日常成本监控

```
用户打开 Polaris，看到：
- 今日已花费 $1.50
- 本月已花费 $32.45
- 趋势图显示使用情况

用户可以据此决定今天是否继续使用高级模型。
```

### 场景 2：预算警告

```
用户设置了每日 $5 预算
使用到 $4.50 时弹出警告
用户决定：
- 继续使用（点击"继续"）
- 切换到 Haiku 模型节省成本
- 停止使用到明天
```

### 场景 3：成本分析

```
用户查看月度报告：
- Sonnet 占用 68% 成本
- 几个会话占用了大部分费用
- 决定优化使用策略
```

---

## 九、数据隐私与安全

1. **本地存储**：所有费用数据存储在本地
2. **不上传**：不会上传到任何服务器
3. **可删除**：用户可以随时清除费用历史
4. **可导出**：支持导出为 CSV/JSON 格式

---

## 十、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 数据丢失 | 历史丢失 | 定期备份 + 云同步（可选） |
| 精度问题 | 显示不准 | 使用原始值 + 四舍五入显示 |
| 性能影响 | 卡顿 | 异步写入 + 批量处理 |

---

## 十一、后续扩展

1. **成本预测**：基于历史预测本月费用
2. **团队统计**：多用户费用汇总（团队版）
3. **成本优化建议**：AI 分析并给出优化建议
4. **预算自动调整**：根据使用模式自动调整预算

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
