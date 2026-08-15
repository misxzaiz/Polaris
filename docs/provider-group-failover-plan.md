# 模型供应商分组与 failover/轮询方案

> 状态：规划稿（2026-08-15）
> 优先引擎：**Claude Code**
> 策略：Failover（主备切换）优先，RoundRobin / Weighted 后续扩展
> 验证路径：真实端点 + Mock 双轨

---

## 1. 现状基线（已核实事实）

### 1.1 当前配置

| 项 | 值 | 来源 |
|----|----|------|
| config.json 路径 | `C:\Users\28409\AppData\Roaming\Polaris\config.json` | `data_root.rs:125` + `config_store.rs:32` |
| `model_profiles` | **空数组 `[]`** | 实际配置文件 |
| `active_model_profile_id` | `null` | 实际配置文件 |
| `default_engine` | `"claude-code"` | 实际配置文件 |

> ⚠️ **前置缺口**：要做轮询验证，必须先配置至少 2 个 Profile。当前无任何第三方端点配置。

### 1.2 可复用的现有能力

| 能力 | 位置 | 复用方式 |
|------|------|----------|
| 连接测试 | `model_profile_service.rs:719` `test_connection` | 健康检查探活；10s 超时；按 wire_api 分流；**400 视为可达** |
| 重试状态码判定 | `simple_ai/retry.rs:23` `is_retryable_status` | failover 触发模式：429 + 5xx 可重试，401/403 不重试 |
| 退避算法 | `simple_ai/retry.rs:29` `backoff_delay` | 同 Profile 内重试的退避：`base * 2^(attempt-1)` |
| Retry-After 解析 | `simple_ai/retry.rs:36` `parse_retry_after` | 尊重上游限流头 |
| settings overlay 生成 | `model_profile_service.rs:140` `write_settings_overlay` | failover 重新 apply Profile 的纯函数 |
| env overrides 生成 | `model_profile_service.rs:218` `generate_env_overrides` | 同上 |
| 代理启动 | `proxy/mod.rs:56` `start_proxy` | OpenAI 线路 Profile 的代理生命周期 |

### 1.3 关键缺口与约束

| 缺口 | 影响 | 处理 |
|------|------|------|
| `ProxyManager::stop_proxy` 定义了但**全代码库无调用方** | 代理不随 session 销毁，failover 切换会泄漏代理端口 | 方案必须显式调用 `stop_proxy` |
| `MockEngine.start_session` 始终返回 Err，无 event_callback 模拟 | 无法直接测试 failover loop 的异步 error 路径 | 需自建 `FailoverMockEngine` fixture |
| `ClaudeEngine` 无可注入假进程 hook | `Command::new(cli_path)` 硬编码 | failover loop 测试在 `chat.rs` 层做，不进引擎内部 |
| `apply_model_profile_options` 需要 `&AppState`，无测试覆盖 | 路由层无法隔离单测 | 测试用 Mock registry + 真 Profile 配置 |
| `start_session` 成功只代表进程起来了，不代表端点可用 | spawn 级 failover 覆盖不了 HTTP 级失败 | 需要"首字超时 + async error 判定"二段式 |
| Claude CLI `--timeout` 默认 30 分钟 | Polaris 无法依赖 CLI 自身超时做 failover | 必须在 `spawn_event_reader` 加独立首字计时器 |

### 1.4 failover 的三个切入点（已确认）

| 切入点 | 位置 | 覆盖的故障 | 可行性 |
|--------|------|-----------|--------|
| **A. spawn 前** | `chat.rs:1009-1020` 之上 | Profile 不存在 / 不兼容 / 代理起不来 | ✅ 最干净 |
| **B. spawn 失败** | `cmd.spawn().map_err()` 后 | CLI 路径错 / 命令行过长 / OS 拒绝 | ✅ 同步，直接重试 |
| **C. async error** | `claude.rs:1044-1073` fallback error 处 | HTTP 401/403/429/5xx / 超时 / 连接被拒 | ⚠️ 需判"是否已输出 token" |

**切入点 C 的硬约束**：一旦向用户输出了首段 assistant token，就不能切换（否则用户会看到"答到一半从头重来"）。只有"首字前失败"可透明切换。

