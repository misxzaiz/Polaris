# Polaris AI 引擎子系统重构方案

> 版本：1.0.0
> 日期：2026-06-14
> 参考项目：codeg (D:\space\base\Polaris\temp\codeg)
> 分析报告：见上方对话 codeg Agent SDK 管理分析

---

## 一、问题诊断

### 1.1 已知问题清单

| # | 问题 | 严重度 | 来源 |
|---|------|--------|------|
| A | `EngineId` 重复定义：`ai/traits.rs` 和 `models/config.rs` 各一份，必须手动同步 | **高** | MEMORY.md "双 EngineId 同步陷阱" |
| B | 新增引擎时，必须在 `traits` + `config` + 前端 `types/config.ts` 三处同步 | **高** | 代码审查 |
| C | 无 Agent 元数据注册表：没有版本号、下载地址、平台二进制 URL | **中** | vs codeg registry.rs |
| D | `ModelProfile` 是配置文件数组，不是数据库实体：无 `updated_at`、无级联写入原生配置、无 stale session 标记 | **中** | vs codeg model_provider 表 |
| E | `env_overrides` 是扁平 `HashMap<String, String>`，无引擎特定的 key 映射 | **中** | vs codeg `agent_env_keys()` |
| F | 只支持 Claude 和 Codex 的会话历史回放，缺乏通用 `AgentParser` trait | **低** | vs codeg parsers/ |
| G | 前端 `EngineId` 类型含 `'agnes'` 但后端只有 4 个引擎，不一致 | **低** | types/config.ts vs ai/traits.rs |
| H | `SimpleAI` 引擎已完成 Phase 0-2 重构（子模块拆分 + 工具注册表），但尚未扩展到其他引擎 | — | simple-ai-codex-refactor-plan.md |

### 1.2 架构对比（Polaris vs codeg）

```
Polaris (当前)                        codeg (参考)
─────────────────────────────        ─────────────────────────────────
AIEngine trait (1 层抽象)            ACP 连接层 + Registry + Parser (3 层)
│                                    │
├─ ClaudeEngine ── spawn CLI         ├─ acp/connection.rs ── ACP stdio
├─ CodexEngine  ── spawn CLI         ├─ acp/registry.rs  ── 版本+分发+平台
├─ SimpleAI     ── HTTP API          ├─ parsers/claude.rs ── 85KB 专用解析
└─ MimoEngine   ── spawn CLI         ├─ model_provider 表 ── 级联写入原生配置
                                     └─ commands/acp.rs ── 精细化 env 映射
```

核心差距：Polaris 的抽象层太薄，每个引擎的元数据、分发、凭证管理、会话解析都散落在各处，新增引擎成本高。

---

## 二、目标架构

### 2.1 模块结构（重构后）

```
src-tauri/src/ai/
├── traits.rs              # AIEngine trait + EngineId（单一来源）
├── types.rs               # 共享类型
├── registry.rs            # EngineRegistry（引擎注册 + 元数据）
├── session.rs             # SessionManager
├── event_parser.rs        # 事件解析（Claude/Codex 共享）
│
├── agents/                # ★ 每个 agent 一个子模块
│   ├── mod.rs
│   ├── agent_meta.rs      # AgentMeta { type, name, desc, distribution, ... }
│   ├── claude/
│   │   ├── mod.rs         # ClaudeEngine（AIEngine impl）
│   │   ├── session.rs     # 会话管理
│   │   ├── env.rs         # ANTHROPIC_* 环境变量映射
│   │   └── history.rs     # 会话历史解析
│   ├── codex/
│   │   ├── mod.rs
│   │   ├── session.rs
│   │   ├── env.rs
│   │   └── history.rs
│   ├── simple_ai/         # 已完成 Phase 0-2 重构
│   │   └── ...
│   └── mimo/
│       ├── mod.rs
│       └── ...
│
├── providers/             # ★ 模型供应商子系统（替代 ModelProfile 数组）
│   ├── mod.rs
│   ├── entity.rs          # ModelProvider 数据库实体
│   ├── service.rs         # CRUD + 级联逻辑
│   ├── cascade.rs         # 配置级联：DB → agent 原生配置文件
│   └── preset.rs          # 供应商预设（SiliconFlow / OpenRouter / ...）
│
└── history/               # ★ 统一会话历史
    ├── mod.rs             # AgentParser trait
    ├── claude.rs
    ├── codex.rs
    └── types.rs
```

