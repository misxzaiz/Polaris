# Refactor:专家存储全局化(Agent Global Storage)

> 状态:**已实施 v1**(P1+P2+P3 同批,2026-07-26)
> 日期:2026-07-26
> 关联记忆:`agent-self-service-implementation` / `agency-agents-integration-plan`
> 前置 spec:`docs/agent-self-service-spec.md`

## 1. 问题

当前专家(自定义 agent)落盘在**项目级** `<workspace>/.polaris/agents/<slug>.md`,与所有其他设置(plugins/scheduler/prompt_snippet/requirement/mobile_config 等,均在全局 `<DataRoot>`)不一致:

- 专家是唯一落盘到项目目录的配置
- A 项目建的专家 B 项目用不了
- 设置页看不到专家文件,无法统一管理
- 专家团 `rosters-user.json` 已在全局,专家却在项目,两者割裂

用户诉求:**专家也放全局**,与其他设置一致。

## 2. 目标与非目标

### 目标
- 专家落盘改为全局 `<DataRoot>/agents/<slug>.md`,与专家团 `rosters-user.json` 同目录。
- `discover_agents` / `load_agent` / `load_agent_def` 读取改为全局路径,**不再依赖 workDir**。
- MCP `save_agent` / `delete_agent` / `list_agents` 的 `workDir` 参数移除(或保留但忽略,过渡期)。
- 前端 `agentStore` 加载专家不再需要 workspace(启动即可加载)。

### 非目标
- 不保留项目级 `.polaris/agents/` 作为覆盖层(纯全局,无双源)。
- 不做导入/迁移旧项目级专家(用户量小,手动重建;文档标注)。
- 不改专家团 `rosters-user.json` 位置(已在全局,不动)。

## 3. 现状盘点(已核实代码)

### 后端落盘/读取点
| 位置 | 现行为 | 改动 |
|---|---|---|
| `commands/agent_corpus.rs::custom_agents_dir(work_dir)` | `Path::new(work_dir).join(".polaris").join("agents")` | 改为 `agents_dir().join("corpus")` 或直接 `agents_dir()` |
| `custom_agent_save_inner` | 落 `<workDir>/.polaris/agents/<slug>.md` | 落 `<DataRoot>/agents/<slug>.md` |
| `custom_agent_delete_inner` | 删 `<workDir>/.polaris/agents/<slug>.md` | 删 `<DataRoot>/agents/<slug>.md` |
| `custom_agent_list_inner` | `list_project_agents(work_dir)` | `list_agents_global()`(新,无 workDir) |
| `simple_ai/agent.rs::agent_dirs(work_dir)` | `[work_dir/.polaris/agents]` | `[<DataRoot>/agents]` |
| `discover_agents(work_dir)` / `discover_project_agents(work_dir)` | 扫项目级 | 扫全局(两者合并为无参) |
| `load_agent(work_dir, name)` | 项目级查 | 全局查 |
| `load_agent_def(work_dir, slug)` | 项目级读 | 全局读(无 workDir) |
| `simple_ai/mod.rs::list_agents` / `list_project_agents` | 两函数均传 work_dir | 合并为一个无参 `list_agents()` |

### 调用点(需同步改签名)
| 文件 | 调用 | 改动 |
|---|---|---|
| `claude.rs:376` `build_command` | `load_agent_def(&work_dir, a)` | `load_agent_def(a)`(去 work_dir) |
| `nexus_pipeline.rs:396` `load_agent_persona` | `load_agent_def(work_dir, slug)` | `load_agent_def(slug)` |
| `ask_listener.rs:643` `register_dispatch_task` | `load_agent_def(wd, role_name)` | `load_agent_def(role_name)` |
| `ask_listener.rs::handle_agent_save_frame` | `custom_agent_save_inner(work_dir, ...)` | `custom_agent_save_inner(...)`(去 work_dir) |
| `ask_listener.rs::handle_agent_delete_frame` | `custom_agent_delete_inner(work_dir, slug)` | `custom_agent_delete_inner(slug)` |
| `ask_listener.rs::handle_agent_list_frame` | `list_project_agents(work_dir)` | `list_agents_global()` |
| `simple_ai/mod.rs:248` chat_loop | `agent::load_agent(&work_dir, agent_name)` | `agent::load_agent(agent_name)` |
| `simple_ai/tools/agent.rs:66` | `agent::load_agent(ctx.work_dir, agent_name)` | `agent::load_agent(agent_name)` |
| `commands/agent_corpus.rs` Tauri 命令 | `custom_agent_list/save/delete(work_dir, ...)` | 去 work_dir 参数 |
| `web/api/ipc.rs` | 桥接 `custom_agent_*` 取 workDir | 去 workDir |