---

## 2. 最佳方案：Failover 优先 + 会话亲和

### 2.1 数据结构

```rust
// models/config.rs 新增

/// 供应商分组策略
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteStrategy {
    /// 主备：按 priority 升序，主失败切备；同 priority 内轮询
    Failover,
    /// 纯轮询：每次新会话轮转，会话内锁定
    RoundRobin,
    /// 加权随机：按 weight 选择
    Weighted,
}

impl Default for RouteStrategy {
    fn default() -> Self { Self::Failover }
}

/// 触发 failover 的错误模式
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FailoverPattern {
    /// HTTP 状态码（401/403/429/5xx 等）
    HttpStatus { code: u16 },
    /// 首字超时（CLI 起来但迟迟不输出）
    FirstTokenTimeout,
    /// 连接被拒（spawn 后立即崩溃）
    ConnectionRefused,
    /// stderr 关键词匹配（如 "api key invalid"）
    StderrContains { pattern: String },
}

impl FailoverPattern {
    /// 默认 failover 触发模式集
    pub fn defaults() -> Vec<Self> {
        vec![
            Self::HttpStatus { code: 401 },
            Self::HttpStatus { code: 403 },
            Self::HttpStatus { code: 429 },
            Self::HttpStatus { code: 500 }, // 代表 5xx 全段
            Self::FirstTokenTimeout,
            Self::ConnectionRefused,
        ]
    }
}

/// 分组成员
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupMember {
    pub profile_id: String,
    /// Failover：数字小优先；同 priority 内轮询
    #[serde(default = "default_priority")]
    pub priority: u32,
    /// Weighted：权重值
    #[serde(default = "default_weight")]
    pub weight: u32,
}
fn default_priority() -> u32 { 0 }
fn default_weight() -> u32 { 1 }

/// 供应商分组
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderGroup {
    pub id: String,
    pub name: String,
    /// 分组策略
    #[serde(default)]
    pub strategy: RouteStrategy,
    /// 成员列表（Failover 策略下按 priority 升序处理）
    pub members: Vec<GroupMember>,
    /// 触发 failover 的错误模式（空 = 用 defaults）
    #[serde(default)]
    pub failover_on: Vec<FailoverPattern>,
    /// spawn 后首字超时秒数（None = 不做首字超时检测）
    #[serde(default)]
    pub first_token_timeout_secs: Option<u64>,
    /// 最多 failover 次数（防全死循环）
    #[serde(default = "default_max_failover")]
    pub max_failover_attempts: u32,
    /// 是否启用（false = 跳过此组，回退单 Profile）
    #[serde(default = "default_active")]
    pub active: bool,
}
fn default_max_failover() -> u32 { 3 }
fn default_active() -> bool { true }
```

### 2.2 Config 扩展

```rust
// models/config.rs Config 结构体新增字段
pub struct Config {
    // ... 现有字段 ...
    /// 供应商分组（failover/轮询）
    #[serde(default)]
    pub provider_groups: Vec<ProviderGroup>,
    /// 当前激活的分组 ID（None = 不启用分组，走单 Profile 旧路径）
    #[serde(default)]
    pub active_provider_group_id: Option<String>,
}
```

**语义优先级**：
1. 若 `active_provider_group_id` 指向一个存在的 active group → 走分组路由
2. 否则 → 回退到旧的 `active_model_profile_id` 单选路径（向后兼容）

### 2.3 路由决策层

新增 `src-tauri/src/services/provider_router.rs`：