### 2.2 核心接口（重构后）

```rust
// ===== traits.rs =====

/// 引擎分发方式（对标 codeg AgentDistribution）
#[derive(Debug, Clone)]
pub enum AgentDistribution {
    /// npm 包（npx 启动）
    Npx {
        version: String,
        package: String,
        cmd: String,
        args: Vec<String>,
        node_required: Option<String>,
    },
    /// 平台二进制下载
    Binary {
        version: String,
        cmd: String,
        args: Vec<String>,
        platforms: Vec<PlatformBinary>,
    },
    /// Python uvx 包
    Uvx {
        version: String,
        package: String,
        cmd: String,
        args: Vec<String>,
    },
    /// 内置引擎（SimpleAI，无需外部 CLI）
    Builtin,
    /// 自定义路径（用户自行安装）
    CustomPath { cli_path: String },
}

/// Agent 元数据（对标 codeg AcpAgentMeta）
pub struct AgentMeta {
    pub agent_type: EngineId,
    pub name: &'static str,
    pub description: &'static str,
    pub distribution: AgentDistribution,
    /// 环境变量 key 映射（base_url, api_key, model）
    pub env_keys: (&'static str, &'static str, &'static str),
    /// 支持 model_provider 配置
    pub supports_model_provider: bool,
}

// AIEngine trait 增加方法
pub trait AIEngine: Send + Sync {
    // ... 现有方法保持不变 ...

    /// 获取引擎元数据
    fn meta(&self) -> AgentMeta;

    /// 安装/下载引擎（用于 Binary / Npx 分发）
    fn install(&self) -> Result<()>;

    /// 检查引擎是否有可用更新
    fn check_update(&self) -> Result<Option<String>>;
}
```

```rust
// ===== providers/entity.rs =====

/// 模型供应商数据库实体（替代 Config.model_profiles 数组）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProvider {
    pub id: i32,
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    pub api_key_masked: String,     // 脱敏后返回前端
    pub agent_type: EngineId,       // ★ 关联引擎类型
    pub model: Option<String>,      // JSON for Claude, plain for others
    pub wire_api: Option<String>,
    pub category: Option<String>,
    pub auth_type: Option<String>,
    pub custom_headers: Option<HashMap<String, String>>,
    pub custom_env: Option<HashMap<String, String>>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}
```

### 2.3 数据流（重构后）

```
用户创建/切换 ModelProvider
    │
    ▼
providers/service.rs → SQLite INSERT/UPDATE
    │
    ▼
providers/cascade.rs → 级联写入 agent 原生配置文件:
    ├─ Claude Code → ~/.claude/settings.json (config.env)
    ├─ Codex CLI   → ~/.codex/auth.json + config.toml
    └─ Mimo        → ~/.mimo/config.toml（如有）
    │
    ▼
标记受影响运行中会话为 "stale"（前端提示重启）
    │
    ▼
下次启动 agent 子进程时：
    ├─ 读取 agent_setting 获取 model_provider_id
    ├─ 查 provider 表获取 credentials
    ├─ agents/claude/env.rs: build_env() 映射 ANTHROPIC_* 变量
    └─ spawn CLI with env
```

---

## 三、分阶段实施计划

### Phase 0: 基础修复（预计 2 天）

**目标**：解决最痛的重复定义问题，为重构打底。

| 任务 | 描述 | 文件 |
|------|------|------|
| P0.1 | 统一 `EngineId` 定义到 `ai/traits.rs`，`models/config.rs` 改为 `pub use` 重导出 | traits.rs, config.rs |
| P0.2 | 清理 `models/config.rs` 中的 `EngineId` 重复定义，确保 `Config.validate()` 引用唯一来源 | config.rs |
| P0.3 | 前端 `EngineId` 类型对齐后端：去掉 `'agnes'`，或后端补充 `Agnes` 变体 | types/config.ts |
| P0.4 | 新增引擎检查清单写入 CLAUDE.md / MEMORY.md，防止日后再次分裂 | MEMORY.md |