### MCP 工具(dispatch_mcp_server.rs)
| 工具 | 现入参 | 改动 |
|---|---|---|
| `save_agent` | slug/name/description/systemPrompt/emoji/tools/workDir? | 删 workDir |
| `delete_agent` | slug/workDir? | 删 workDir |
| `list_agents` | workDir? | 删 workDir |
| `save_roster` | (不变) | 不动 |
| `resolve_work_dir` 函数 | 用于上述三工具 | 删除 |
| `DispatchMcpConfig.work_dir` | 启动注入 | 删除字段 + `--polaris-workdir` 参数 |

### 前端
| 文件 | 改动 |
|---|---|
| `services/tauri/agentCorpusService.ts` | `listCustomAgents`/`saveCustomAgent`/`deleteCustomAgent` 去 workDir 参数 |
| `stores/agentStore.ts` | `loadCustomAgents(workDir)` → `loadCustomAgents()`;`saveCustom`/`deleteCustom` 去 workDir;`load()` 内直接调 `loadCustomAgents()` |
| `hooks/useAppInit.ts` | 不再传 ws 给 loadCustomAgents;`store.load()` 内已加载 |
| `components/Agent/AgentGalleryPanel.tsx` | 删 `workspacePath`/`loadCustomAgents(workspacePath)` useEffect;Toast 文案 `.polaris/agents/` → `数据存储/agents/` |
| `components/Chat/ChatInput.tsx` | `customAgents` 消费不变(已从 store 取) |
| `components/Chat/SessionConfigSelector.tsx` | 不变(从 store 读) |

## 4. 设计

### 4.1 新存储布局

```
<DataRoot>/                      # 如 C:\Users\28409\AppData\Roaming\Polaris
├── agents/                       # 专家与专家团统一目录
│   ├── <slug>.md                 # 单个专家(全局)
│   ├── <slug2>.md
│   └── rosters-user.json         # 用户专家团(已有,不动)
├── plugins/
├── scheduler/
└── ...
```

专家 `.md` 直接铺在 `<DataRoot>/agents/` 根目录(与 `rosters-user.json` 同级),不再下沉 `corpus/` 子目录。理由:专家和专家团是同级概念,铺平便于 `discover_agents` 扫描与人工管理。

### 4.2 后端核心改造

#### `commands/agent_corpus.rs`
```rust
/// 专家落盘根目录:<DataRoot>/agents/
pub fn agents_dir() -> PathBuf {
    data_root().root().join("agents")
}

// custom_agents_dir 删除(不再项目级)

pub fn custom_agent_save_inner(
    slug: &str, name: &str, description: &str,
    emoji: &str, system_prompt: &str, tools: &[String],
) -> Result<PathBuf> {
    validate_custom_slug(slug)?;
    // ... frontmatter 拼接同前 ...
    let dir = agents_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{slug}.md"));
    std::fs::write(&path, format!("{fm}{}\n", system_prompt.trim()))?;
    Ok(path)
}

pub fn custom_agent_delete_inner(slug: &str) -> Result<()> { ... }
pub fn custom_agent_list_inner() -> Vec<CustomAgentItem> { ... }  // 去 work_dir
```

Tauri 命令包装同步去 work_dir 参数。

#### `simple_ai/agent.rs`
```rust
fn agent_dirs() -> Vec<PathBuf> {
    vec![crate::services::data_root::data_root().root().join("agents")]
}

pub(crate) fn discover_agents() -> Vec<AgentDefinition> {
    discover_agents_in(&agent_dirs())
}
// discover_project_agents 删除(合并)

pub(crate) fn load_agent(name: &str) -> Option<AgentDefinition> { ... }
pub fn load_agent_def(slug: &str) -> Option<(String, String, String)> { ... }
```

`mod.rs::list_agents` / `list_project_agents` 合并为 `list_agents()`(无参)。

#### `ask_listener.rs::handle_agent_*_frame`
帧入参去掉 workDir,直接调无参纯函数。`agent_save` 帧不再带 workDir 字段。

#### `dispatch_mcp_server.rs`
- `SAVE_AGENT_TOOL_NAME` / `DELETE_AGENT_TOOL_NAME` / `LIST_AGENTS_TOOL_NAME` 的 inputSchema 删 workDir 属性
- `build_agent_save_frame` / `build_agent_delete_frame` / `build_agent_list_frame` 不再调 `resolve_work_dir`,帧不传 workDir
- `resolve_work_dir` 函数删除
- `DispatchMcpConfig.work_dir` 字段删除 + `--polaris-workdir` CLI 参数删除 + `mcp_config_service` AskListener 模式不再注入 workspace_path
- `handle_initialize` 的 `instructions` 文案更新:去掉 workDir 说明

### 4.3 前端改造