```rust
pub struct ProviderRouter {
    /// 轮询游标（group_id -> 原子计数器）
    cursors: tokio::sync::Mutex<HashMap<String, u64>>,
    /// 会话亲和表（session_id -> profile_id）
    affinity: tokio::sync::Mutex<HashMap<String, String>>,
    /// 健康状态缓存（profile_id -> (healthy, last_check_ts)）
    health: tokio::sync::Mutex<HashMap<String, (bool, u64)>>,
}

impl ProviderRouter {
    /// 为新会话选择首个 Profile
    pub async fn select_initial(
        &self,
        group: &ProviderGroup,
        profiles: &[ModelProfile],
    ) -> Option<ModelProfile> {
        let healthy_members: Vec<_> = group.members.iter()
            .filter(|m| self.is_healthy(&m.profile_id, profiles))
            .collect();
        match group.strategy {
            RouteStrategy::Failover => {
                // priority 升序，取首个健康
                healthy_members.iter()
                    .min_by_key(|m| m.priority)
                    .and_then(|m| profiles.iter().find(|p| p.id == m.profile_id))
                    .cloned()
            }
            RouteStrategy::RoundRobin => {
                let idx = self.advance_cursor(&group.id, healthy_members.len());
                healthy_members.get(idx)
                    .and_then(|m| profiles.iter().find(|p| p.id == m.profile_id))
                    .cloned()
            }
            RouteStrategy::Weighted => {
                self.weighted_random(&healthy_members, profiles)
            }
        }
    }

    /// failover 时选下一个 Profile（跳过已尝试的）
    pub async fn select_next(
        &self,
        group: &ProviderGroup,
        tried: &[String],
        profiles: &[ModelProfile],
    ) -> Option<ModelProfile> {
        group.members.iter()
            .filter(|m| !tried.iter().any(|t| t == &m.profile_id))
            .filter(|m| self.is_healthy(&m.profile_id, profiles))
            .min_by_key(|m| m.priority) // Failover：下一个优先级
            .and_then(|m| profiles.iter().find(|p| p.id == m.profile_id))
            .cloned()
    }

    /// 判定错误是否触发 failover
    pub fn should_failover(err: &FailoverError, patterns: &[FailoverPattern]) -> bool {
        patterns.iter().any(|p| p.matches(err))
    }
}
```

### 2.4 failover loop 注入（切入点 A+B）

修改 `start_chat_inner`（`chat.rs:1009-1020`）：

```rust
// 伪代码 —— 实际实现需处理所有权与 AppState 锁
let group_id = resolve_active_group(state).await; // None 走旧路径
let tried_profiles: Vec<String> = Vec::new();
let max_attempts = group.max_failover_attempts;

for attempt in 0..max_attempts {
    let profile_id = if attempt == 0 {
        router.select_initial(&group, &profiles).await
    } else {
        router.select_next(&group, &tried_profiles, &profiles).await
    };

    let Some(profile) = profile_id else { break }; // 无可用 Profile

    // 若是 failover 重试，先清理上一个 Profile 的代理
    if attempt > 0 {
        if let Err(e) = state.proxy_manager.stop_proxy(&session_id).await {
            tracing::warn!("[failover] 停止旧代理失败: {}", e);
        }
    }

    let session_opts = apply_model_profile_options(
        session_opts_clone, Some(&profile.id), &engine, state, "start_chat", &session_id
    ).await?;

    let mut registry = state.engine_registry.lock().await;
    match registry.start_session(Some(engine), &final_message, session_opts) {
        Ok(temp_id) => {
            // 切入点 A 成功：进程已起
            // 注册首字超时 watcher（切入点 C）
            self.spawn_first_token_watcher(&temp_id, group.first_token_timeout_secs);
            router.bind_affinity(&temp_id, &profile.id); // 会话亲和
            return Ok(temp_id);
        }
        Err(e) if is_failoverable_spawn_err(&e) => {
            // 切入点 B：spawn 级失败，重试下一个 Profile
            tracing::warn!("[failover] spawn 失败 (attempt {}): {}", attempt + 1, e);
            tried_profiles.push(profile.id);
            continue;
        }
        Err(other) => return Err(other), // 不可 failover 的错误
    }
}
return Err("供应商分组全部 Profile 不可用".into());
```

### 2.5 首字超时 watcher（切入点 C）

新增 `spawn_first_token_watcher`，在 `start_session` 成功后启动：

