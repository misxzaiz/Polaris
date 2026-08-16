# 供应商调用统计面板 — PRD

## 1. 背景

当前 `RouteLogTab`（路由日志面板）仅展示**原始事件流**（首轮选择 / failover 切换 / 失败原因），
按 session 分组可折叠查看，但**没有任何按 Profile / Key 的聚合统计**。

用户无法回答以下问题：

- "今天哪个供应商被调用了多少次？"
- "某个 Key 的调用分布是否正确（RoundRobin 是否均匀）？"
- "failover 切换了多少次，集中在哪个供应商？"
- "某个供应商/Key 是否一直失败？"

同时，环形缓冲容量仅 200 条，高频会话几分钟就溢出，无法用作统计。

---

## 2. 目标

构建一个**供应商调用统计面板**（`ProviderStatsTab`），在设置侧边栏新增入口，
提供按 Profile / Key 维度的调用计数、成功率、failover 次数可视化。

### 非目标

- 不覆盖 Token 用量（已有 `TokenStatsTab`，引擎级统计，不按供应商分组拆分）
- 不覆盖单 Profile 旧路径的调用统计（仅限启用分组路由的会话）
- 不做实时探活或健康检查（仅消费路由决策日志 + 新增计数器 + 失败日志）

---

## 3. 数据模型

### 3.1 后端持久化计数器

独立于 `ProviderRouter` 的环形缓冲，新增 `ProfileStatsCollector`：

```rust
/// 单 Profile 统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStats {
    pub profile_id: String,
    pub profile_name: String,
    pub group_id: String,
    pub group_name: String,
    /// 被选为 initial 次数
    pub selected: u64,
    /// failover 切换到该 Profile 次数
    pub failover_in: u64,
    /// 从该 Profile failover 出去次数
    pub failover_out: u64,
    /// spawn 失败次数
    pub spawn_failed: u64,
    /// 绑定成功次数（引擎正常启动）
    pub bound: u64,
    /// 按 Key 的细分
    pub key_breakdown: HashMap<Option<usize>, KeyStats>,
    /// 最后活跃时间
    pub last_active_ms: u64,
}

/// 单 Key 统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStats {
    pub key_idx: Option<usize>,      // None = 用 Profile.apiKey
    pub selected: u64,
    pub failed: u64,
    pub last_active_ms: u64,
}

/// 全量统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatsSnapshot {
    pub profiles: Vec<ProfileStats>,
    pub groups: Vec<GroupStats>,
    /// 时间戳
    pub updated_at: u64,
    /// 总路由请求数（含 fallback）
    pub total_routes: u64,
}
```

### 3.2 持久化失败调用日志

独立于 `RouteLogEntry` 环形缓冲，新增持久化失败日志：

```rust
/// 失败调用日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedCallLog {
    pub seq: u64,
    pub ts_ms: u64,
    pub group_id: String,
    pub group_name: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub key_idx: Option<usize>,
    pub session_id: Option<String>,
    pub engine: Option<String>,
    /// 失败类型
    pub error_kind: FailedCallKind,
    /// 错误详情（原始错误消息摘要）
    pub error_message: String,
    /// 该轮尝试中已尝试的 Profile 列表
    pub tried: Vec<String>,
    /// failover 去的下一个 Profile（None = 全部不可用/回退）
    pub failover_to: Option<String>,
    /// 该轮总计尝试次数
    pub attempt: usize,
}

/// 失败类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FailedCallKind {
    /// 引擎 spawn 失败（CLI 起不来、连接拒绝）
    SpawnFailed,
    /// Profile 应用失败（apply_model_profile_options 报错）
    ApplyFailed,
    /// 全部组内 Profile 不可用
    AllUnavailable,
    /// 官方回退（用户指定分组但无激活分组）
    OfficialFallback,
    /// failover 切换（因失败主动切走）
    // 注：FailoverSwitch 本身不是"失败"，但切换出去的那个 Profile 的失败原因
    // 会被记录为 FailoverOut，附带 failover_to 指向下一个目标
    FailoverOut,
}
```

### 3.3 持久化路径

**计数器：** `<DataRoot>/provider-stats.json`，每次 `record_log` 时同步累加+写盘。

```rust
impl ProfileStatsCollector {
    pub fn record(&mut self, entry: &RouteLogEntry) { ... }
    pub fn snapshot(&self) -> ProviderStatsSnapshot { ... }
    pub fn load_from_disk(path: &Path) -> Self { ... }
    pub fn save_to_disk(&self, path: &Path) -> Result<()> { ... }
}
```