**验收标准**：
- `grep -rn "enum EngineId" src-tauri/src/` 仅一处定义
- `cargo check --lib` 通过
- 前端 TypeScript 编译零错误

### Phase 1: Agent 元数据注册表（预计 4-5 天）

**目标**：引入 `AgentMeta` + `AgentDistribution`，对标 codeg registry。

| 任务 | 描述 | 文件 |
|------|------|------|
| P1.1 | 新建 `ai/agents/agent_meta.rs`：`AgentMeta` 结构体 + `AgentDistribution` 枚举 | agent_meta.rs |
| P1.2 | 为 4 个引擎各实现 `fn meta() -> AgentMeta` | claude/mod.rs, codex/mod.rs, simple_ai/mod.rs, mimo/mod.rs |
| P1.3 | `EngineRegistry` 增加 `register_with_meta()` + `list_agents()` + `check_updates()` | registry.rs |
| P1.4 | 前端新增 `AgentMeta` 类型镜像 + `useAgentMeta` hook | types/config.ts, stores/ |
| P1.5 | 设置页面展示引擎版本 + 可用更新提示 | Settings/EngineTab |

**验收标准**：
- 每个引擎可通过 `meta()` 获取版本号、分发方式、平台支持
- 前端可展示引擎列表（含版本号）
- 单元测试覆盖 `AgentMeta` 序列化/反序列化

### Phase 2: ModelProvider 数据库化（预计 5-7 天）

**目标**：`ModelProfile` 从配置文件数组迁移到 SQLite 表 + 级联写入。

| 任务 | 描述 | 文件 |
|------|------|------|
| P2.1 | 新建 `model_provider` 表（SeaORM entity） | db/entities/model_provider.rs |
| P2.2 | 新建 `agent_setting` 表（关联 engine_type + provider_id） | db/entities/agent_setting.rs |
| P2.3 | 实现 `ModelProviderService`（CRUD + 激活切换 + 级联） | providers/service.rs |
| P2.4 | 实现 `providers/cascade.rs`：写回 agent 原生配置文件 | providers/cascade.rs |
| P2.5 | 数据迁移：启动时自动将 `Config.model_profiles` 迁移到数据库 | commands/migration.rs |
| P2.6 | 前端 `modelProfileStore` 改为调用数据库 API（Tauri command / HTTP） | stores/modelProfileStore.ts |
| P2.7 | 前端设置页面适配新的 Provider 数据结构 | Settings/ModelProviderSettings |
| P2.8 | 兼容：保留 `Config.model_profiles` 字段读取，标记 `#[deprecated]` | config.rs |

**级联逻辑（对标 codeg `update_model_provider_core`）**：

```rust
// providers/cascade.rs
pub async fn cascade_provider_update(
    provider: &ModelProvider,
    conn: &DatabaseConnection,
) -> Result<CascadeResult> {
    let mut result = CascadeResult::default();

    // 1. 查找所有依赖此 provider 的 agent_setting
    let settings = agent_setting_service::find_by_provider(conn, provider.id).await?;

    for setting in &settings {
        match setting.agent_type {
            EngineId::ClaudeCode => {
                // 写入 ~/.claude/settings.json 的 config.env 段
                patch_claude_settings_json(provider, setting).await?;
                result.claude_patched += 1;
            }
            EngineId::Codex => {
                // 写入 ~/.codex/auth.json + config.toml
                patch_codex_config(provider, setting).await?;
                result.codex_patched += 1;
            }
            EngineId::MimoCode => {
                // 写入 ~/.mimo/config.toml（如有）
                patch_mimo_config(provider, setting).await?;
                result.mimo_patched += 1;
            }
            EngineId::SimpleAI => {
                // SimpleAI 不写磁盘，仅内存生效
                result.simple_ai_marked_stale += 1;
            }
        }

        // 标记受影响运行中会话为 stale
        mark_stale_sessions(provider.id, setting.agent_type).await?;
    }

    Ok(result)
}
```

**验收标准**：
- ModelProvider CRUD 通过数据库完成
- 更新 Provider 凭证后，Claude CLI 配置自动更新
- 前端可创建/编辑/删除 Provider，刷新后数据不丢失
- 数据迁移覆盖旧 `Config.model_profiles` → 新数据库表