```rust
fn spawn_first_token_watcher(
    &self,
    session_id: &str,
    timeout_secs: Option<u64>,
) {
    let Some(secs) = timeout_secs else { return };
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        // 检查是否已收到首段 assistant token
        if !self.has_received_first_token(&session_id).await {
            tracing::warn!("[failover] 首字超时 {}s，触发中断: {}", secs, session_id);
            // 中断当前进程，让上层 loop 重试下一个 Profile
            let _ = self.interrupt(&session_id).await;
            self.mark_failover_pending(&session_id).await;
        }
    });
}
```

**`has_received_first_token` 的实现**：需要 `spawn_event_reader` 在解析到第一个 `AIEvent::Assistant` / `assistant_delta` 时设置一个标志（`Arc<AtomicBool>`），watcher 读取该标志。

### 2.6 async error failover 判定

在 `spawn_event_reader` 的 fallback error 处（`claude.rs:1058-1073`）：

```rust
// 伪代码
if received_result_success { /* 正常完成 */ }
else {
    let has_token = first_token_flag.load(Ordering::Relaxed);
    let err = build_fallback_error_message(&stderr_buf);

    if !has_token && is_failoverable_stderr(&err, &patterns) {
        // 首字前失败 + 可 failover 模式 → 发特殊事件让上层重试
        event_callback(AIEvent::failover_signal(&session_id, err));
    } else {
        // 已输出 token 或不可 failover → 正常报错
        event_callback(AIEvent::error(&session_id, err));
        event_callback(AIEvent::SessionEnd(/* Error */));
    }
}
```

---

## 3. 验证方案

### 3.1 验证矩阵

| 验证目标 | 数据来源 | 策略 | 切入点 | 覆盖的故障类型 |
|---------|---------|------|--------|----------------|
| **V1: spawn 级 failover** | Mock | Failover | A+B | CLI 路径错 / 代理起不来 |
| **V2: HTTP 401 failover** | 真实端点 | Failover | A+C | 认证失败自动切备 |
| **V3: 首字超时 failover** | Mock | Failover | C | CLI 起来但不输出 |
| **V4: RoundRobin 轮询** | 真实端点 | RoundRobin | A | 负载均衡 |
| **V5: 会话亲和** | 真实端点 | RoundRobin | A | 续聊不换 Profile |
| **V6: 代理清理** | 真实端点 | Failover | A+B+C | 切换不泄漏端口 |
| **V7: 全死兜底** | Mock | Failover | A+B+C | 所有 Profile 失败 → 友好报错 |

### 3.2 Mock 验证路径（不依赖真实端点）

#### 3.2.1 新增 `FailoverMockEngine`

```rust
// src-tauri/src/ai/engine/failover_mock.rs (test only)
#[cfg(test)]
pub struct FailoverMockEngine {
    config: Config,
    sessions: SessionManager,
    /// 注入的失败行为：profile_id -> 行为
    behaviors: HashMap<String, MockBehavior>,
    /// 是否已收到首字（per session）
    first_token_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[cfg(test)]
pub enum MockBehavior {
    /// spawn 直接失败（切入点 B）
    SpawnFail(String),
    /// spawn 成功，但首字超时（切入点 C）
    FirstTokenTimeout { delay_secs: u64 },
    /// spawn 成功，输出部分后报错（切入点 C，不可 failover）
    PartialOutputThenError { tokens: usize },
    /// 正常成功
    Success,
}
```

`FailoverMockEngine` 实现 `AIEngine`，按注入的 `MockBehavior` 模拟 `claude.rs:1044-1073` 的所有分支，让 failover loop 可在不启动真实 CLI 的情况下测试。

#### 3.2.2 Mock 测试用例

```rust
#[tokio::test]
async fn v1_spawn_level_failover_switches_to_backup() {
    // 主 Profile: SpawnFail("CLI 路径不存在")
    // 备 Profile: Success
    // 断言: 最终用备 Profile 成功，tried 包含主
}

#[tokio::test]
async fn v3_first_token_timeout_triggers_failover() {
    // 主 Profile: FirstTokenTimeout { 60s }
    // 备 Profile: Success
    // first_token_timeout_secs: 5
    // 断言: 5s 后中断主，切备成功
}

#[tokio::test]
async fn v3_partial_output_does_not_failover() {
    // 主 Profile: PartialOutputThenError { tokens: 100 }
    // 断言: 不切换，直接报错（已有输出不可回滚）
}

#[tokio::test]
async fn v7_all_profiles_dead_returns_friendly_error() {
    // 两个 Profile 都是 SpawnFail
    // 断言: 返回"全部不可用"错误，不无限循环
}
```