**失败日志：** `<DataRoot>/provider-failed-calls.jsonl`，**追加写 JSONL**，上限 1000 条，超出后截断前 500 条。

```rust
impl FailedCallCollector {
    pub fn record(&mut self, entry: &RouteLogEntry) -> Option<FailedCallLog> { ... }
    pub fn list(&self, filter: &FailedCallFilter) -> Vec<FailedCallLog> { ... }
    pub fn clear(&mut self) { ... }
    pub fn load_from_disk(path: &Path) -> Self { ... }
    pub fn save_to_disk(&self, path: &Path) -> Result<()> { ... }
}

/// 筛选参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedCallFilter {
    pub profile_id: Option<String>,
    pub error_kind: Option<FailedCallKind>,
    pub group_id: Option<String>,
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub offset: u64,
    pub limit: u64,
}
```

### 两种持久化路径对比

| | 计数器 (`provider-stats.json`) | 失败日志 (`provider-failed-calls.jsonl`) |
|---|---|---|
| 格式 | JSON 全量覆盖 | JSONL 追加写 |
| 存储量 | 极小（< 1KB） | 上限 1000 条 |
| 读模式 | 全量读取 | 支持分页/筛选 |
| 用途 | 聚合统计卡片 | 浏览/诊断失败链路 |

---

## 4. 后端变更

### 4.1 新增结构

| 项目 | 说明 |
|------|------|
| `ProfileStatsCollector` | 累加计数器，持 `HashMap<String, ProfileStats>` |
| `FailedCallCollector` | 持久化失败日志，JSONL 追加写，上限 1000 条 |
| `provider_stats` 命令 | 返回 `ProviderStatsSnapshot` |
| `provider_stats_clear` 命令 | 清空统计（重置） |
| `provider_failed_calls` 命令 | 返回 `Vec<FailedCallLog>`，支持筛选参数 |
| `provider_failed_calls_clear` 命令 | 清空失败日志 |

### 4.2 集成点

`AppState` 新增两个成员：

```rust
pub profile_stats_collector: Arc<AsyncMutex<ProfileStatsCollector>>,
pub failed_call_collector: Arc<AsyncMutex<FailedCallCollector>>,
```

在 `start_chat_inner` 的 `record_log` 处调用：

```rust
// 记录到计数器
state.profile_stats_collector.lock().await.record(&entry);
// 如果是失败事件，记录到失败日志
state.failed_call_collector.lock().await.record(&entry);
```

先在 `AppState::new()` 中加载磁盘文件，应用退出时保存（通过 `Drop` 或独立的 `flush` 命令）。

### 4.3 数据一致性

- 写盘频率：每条记录同步写（性能可接受，计数器操作极轻）或节拍写入（每 5s 批量写）
- 启动时若文件损坏，丢弃并清零重建（统计非关键数据）

---

## 5. 前端设计

### 5.1 设置侧边栏入口

在 `route-log` 后新增 `provider-stats`：

```tsx
{ id: 'provider-stats', icon: <PieChart size={16} />, labelKey: 'nav.providerStats' },
```

### 5.2 面板布局