### Phase 3: 环境变量映射精细化（预计 3 天）

**目标**：对标 codeg 的 `agent_env_keys()` + `CLAUDE_MODEL_KEY_MAP`。

| 任务 | 描述 | 文件 |
|------|------|------|
| P3.1 | 每个 agent 子模块实现 `env.rs`：`build_runtime_env()` + `env_keys()` | agents/claude/env.rs, agents/codex/env.rs |
| P3.2 | Claude 模型配置拆分为 5 槽位：main / reasoning / haiku / sonnet / opus | agents/claude/env.rs |
| P3.3 | 前端模型选择器支持多槽位配置（针对 Claude Code） | Settings/ModelSettings |
| P3.4 | `SessionOptions.env_overrides` 改为引擎感知：按引擎 ID 选择正确的 env key | traits.rs, chat commands |

**Claude Code 环境变量映射（对标 codeg）**：

```rust
// agents/claude/env.rs
pub fn env_keys() -> (&'static str, &'static str, &'static str) {
    ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL")
}

pub const CLAUDE_MODEL_KEY_MAP: &[(&str, &str)] = &[
    ("main",      "ANTHROPIC_MODEL"),
    ("reasoning", "ANTHROPIC_REASONING_MODEL"),
    ("haiku",     "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("sonnet",    "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opus",      "ANTHROPIC_DEFAULT_OPUS_MODEL"),
];
```

**验收标准**：
- 每个引擎有独立的 `env_keys()` 和 `build_runtime_env()`
- Claude Code 支持 5 个模型槽位的独立配置
- 不再出现"用 ANTHROPIC 变量名去配置 OpenAI 引擎"的错误

### Phase 4: 统一会话历史 Parser（预计 3-4 天）

**目标**：引入 `AgentParser` trait，统一所有引擎的会话历史解析。

| 任务 | 描述 | 文件 |
|------|------|------|
| P4.1 | 定义 `AgentParser` trait（对标 codeg） | history/mod.rs |
| P4.2 | `ClaudeHistoryProvider` 实现 `AgentParser` | history/claude.rs |
| P4.3 | `CodexHistoryProvider` 实现 `AgentParser` | history/codex.rs |
| P4.4 | 前端适配新的统一历史接口 | services/historyService.ts |
| P4.5 | （可选）为 SimpleAI 实现基于 SQLite 的历史回放 | history/simple_ai.rs |

**AgentParser trait**：

```rust
/// 统一会话历史解析器（对标 codeg parsers/AgentParser）
pub trait AgentParser: Send + Sync {
    /// 列出所有会话摘要
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError>;

    /// 获取单个会话完整内容
    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError>;

    /// 获取引擎类型
    fn agent_type(&self) -> EngineId;

    /// 获取会话存储路径
    fn storage_path(&self) -> Option<PathBuf>;
}
```

**验收标准**：
- Claude / Codex 历史解析通过 `AgentParser` trait 统一调用
- 新增引擎时只需实现 trait，无需改前端历史服务

### Phase 5: 引擎安装/更新自动化（预计 3 天）

**目标**：对标 codeg 的 `AgentDistribution`，支持一键安装引擎。

| 任务 | 描述 | 文件 |
|------|------|------|
| P5.1 | 实现 `install_agent()` Tauri command：按 `AgentDistribution` 下载/安装 | commands/agent.rs |
| P5.2 | 前端引擎管理页面展示安装状态 + 一键安装按钮 | Settings/EngineManagement |
| P5.3 | `check_update()` 利用 GitHub Releases API 检测新版本 | agents/agent_meta.rs |

**验收标准**：
- 未安装 Codex 的用户可在设置页面一键安装
- 已安装引擎可检测更新并提示

---

## 四、路线图总览

```
Phase 0: 基础修复        ██░░░░░░░░░░  2 天  ← 立即可开始
Phase 1: Agent 元数据     ████░░░░░░░░  4-5 天
Phase 2: ModelProvider DB ██████░░░░░░  5-7 天  ← 最大变更
Phase 3: 环境变量映射     ███░░░░░░░░░  3 天
Phase 4: 统一历史 Parser  ███░░░░░░░░░  3-4 天
Phase 5: 引擎安装自动化   ███░░░░░░░░░  3 天
                          ─────────────
                          总计 20-25 天
```