### 3.3 真实端点验证路径

#### 3.3.1 最小配置（需用户补充端点）

```json
// config.json model_profiles 新增（至少 2 个）
[
  {
    "id": "main-provider",
    "name": "主供应商",
    "base_url": "https://<你的主端点>",
    "api_key": "<主 key>",
    "model": "claude-sonnet-4-5",
    "wire_api": "anthropic-messages",
    "category": "aggregator",
    "active": false
  },
  {
    "id": "backup-provider",
    "name": "备用供应商",
    "base_url": "https://<你的备端点>",
    "api_key": "<备 key>",
    "model": "claude-sonnet-4-5",
    "wire_api": "anthropic-messages",
    "category": "aggregator",
    "active": false
  }
]
```

#### 3.3.2 分组配置

```json
{
  "provider_groups": [
    {
      "id": "ha-group",
      "name": "高可用组",
      "strategy": "failover",
      "members": [
        { "profile_id": "main-provider", "priority": 0, "weight": 1 },
        { "profile_id": "backup-provider", "priority": 1, "weight": 1 }
      ],
      "failover_on": [],
      "first_token_timeout_secs": 30,
      "max_failover_attempts": 3,
      "active": true
    }
  ],
  "active_provider_group_id": "ha-group"
}
```

#### 3.3.3 真实验证用例

| 用例 | 操作 | 预期 |
|------|------|------|
| **V2: 401 failover** | 故意把 `main-provider` 的 api_key 改错 | 首字前收到 401 → 自动切 `backup-provider` → 成功回复 |
| **V4: RoundRobin** | 策略改 `round_robin`，连续发起 3 个新会话 | 3 个会话分别命中 main/backup/main |
| **V5: 会话亲和** | 在一个会话里连续发 3 条消息 | 3 条都命中同一 Profile |
| **V6: 代理清理** | 用 OpenAI 线路 Profile（需代理），触发 failover | 旧代理端口被 stop，新代理启动 |
| **健康检查** | 调 `test_connection` 测两个 Profile | 结果缓存到 `health` map |

#### 3.3.4 401 failover 的端到端验证流程

```
1. 配置 main-provider api_key = "invalid-key"
2. 启动会话
3. ClaudeEngine spawn 成功（切入点 A 通过）
4. CLI 向上游发请求 → 收到 401
5. CLI 输出 stderr "Error: 401 ..." 后退出
6. spawn_event_reader: stdout EOF, 未收到 result(success)
7. first_token_flag = false（首字前失败）
8. is_failoverable_stderr("401") = true → 发 failover_signal 事件
9. 上层 loop 收到 signal → stop_proxy(main) → select_next → apply(backup) → spawn
10. 新 CLI 用正确 key → 正常输出 → 用户看到回复（透明切换）
```

### 3.4 验证步骤顺序（建议）

```
Phase 1 (Mock, 不需端点):
  V1 spawn 级 failover → V3 首字超时 → V3 不可 failover → V7 全死兜底
  ↓ 跑通 failover loop 核心逻辑

Phase 2 (真实端点):
  补配置 2 个 Profile → V2 401 failover → V6 代理清理
  ↓ 跑通端到端切换

Phase 3 (真实端点, 扩展策略):
  V4 RoundRobin → V5 会话亲和
  ↓ 跑通多策略
```

---

## 4. 改动文件清单

### 4.1 Rust 后端