`agentStore`:
```ts
loadCustomAgents: async () => {
  const customAgents = await listCustomAgents();  // 无参
  set({ customAgents, catalog: customAgents.map(toCatalogEntry), loaded: true });
},
load: async () => {
  if (get().loading) return;
  set({ loading: true });
  await get().loadCustomAgents();  // 启动即可加载,无需 workspace
  set({ loading: false });
},
saveCustom: async (params) => {  // params 无 workDir
  await saveCustomAgent(params);
  await get().loadCustomAgents();
},
```

`useAppInit.ts`:`store.load()` 内部已加载 customAgents,不再单独调 `loadCustomAgents(ws)`。

`AgentGalleryPanel.tsx`:删 `workspacePath` 相关 useEffect,Gallery 数据启动即就绪。

### 4.4 SimpleAI `options.agent` 兼容

SimpleAI 引擎 `options.agent` 调 `load_agent(name)`(原 `load_agent(work_dir, name)`)。签名改无参 work_dir 后,调用点 `simple_ai/mod.rs:248` 与 `simple_ai/tools/agent.rs:66` 同步改。工具描述 `.polaris/agents/<name>.md` 改为"全局 agents 目录"。

## 5. 变更清单

### 后端(Rust)
| 文件 | 改动 |
|---|---|
| `commands/agent_corpus.rs` | `custom_agent_save/delete/list_inner` 去 work_dir;`custom_agents_dir` 删;Tauri 命令去 work_dir |
| `ai/engine/simple_ai/agent.rs` | `agent_dirs` 改全局;`discover_agents`/`load_agent`/`load_agent_def` 去 work_dir;`discover_project_agents` 删 |
| `ai/engine/simple_ai/mod.rs` | `list_agents`/`list_project_agents` 合并无参;re-export 不变 |
| `ai/engine/simple_ai/tools/agent.rs` | `load_agent` 调用去 work_dir;工具描述更新 |
| `ai/engine/claude.rs` | `load_agent_def` 调用去 work_dir;`work_dir` 局部变量删;warn 文案更新 |
| `services/ask_listener.rs` | `load_agent_def` 调用去 work_dir;`handle_agent_*_frame` 去 workDir;`register_dispatch_task` 去 work_dir |
| `services/nexus_pipeline.rs` | `load_agent_persona` 去 work_dir;调用点改 |
| `services/dispatch_mcp_server.rs` | 三工具 inputSchema 去 workDir;`build_*_frame` 去 workDir;删 `resolve_work_dir`;`DispatchMcpConfig.work_dir` 删;instructions 更新 |
| `bin/polaris_dispatch_mcp.rs` | `--polaris-workdir` 参数解析删 |
| `services/mcp_config_service.rs` | AskListener 模式不再 push `--polaris-workdir` |
| `web/api/ipc.rs` | `custom_agent_*` 桥接去 workDir |

### 前端(TS)
| 文件 | 改动 |
|---|---|
| `services/tauri/agentCorpusService.ts` | `listCustomAgents`/`saveCustomAgent`/`deleteCustomAgent` 去 workDir |
| `stores/agentStore.ts` | `loadCustomAgents()` 无参;`load()` 内调;`saveCustom`/`deleteCustom` 去 workDir |
| `stores/agentStore.test.ts` | mock 去 workDir;`loadCustomAgents()` 无参 |
| `hooks/useAppInit.ts` | 删 `loadCustomAgents(ws)` 分支 |
| `components/Agent/AgentGalleryPanel.tsx` | 删 `workspacePath` useEffect;Toast/placeholder 文案更新 |
| `components/Chat/ChatInput.tsx` | 无实质改动(从 store 读) |

## 6. 测试计划

### 单元测试
- `simple_ai/agent.rs`:改测试用 `<DataRoot>/agents/`(用 tempdir 模拟);`load_agent_def_reads_global` 新;`project_agents_shadow_global_corpus` 改名/语义调整
- `dispatch_mcp_server.rs`:`agent_save_frame_requires_slug_and_prompt` 去 workDir 断言;`build_agent_save_frame` 无 workDir
- `agentStore.test.ts`:`loadCustomAgents()` 无参;mock 去 workDir

### 集成验证(人工)
1. 启动 Polaris(无 workspace 上下文)→ Gallery 显示已建专家
2. `save_agent`(不传 workDir)→ 文件落 `<DataRoot>/agents/<slug>.md`
3. `/dispatch <slug>` → 派发成功,人格注入生效
4. `list_agents` → 返回全局专家列表
5. 切换不同 workspace → 专家列表一致(全局)

### 编译验证
- `cargo check --lib` 双形态零错误
- `tsc --noEmit` 干净
- `vitest` agentStore + agentSlashCommand 全绿

## 7. 风险与边界