### 依赖关系

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3
                                      │
                                      ├──→ Phase 4
                                      └──→ Phase 5
```

- Phase 0 和 Phase 1 可并行
- Phase 3 依赖 Phase 2 的 ModelProvider 重构
- Phase 4 和 Phase 5 可并行，两者都依赖 Phase 2

---

## 五、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| ModelProfile 迁移丢数据 | 中 | **高** | 迁移前备份 `polaris.conf.json`，迁移后做 diff 校验 |
| 级联写入破坏用户手工配置 | 低 | 中 | 写入前备份原文件（`.bak`），冲突时合并而非覆盖 |
| `env_overrides` 行为变化导致已有 Profile 失效 | 中 | 中 | Phase 3 保留 `env_overrides` 作为 fallback，新旧两套并行 |
| 新增数据库表导致启动变慢 | 低 | 低 | SeaORM migration 只在首次启动执行；model_provider 表极轻量 |
| Phase 0 EngineId 统一定义破坏外部引用 | 低 | 中 | `pub use` 重导出保持路径兼容 |

---

## 六、迁移策略

### 6.1 配置迁移（Phase 2）

启动时自动检测 `Config.model_profiles` 是否包含数据：

```
App 启动
  ↓
检查 model_provider 表是否为空
  ├─ 不为空 → 跳过迁移（已迁移过）
  └─ 为空 → 读取 Config.model_profiles
              ├─ 无数据 → 跳过
              └─ 有数据 → 逐条 INSERT 到 model_provider 表
                          → 写标记文件 ~/.polaris/.model_provider_migrated
                          → 原 Config.model_profiles 保留但标记 deprecated
```

### 6.2 API 兼容

- 所有现有 Tauri command 签名不变
- 新增 command 使用新命名（`create_model_provider` vs 旧 `save_model_profile`）
- 前端 store 内部切换数据源，对外接口不变
- 旧 `Config.model_profiles` 读取路径保留 2 个大版本

---

## 七、验收检查清单

### Phase 0 验收
- [ ] `EngineId` 在 Rust 侧仅一处定义
- [ ] 前端 `EngineId` 与后端对齐
- [ ] `cargo check --lib` 通过
- [ ] TypeScript 编译零错误

### Phase 1 验收
- [ ] 每个引擎实现 `fn meta() -> AgentMeta`
- [ ] 前端展示引擎版本号
- [ ] 单元测试覆盖 AgentMeta

### Phase 2 验收
- [ ] ModelProvider CRUD 通过数据库
- [ ] Provider 更新后自动写入 Claude settings.json
- [ ] 旧 `Config.model_profiles` 自动迁移
- [ ] 前端 CRUD 功能完整

### Phase 3 验收
- [ ] Claude 5 槽位模型配置可用
- [ ] 每个引擎有独立的 env key 映射
- [ ] 旧 `env_overrides` 继续可用

### Phase 4 验收
- [ ] AgentParser trait 定义完整
- [ ] Claude/Codex 实现 AgentParser
- [ ] 前端适配统一接口

### Phase 5 验收
- [ ] 一键安装引擎功能可用
- [ ] 版本更新检测可用

---

## 八、与现有路线的整合

本方案与 `docs/feature-planning/roadmap.md` 的关系：

| Roadmap 项 | 本方案覆盖 | 说明 |
|------------|-----------|------|
| Agent 选择器 (Phase 1) | ✅ Phase 1 + Phase 5 | 元数据注册表 + 安装管理 |
| 模型配置 (Phase 2) | ✅ Phase 2 + Phase 3 | ModelProvider DB + 精细化模型槽位 |
| MCP 可视化配置 | ❌ 不覆盖 | 独立需求，不在本方案范围 |
| Plugin 管理 | ❌ 不覆盖 | 独立需求，不在本方案范围 |

本方案是 roadmap 中「Agent 选择器」和「模型配置」两项的深化实现。

---

*文档版本：1.0.0*
*参考项目：codeg (Agent SDK management analysis, 2026-06-14)*