| 文件 | 改动 | 大小 |
|------|------|------|
| `models/config.rs` | 新增 `ProviderGroup`/`GroupMember`/`RouteStrategy`/`FailoverPattern` 结构 + `Config` 两字段 | S |
| `services/provider_router.rs` | **新建** 路由决策层（select_initial/select_next/should_failover/健康缓存/亲和表/轮询游标） | M |
| `commands/chat.rs` | `start_chat_inner`/`continue_chat_inner` 加 failover loop（切入点 A+B）；抽出 `apply_model_profile_options` 调用为可重入 | M |
| `ai/engine/claude.rs` | `spawn_event_reader` 加 `first_token_flag`（`Arc<AtomicBool>`）；fallback error 处加可 failover 判定（切入点 C） | M |
| `ai/engine/mod.rs` | 导出新结构 | S |
| `services/proxy/mod.rs` | 确认 `stop_proxy` 可用（已存在但无调用方，首次接线） | S |
| `services/mod.rs` | 导出 `provider_router` | S |
| `ai/engine/failover_mock.rs` | **新建** 测试用 Mock 引擎 | M |
| `ai/registry.rs` | 测试模块加 failover loop 集成测试 | M |
| `lib.rs` | `AppState` 注入 `ProviderRouter` | S |

### 4.2 前端

| 文件 | 改动 | 大小 |
|------|------|------|
| `types/modelProfile.ts` | 镜像 Group/Member/Strategy/FailoverPattern 类型 | S |
| `types/config.ts` | `Config` 加两字段 | S |
| `components/Settings/tabs/ModelProviderTab.tsx` | 新增"分组管理"UI（组列表 + 成员优先级/权重 + 策略选择 + failover 模式配置） | L |
| `stores/configStore.ts` | Group CRUD + 激活态管理 | M |
| `stores/modelProfileStore.ts` | 与 Group 联动 | M |

### 4.3 文档

| 文件 | 内容 |
|------|------|
| `docs/provider-group-failover-plan.md` | 本文档 |

---

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 首字超时阈值难定（太短误杀长冷启动，太长失去 failover 意义） | 默认 30s，可配；`first_token_timeout_secs` 按端点特性调整 |
| stderr 模式匹配脆弱（不同供应商错误格式不统一） | 优先用 HTTP 状态码 + 超时；stderr 只作兜底，提供 `StderrContains` 自定义 |
| 同组 Profile 模型不一致导致切换后风格突变 | 文档建议同组用同模型；UI 加校验提示 |
| 代理模式 failover 生命周期复杂 | 显式 stop_proxy + start_proxy；V6 用例专测泄漏 |
| `active` 单选语义与分组冲突 | 分组激活时优先；分组未激活回退旧路径（向后兼容） |
| failover loop 与 session_id 生成耦合 | `session_id` 在 loop 外生成（`chat.rs:1007` 已是如此），failover 内复用 |
| MockEngine 无法模拟 async error | 新建 `FailoverMockEngine`，不修改现有 MockEngine |

---

## 6. 落地阶段

| 阶段 | 内容 | 验证 | 依赖 |
|------|------|------|------|
| **P1** | 数据结构 + provider_router + 切入点 A+B + FailoverMockEngine | V1/V3/V7（Mock） | 无 |
| **P2** | 切入点 C（first_token_flag + async error failover）+ 代理 stop 接线 | V3 async + V6 | P1 |
| **P3** | 前端分组管理 UI + 健康检查后台探活 | 手动验证 | P1+P2 |
| **P4** | RoundRobin/Weighted 策略 + 会话亲和完善 | V4/V5 | P3 |
| **P5** | 迁移：旧 `active_model_profile_id` 用户平滑升级到分组（可选） | 回归测试 | P3 |

---

## 7. 待确认设计决策

以下需用户确认后细化：

1. **首字超时默认值**：30s 是否合理？还是按 Profile 的 `context_window` 动态计算？
2. **同组模型不一致处理**：切换时若新 Profile 模型不同，是允许（提示用户）还是禁止（UI 校验）？
3. **是否允许跨 wire_api 混组**：如一个 anthropic-messages + 一个 openai-chat-completions 混在一个组？技术上可行（都走代理），但配置复杂度高。
4. **健康检查频率**：后台探活间隔多久？每次 failover 前实时探活还是用缓存？
5. **failover 事件是否对用户可见**：透明切换（用户无感）还是发一条"已从 A 切换到 B"提示？
6. **测试数据**：P2 真实验证需要你提供 2 个可用端点；是否先用 Mock 跑通 P1 再决定？