```
┌─────────────────────────────────────────────────────────────────┐
│ [概览] [按供应商] [按分组] [按时间] [失败日志]                    │
├─────────────────────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                   │
│ │路由数  │ │选中数  │ │成功数  │ │失败数  │ │failover│           │
│ │  128  │ │  128  │ │  120  │ │   8   │ │   3   │               │
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                   │
├─────────────────────────────────────────────────────────────────┤
│ 按供应商（调用次数降序）                                         │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ DeepSeek V4    ████████████████████████████████  80 次 62.5% ││
│ │ GLM-5          ████████████████████              40 次 31.3% ││
│ │ Qwen3          ████                              8 次  6.3%  ││
│ └──────────────────────────────────────────────────────────────┘│
│                                                                 │
│ 按分组（策略分布）                                               │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ 主备分组 (Failover)                                           ││
│ │   DeepSeek V4  ████████████████████████████████  80 次  bound││
│ │   └ Key-0 40次 │ Key-1 40次  (RoundRobin ✓)                   ││
│ │   GLM-5        ████████████████████              40 次  bound││
│ │   └ Key-0 20次 │ Key-1 20次  (RoundRobin ✓)                   ││
│ │ failover: 3次 (DeepSeek→GLM 2次, GLM→DeepSeek 1次)           ││
│ └──────────────────────────────────────────────────────────────┘│
│                                                                 │
│ 按时间趋势（每日调用分布）                                       │
│ ┌──────────────────────────────────────────────────────────────┐│
│ │ ██  ████  ██████  ██████  ████  ██████  ██████              ││
│ │ 08/10 08/11 08/12 08/13 08/14 08/15 08/16                   ││
│ │ DeepSeek V4 ██ GLM-5 ██                                       ││
│ └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 视图切换

| 标签 | 内容 |
|------|------|
| **概览** | 5 个统计卡片 + Top 5 供应商横向柱状图 |
| **按供应商** | 表格：Profile / 选中 / failover入 / failover出 / 失败 / 成功率 / 最后活跃 |
| **按分组** | 每个分组一张卡片，成员列表+Key 细分+策略标记+轮询均匀度指示器 |
| **按时间** | 每日调用量趋势图（可选：堆叠柱状图按供应商着色） |
| **失败日志** | 持久化的失败调用记录，支持筛选/分页/展开详情 |

### 5.4 失败日志视图设计

**目标**：提供一个独立于路由事件流的、持久化的、可检索的失败调用记录列表，
让用户能方便地追踪"哪个供应商为什么失败、failover 去了哪里"。

**与现有路由日志的边界**：

| 维度 | RouteLogTab（路由日志） | 失败日志 Tab |
|------|----------------------|-------------|
| 记录范围 | 所有路由决策事件 | 仅失败事件 |
| 持久化 | 内存环形缓冲 200 条 | 磁盘 JSONL 上限 1000 条 |
| 用途 | 调试完整决策链路 | 集中诊断失败原因 |
| 筛选 | 无（按 session 分组） | 按 Profile/失败类型/时间范围 |
| 详情 | 单行展示 | 可展开的完整错误堆栈 |

**筛选栏**：

```
┌──────────────────────────────────────────────────────────────┐
│ [全部 Profile ▾] [全部类型 ▾] [全部分组 ▾] [今天 ▾] [🔍]    │
│                                                              │
│ 显示 12 条失败记录（共 47 条，仅显示最近 1000 条）            │
└──────────────────────────────────────────────────────────────┘
```

- **Profile 筛选**：下拉选择特定 Profile，默认"全部"
- **失败类型筛选**：下拉选择 `SpawnFailed` / `ApplyFailed` / `AllUnavailable` / `OfficialFallback` / `FailoverOut`，默认"全部"
- **分组筛选**：下拉选择特定分组，默认"全部"
- **时间范围**：快捷预设（今天/近7天/近30天）+ 自定义日期范围
- **搜索**：按错误关键词搜索（`error_message` 模糊匹配）

**列表行**：

```
┌──────────────────────────────────────────────────────────────┐
│ ╳ Spawn 失败  │ 16:23:48 │ DeepSeek V4 (Key-0) │ 连接拒绝  │
│   └ 会话 xxx · 引擎 claude · 已尝试: DeepSeek,GLM            │
│   └ 失败 → 自动 failover → GLM-5 (Key-1)                    │
├──────────────────────────────────────────────────────────────┤
│ ╳ 全部不可用  │ 16:20:12 │ 主备分组 │ 组内 3 个 Profile 全不可用│
│   └ 会话 yyy · 已尝试: DeepSeek,GLM,Qwen3                    │
│   └ 最终结果 → 回退官方端点                                  │
├──────────────────────────────────────────────────────────────┤
│ ╳ Apply 失败  │ 16:15:03 │ Qwen3 │ 配置文件格式错误          │
│   └ 会话 zzz · 引擎 simple · 已尝试: Qwen3                    │
│   └ 失败 → 自动 failover → DeepSeek V4 (Key-0)              │
└──────────────────────────────────────────────────────────────┘
```

**展开详情**：点击行展开完整错误消息（原始错误内容的截断，最多 500 字符），
以及该轮尝试的完整 Profile 链路：
```
┌──────────────────────────────────────────────────────────────┐
│ ▼ 展开详情                                                    │
│                                                              │
│ 完整错误消息:                                                  │
│ Connection refused (os error 61): connect to api.deepseek.com │
│ :443 failed. The target machine actively refused it.          │
│                                                              │
│ 尝试链路:                                                     │
│   ① DeepSeek V4  (Key-0)  → Spawn 失败                       │
│   ② GLM-5         (Key-1)  → 成功 (Bound)                    │
│                                                              │
│ 耗时: 2.3s · 总尝试: 2 轮                                    │
└──────────────────────────────────────────────────────────────┘
```

**空状态**：全部失败事件已清空 / 筛选条件下无匹配失败记录：
```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│     ✓ 没有失败记录                                            │
│     所有供应商分组路由均正常运行，未产生失败事件                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 5.4 关键 UI 特性