| 风险 | 缓解 |
|---|---|
| 旧项目级 `.polaris/agents/*.md` 不再被读取 | 文档标注:用户手动迁移(把 .md 拷到 `<DataRoot>/agents/`);不做自动迁移(用户量小) |
| `rosters-user.json` 与专家 .md 同目录,discover_agents 扫描时 roster.json 不应被当专家 | `discover_agents_in` 已过滤 `*.md` 扩展,rosters-user.json 不受影响 |
| SimpleAI `options.agent` 原依赖项目级 `.polaris/agents/` | 改全局后,所有 workspace 共享同一份专家;符合"全局配置"语义 |
| `load_agent` 签名变更影响多处调用 | 全部调用点已枚举(§3),逐一同步 |
| MCP 客户端旧版本仍传 workDir | `build_*_frame` 容忍多余字段(`arguments.get` 取不到不影响);schema 删 workDir 只是声明变更,旧客户端传了也忽略 |

## 8. 阶段拆分

| 阶段 | 范围 | 产出 |
|---|---|---|
| **P1 后端核心** | §4.2 后端落盘/读取全局化 + 调用点签名同步 | 专家落 `<DataRoot>/agents/`,读取无 work_dir |
| **P2 MCP & 前端** | §4.3 MCP 工具去 workDir + 前端 store/service 去 workDir | AI 与 UI 均不传 workDir |
| **P3 清理** | 删 `DispatchMcpConfig.work_dir`/`--polaris-workdir`/`resolve_work_dir`;文案更新;测试适配 | 无残留 |

建议 P1+P2+P3 同批(改动正交,一次性切干净)。

## 9. 复审

### 9.1 复审项
| # | 检查点 | 结论 |
|---|---|---|
| 1 | 专家落盘路径是否与专家团同目录 | ✅ `<DataRoot>/agents/`(rosters-user.json 已在此) |
| 2 | discover_agents 是否会误读 rosters-user.json | ✅ 已过滤 *.md,rosters-user.json 不被当专家 |
| 3 | load_agent_def 签名去 work_dir 后,claude.rs build_command 是否还需 work_dir 局部变量 | ❌ 不需要,删除(§4.4) |
| 4 | SimpleAI options.agent 调用点是否覆盖 | ✅ simple_ai/mod.rs:248 + tools/agent.rs:66 |
| 5 | MCP 客户端旧版传 workDir 是否兼容 | ✅ build_*_frame 用 arguments.get,多余字段忽略 |
| 6 | 旧项目级 .polaris/agents 迁移 | ⚠️ 不自动迁移,文档标注(§7) |
| 7 | agentStore.load() 改为内调 loadCustomAgents,启动即加载,是否影响首屏性能 | ✅ 一次性 invoke,可接受(与 loadRosters 并行) |
| 8 | discover_project_agents 函数被多处引用,删除是否安全 | ⚠️ 见 9.2-A |
| 9 | list_agents / list_project_agents 合并语义 | ✅ 合并为 list_agents()(全局),list_project_agents 删 |

### 9.2 复审发现(需决策)

#### A. `discover_project_agents` 删除的连锁影响
**问题**:`discover_project_agents` 被 `custom_agent_list_inner` 调用,删除后调用点改 `list_agents()`(全局)。但语义变化:原来"项目级专家"现变"全局专家",`custom_agent_list_inner` 返回的是全局专家。这符合预期(全局化),但函数名 `list_project_agents` 误导,需改名 `list_agents()`。
**决策**:`list_project_agents` 删除,`list_agents` 改为无参全局扫描;`custom_agent_list_inner` 调 `list_agents()`。

#### B. `load_agent` 签名变更与 SimpleAI 工具描述
**问题**:`simple_ai/tools/agent.rs` 工具描述现写"Agent name (a .polaris/agents/<name>.md file stem)",改全局后路径变了。
**决策**:描述改为"Agent name (a global agents/<name>.md file stem)"或"Agent slug(全局专家)";`load_agent` 调用点去 work_dir。

#### C. 旧用户已有项目级 `.polaris/agents/` 文件
**问题**:升级后这些文件不再被读取,用户可能困惑专家"消失"。
**决策**:不做自动迁移(用户量小,且自动迁移要扫每个 workspace 不现实)。在 release notes / 文档标注:"专家已改为全局存储,旧项目级 `.polaris/agents/*.md` 需手动拷到 `<DataRoot>/agents/`"。可选:启动时检测当前 workspace `.polaris/agents/` 有 .md 且全局无该 slug,提示用户迁移(低优先,可缓)。

### 9.3 复审结论

**通过(P1+P2+P3 同批)**,需落实:
1. `discover_project_agents` 删除,`list_agents` 合并无参(A 项)
2. `simple_ai/tools/agent.rs` 工具描述更新(B 项)
3. `claude.rs` 删 `work_dir` 局部变量(§4.4)
4. 旧项目级专家不自动迁移,文档标注(C 项)
5. 测试适配无 work_dir 签名

**无需用户确认项**(纯重构,方向已定)。

---

*作者:小白 · 复审:小白(自审)*