**概览卡片**：

| 指标 | 说明 |
|------|------|
| 路由总次数 | 所有分组路由决策次数 |
| 首轮选中分布 | 各 Profile 被 `select_initial` 选中的次数 |
| 绑定成功 | `Bound` 事件计数 |
| 失败次数 | `SpawnFailed` + `ApplyFailed` 之和 |
| failover 切换数 | `FailoverSwitch` 事件计数 |

**供应商统计表**：

| 列 | 说明 |
|----|------|
| Profile | 名称 + 颜色标记 |
| 分组 | 所属分组 |
| 选中 | 首轮被选次数 |
| Failover 入 | 作为 failover 目标次数 |
| Failover 出 | 从该 Profile 切换出去次数 |
| 失败 | spawn/apply 失败次数 |
| 成功率 | `bound / (selected + failover_in)` |
| Key 分布 | 若有多 Key，显示各 Key 调用占比 |
| 最后活跃 | 相对时间 |

**Key 均匀度指示器**：

- 对 RoundRobin 分组，自动计算各 Key 调用次数的标准差
- 标准差 < 10% 时显示绿色 ✓，> 20% 显示橙色 ⚠，> 40% 显示红色 ✗
- 鼠标悬停显示各 Key 具体计数

### 5.5 数据刷新

- 面板打开时全量拉取一次
- 不自动轮询（统计面板不要求实时性，手动刷新即可）
- 提供「刷新」按钮和「清空计数」按钮

---

## 6. Phase 规划

### Phase 1 — 后端计数器 + 失败日志（~2.5 人日）

- [ ] 实现 `ProfileStatsCollector` 结构体 + `record` / `snapshot` / `load` / `save`
- [ ] 实现 `FailedCallCollector` 结构体 + `record` / `list` / `clear` / JSONL 入盘
- [ ] 集成到 `AppState`，启动时加载两个文件，`record_log` 处同步调用
- [ ] 新增 `provider_stats` / `provider_stats_clear` / `provider_failed_calls` / `provider_failed_calls_clear` 命令
- [ ] 后端单元测试覆盖

### Phase 2 — 前端面板（~2.5 人日）

- [ ] 新增 `ProviderStatsTab` 组件（概览 + 按供应商 + 按分组 + 按时间 + 失败日志视图）
- [ ] 新增 `providerStatsStore`（类似 `routeLogStore`）
- [ ] 侧边栏注册 `provider-stats` 入口和 locale key
- [ ] 失败日志视图：筛选栏 + 列表 + 展开详情
- [ ] 无数据时展示空状态引导

### Phase 3 — 增强特性（~1 人日）

- [ ] Key 均匀度指示器（标准差计算 + 3 色标记）
- [ ] 按时间趋势图（每日堆叠柱状图）
- [ ] 成功率计算 + 健康度颜色标记

---

## 7. 与现有组件的关系

```
SettingsPage
├── SettingsSidebar
│   └── provider-stats (新增) ← PieChart icon
├── RouteLogTab          ← 保留，事件流详情
└── ProviderStatsTab     ← 新增，聚合统计
```

`ProviderStatsTab` 和 `RouteLogTab` 的数据源互补：

| | RouteLogTab | ProviderStatsTab |
|--|------------|-----------------|
| 数据 | 原始事件流 | 聚合计数器 |
| 容量 | 200 条环形缓冲 | 持久化，无上限 |
| 用途 | 调试单次路由决策链路 | 全局调用统计/健康度 |
| 刷新 | 3s 自动轮询 | 手动刷新 |

---

## 8. 风险与注意事项

- **计数器持久化频率**：每条路由记录都写盘可能产生 I/O 压力（高频查询场景）。
  建议：内存累加 + 5s 节拍写入，应用退出时 flush。
- **文件损坏恢复**：`provider-stats.json` 若损坏应静默丢弃并重建，
  不阻塞应用启动。
- **单 Profile 旧路径不覆盖**：统计面板只覆盖启用分组路由的会话，
  如需覆盖全量建议合并到 `TokenStatsTab` 的 `profileId` 字段扩展。

---

## 9. 参考实现

- `src-tauri/src/services/provider_router.rs` — 现有路由日志环形缓冲实现
- `src/stores/routeLogStore.ts` — 前端日志 store 参考
- `src/components/Settings/tabs/RouteLogTab.tsx` — 现有日志面板样式参考
- `src/components/Settings/tabs/TokenStatsTab.tsx` — 统计面板样式参考（卡片 + 表格 + 趋势图）
- `src-tauri/src/commands/chat.rs` — `record_log` 调用点