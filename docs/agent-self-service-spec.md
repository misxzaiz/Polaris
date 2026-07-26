# Spec:AI 自助专家系统(Agent Self-Service)

> 状态:**已实施 v1**(P1+P2 同批,2026-07-26)
> 日期:2026-07-26
> 关联记忆:`agency-agents-integration-plan` / `agent-persona-inline-injection` / `agent-corpus-web-autoload-fix`

## 1. 背景与问题

当前专家系统有**三个数据源**:

1. **内置 corpus(267 个)** — 打包在 `resources/agents/corpus/*.md`,MSI 安装时 `ensureCorpusInstalled` 复制到 `<DataRoot>/agents/corpus/`。**MSI 态完全不可用**(`resolve_resources_agents_dir` 四条路径全部 miss → 回退 `CARGO_MANIFEST_DIR` 编译机绝对路径 → 用户机器不存在)。
2. **自定义专家** — `<workspace>/.polaris/agents/<slug>.md`,跟项目 git 走。
3. **用户专家团** — `<DataRoot>/agents/rosters-user.json`,全局目录,不跟项目走。

**问题**:

- 内置 corpus 在 MSI 安装态读不出来,且 `ensureCorpusInstalled` 抛错被 `useAppInit.ts:276` 静默 `.catch` 吞掉 → Gallery 空、专家读不出来。**已判定为完全不可用,直接删除**。
- AI **没有自助写入入口**:创建专家/专家团只能走前端表单(Tauri 命令 `custom_agent_save` / `user_roster_save`),MCP 会话内无法调用。

**用户诉求**:删除内置,只要 AI 自己新增专家和维护专家团。

## 2. 目标与非目标

### 目标

- AI 通过 MCP 工具自助新增/查重/删除专家与专家团,无需人工操作 UI。
- 专家与专家团文件落本地可 git 同步,跨机器靠 pull,不依赖任何打包资源。
- 去掉对内置 corpus 的运行时硬依赖:无 corpus 安装的机器上,`find_expert` / `start_roster` / Gallery 仍能正常工作(基于用户自建数据)。

### 非目标

- 不在本期做用户专家团的项目级存储导出(阶段 4,可选)。
- 不改动 claude 引擎 `options.agent` 对 `.claude/agents` 的限制(已知边界,自定义专家走 /dispatch 派发链路有效)。

## 3. 现状盘点(已核实代码)

| 位置 | 现行为 | 对内置的依赖 |
|---|---|---|
| `useAppInit.ts:255-277` | `ensureCorpusInstalled` 触发安装 | 强依赖(删) |
| `agentStore.load()` | `agent_corpus_catalog/divisions` 读内置 catalog | 强依赖(删) |
| `find_expert_candidates` L1 | `resources/nexus/coordination.json` 查表 | 强依赖(删) |
| `find_expert_candidates` L2 | `<DataRoot>/agents/catalog.json` 查表 | 强依赖(删) |
| `nexus_pipeline::start_roster` | 必读 `<DataRoot>/agents/rosters.json`,缺失即报错 | 强依赖(改) |
| `dispatch_mcp_server` | 6 工具,无写专家/写专家团工具 | 新增 |
| `custom_agent_save_inner` | 纯函数,落 `.polaris/agents/<slug>.md` | 复用 |
| `user_roster_save_inner` | 纯函数,落 `rosters-user.json` | 复用 |
| `load_claude_agent_def` | 读 `<DataRoot>/agents/corpus/<slug>.md`,被 claude.rs / nexus_pipeline.rs / ask_listener.rs 三处调用注入人格 | **关键耦合点(改)** |
| `discover_agents` agent_dirs | 两级查找:项目 → 全局 corpus | 改为只查项目级 |
| `tauri.conf.json:33-37` | `bundle.resources` 含 `resources/agents` / `resources/nexus` | 删 |
| `resources/agents/` | 267 个 corpus + catalog/divisions/rosters/roles/manifest | 删整个目录 |

## 4. 设计

### 4.1 总体架构

```
AI (claude/simple-ai 会话)
  │  MCP stdio
  ▼
dispatch_mcp_server (新增 4 工具)
  │  TCP length-prefixed frame
  ▼
ask_listener (新增 4 帧类型)
  │  调用纯函数
  ▼
custom_agent_save_inner / user_roster_save_inner / list / delete  (已有,复用)
  │
  ▼
文件落盘(.polaris/agents/*.md + rosters-user.json)
```

**关键决策**:写入逻辑**复用现有纯函数**,MCP 层只做参数校验 + 帧转发,不重造落盘逻辑。与 `find_expert` / `dispatch_roster` 现有帧转发模式同构。

### 4.2 新增 MCP 工具(挂 dispatch_mcp_server)

#### 4.2.1 `save_agent` — 新增/覆盖专家

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| slug | string | ✅ | `^[a-z0-9-]{1,64}$`,同 slug 覆盖 |
| name | string | ✅ | 显示名 |
| description | string | ✅ | 一句话职责 |
| systemPrompt | string | ✅ | 人格 body(使命/规则/交付标准) |
| emoji | string | ❌ | 展示用 |
| tools | string[] | ❌ | 工具白名单 |
| workDir | string | ✅ | 落到哪个项目的 `.polaris/agents/` |

落盘:`<workDir>/.polaris/agents/<slug>.md`(跟项目 git 走)
回帧:`{ ok, slug, filePath }`

#### 4.2.2 `delete_agent` — 删除专家

| 字段 | 类型 | 必填 |
|---|---|---|
| slug | string | ✅ |
| workDir | string | ✅ |

复用 `custom_agent_delete_inner`。

#### 4.2.3 `list_agents` — 查重/枚举

| 字段 | 类型 | 必填 |
|---|---|---|
| workDir | string | ✅ |

返回项目自定义专家 + 用户专家团成员 slug 列表,供 AI 写入前查重。
复用 `list_project_agents(work_dir)` + `load_user_rosters()`。

#### 4.2.4 `save_roster` — 新增/覆盖专家团

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| slug | string | ✅ | `user-<title-slug>` 约定 |
| title | string | ✅ | 团队名 |
| summary | string | ❌ | 说明 |
| members | string[] | ✅ | 已存在的 slug 列表,按依赖排序 |

复用 `user_roster_save_inner`,落 `<DataRoot>/agents/rosters-user.json`。
回帧:`{ ok, slug }`

### 4.3 帧协议(ask_listener 新增 4 帧)

| 帧类型 | 入参 | 回帧 | 处理函数 |
|---|---|---|---|
| `agent_save` | token + 4.2.1 字段 | `agent_save_result{ok,slug,filePath}` | `handle_agent_save_frame` |
| `agent_delete` | token + slug + workDir | `agent_delete_result{ok}` | `handle_agent_delete_frame` |
| `agent_list` | token + workDir | `agent_list_result{ok,agents[]}` | `handle_agent_list_frame` |
| `roster_save` | token + 4.2.4 字段 | `roster_save_result{ok,slug}` | `handle_roster_save_frame` |

帧结构与现有 `find_expert` / `dispatch_targets` 帧同构:token 校验 → 调纯函数 → write_frame 回复 → shutdown。

### 4.4 系统提示词注入

**方案 A(推荐)**:更新 `nexus-agent-index` skill 的 SKILL.md,附加能力说明。AI 经 `read_skill` 按需加载,不常驻 context。

**方案 B(备选)**:在 `handle_initialize()` 的 serverInfo 加 `instructions` 字段(MCP 协议支持),所有连接客户端可见。

提示词骨架:

```
你可以在任务需要专项能力且现有专家无匹配时,用 MCP 工具自建专家与专家团:

1. list_agents(workDir):查现有专家,避免 slug 重复
2. save_agent(slug/name/description/systemPrompt/emoji/tools/workDir):
   写一个专家。systemPrompt 应含使命、行为规则、交付标准、工具白名单。
   slug 小写连字符,落盘到 <workDir>/.polaris/agents/<slug>.md,跟 git 走。
3. delete_agent(slug, workDir):删除
4. save_roster(slug/title/summary/members):组队,members 是已存在的 slug,
   按依赖排序(前置产出者在前)。落盘到全局 rosters-user.json。

创建后立即可被 /dispatch <slug> 与 /nexus <scenario> 消费,无需重启。
```

### 4.5 删除内置 corpus(治本)

**策略**:整个 corpus 子系统删除,不留可选安装路径。专家与专家团数据**只**来自用户自建(`.polaris/agents/` + `rosters-user.json`)。

#### 4.5.1 删除清单

**资源**:
- `src-tauri/resources/agents/` 整个目录(267 corpus + catalog/divisions/rosters/roles/manifest + activation/playbooks)
- `src-tauri/resources/nexus/`(coordination.json 等内置编排元数据,如未被其他模块硬依赖)
- `tauri.conf.json:33-37` 的 `bundle.resources` 移除 `"resources/agents"` 与 `"resources/nexus"`
- `scripts/gen-agent-catalog.mjs`(离线生成脚本,不再需要)

**后端**:
- `services/agent_corpus.rs` 整个文件删除(install/uninstall/status/load_catalog/load_divisions/load_activation/install_index_skill/uninstall_index_skill/load_claude_agent_def)
- `commands/agent_corpus.rs` 删除内置相关命令:`agent_corpus_status/install/uninstall/catalog/divisions/roles/read`,保留 `custom_agent_*` / `user_roster_*` / `simple_ai_list_agents` 与 `corpus_install_dir`(改为只返回 `<DataRoot>/agents/`,供 user_roster 落盘)
- `commands/mod.rs` 同步清理 re-export
- `lib.rs` tauri 注册命令清单清理

**前端**:
- `useAppInit.ts:255-277` 删除 `ensureCorpusInstalled` 触发,保留 `store.load() + loadRosters() + loadCustomAgents()`
- `agentStore` 删除 `catalog/divisions/status/installing/installCorpus` 字段与 `load()` 中的 catalog/divisions/status 调用;`filtered()` 改为只基于 `customAgents` + `rosters`
- `services/tauri/agentCorpusService.ts` 删除 `getCorpusStatus/installCorpus/uninstallCorpus/getCatalog/getDivisions/getRoles/getAgentCorpusSource`,保留 `getRosters`(读 rosters-user.json 合并视图)/`readAgentCorpus`(改读项目级,若不再需要可删)
- `GeneralTab.tsx` 的 `CorpusStaleSection`(已注释)彻底删除
- `find_expert` 工具描述去掉"267 experts"字样,改为"project custom experts"

#### 4.5.2 `load_claude_agent_def` 关键改造

**问题**:该函数被 `claude.rs:372` / `nexus_pipeline.rs:396` / `ask_listener.rs:639` 三处调用,从 `<DataRoot>/agents/corpus/<slug>.md` 读专家 body 注入人格。删 corpus 后这个路径失效。

**改造**:函数从 `agent_corpus.rs` 迁移到 `simple_ai/agent.rs`(或 `commands/agent_corpus.rs` 保留为薄封装),改为**只读项目级 `.polaris/agents/<slug>.md`**:

```rust
pub fn load_agent_def(work_dir: &str, slug: &str) -> Option<(String, String, String)> {
    // (slug, description, system_prompt) — 与 parse_agent 同构
    let path = Path::new(work_dir).join(".polaris").join("agents").join(format!("{slug}.md"));
    let content = fs::read_to_string(&path).ok()?;
    let (description, body) = parse_frontmatter_and_body(&content);
    Some((slug.to_string(), description.unwrap_or_else(|| slug.to_string()),
          if body.trim().is_empty() { content } else { body }))
}
```

三处调用点同步改入参(补 `work_dir`),签名与 `parse_agent` 同构。`parse_frontmatter_and_body` 一并迁移。

#### 4.5.3 `discover_agents` 简化

`simple_ai/agent.rs::agent_dirs` 删除全局 corpus 回退,只保留项目级 `.polaris/agents/`。`discover_agents` 与 `discover_project_agents` 合并为一个(项目级 only)。`list_agents` / `list_project_agents` 同步。

#### 4.5.4 `start_roster` 软化

```rust
let mut file = RostersFile { rosters: vec![] };
// 先内置 rosters.json(若仍存在,兼容已安装旧用户)
if let Ok(content) = read_to_string(install_dir.join("rosters.json")) {
    if let Ok(f) = parse(content) { file.rosters.extend(f.rosters); }
}
// 后用户 rosters-user.json(同 slug 覆盖)
if let Ok(content) = read_to_string(install_dir.join("rosters-user.json")) {
    if let Ok(f) = parse(content) {
        for r in f.rosters { file.rosters.retain(|b| b.slug != r.slug); file.rosters.push(r); }
    }
}
if file.rosters.is_empty() {
    return Err("无可用专家团;请先用 save_roster 创建".into());
}
```

(用户诉求是删除内置,但已安装旧用户的 `rosters.json` 文件仍在 DataRoot,软化读取而非主动删除文件,保留兼容性。新装机无此文件,只走 rosters-user.json。)

#### 4.5.5 `find_expert_candidates` 精简

删除 L1(coordination.json 查表)+ L2(catalog.json 查表),只保留项目 `.polaris/agents` 关键词匹配。无 corpus 时返回空数组(而非报错)。

## 5. 数据契约

### 5.1 专家文件格式(`.polaris/agents/<slug>.md`)

```markdown
---
name: "显示名"
description: "一句话职责"
emoji: 🚀
tools: "tool-a, tool-b"
---

<systemPrompt body>
```

与现有 `parse_agent` 同构,slug = 文件名 stem。

### 5.2 专家团文件格式(`rosters-user.json`)

```json
{
  "rosters": [
    {
      "slug": "user-my-team",
      "title": "我的团队",
      "mode": "Custom",
      "duration": "-",
      "summary": "...",
      "groups": [{ "group": "Core Team", "activation": "always", "members": ["slug-a", "slug-b"] }],
      "custom": true
    }
  ]
}
```

与现有 `user_roster_save_inner` 输出同构。

## 6. 变更清单

### 后端(Rust)

| 文件 | 改动 |
|---|---|
| `services/agent_corpus.rs` | **整个文件删除** |
| `services/dispatch_mcp_server.rs` | 新增 4 工具定义 + 4 build_*_frame + tools/list 注册 |
| `services/ask_listener.rs` | 新增 4 帧分发 + 4 handle_*_frame;`find_expert_candidates` 删 L1/L2;`load_claude_agent_def` 调用点改 `load_agent_def(work_dir, slug)` |
| `services/nexus_pipeline.rs` | `start_roster` 软化;`load_claude_agent_def` 调用点改 |
| `ai/engine/claude.rs` | `load_claude_agent_def` 调用点改(补 work_dir) |
| `ai/engine/simple_ai/agent.rs` | `agent_dirs` 删全局 corpus 回退;`discover_agents`/`discover_project_agents` 合并;新增 `load_agent_def`(迁移自 agent_corpus) |
| `commands/agent_corpus.rs` | 删内置命令,保留 `custom_agent_*`/`user_roster_*`/`simple_ai_list_agents`;`corpus_install_dir` 保留(改名 `agents_dir` 更清晰) |
| `commands/mod.rs` | 同步清理 re-export |
| `lib.rs` | tauri 命令注册清单清理 |
| `web/api/ipc.rs` | 删 `agent_corpus_*` 桥接,保留 `custom_agent_*`/`user_roster_*`/`simple_ai_list_agents` |

### 前端(TS)

| 文件 | 改动 |
|---|---|
| `hooks/useAppInit.ts` | 删 `ensureCorpusInstalled` 触发 |
| `stores/agentStore.ts` | 删 `catalog/divisions/status/installing/installCorpus`;`load()` 只加载 customAgents + rosters |
| `services/tauri/agentCorpusService.ts` | 删内置相关,保留 `getRosters`(读 rosters-user.json) |
| `components/Settings/tabs/GeneralTab.tsx` | 删 `CorpusStaleSection` |
| `services/dispatchTaskService.ts` | MCP 工具类型同步(若需) |

### 资源 / 配置

| 文件 | 改动 |
|---|---|
| `src-tauri/resources/agents/` | **整个目录删除** |
| `src-tauri/resources/nexus/` | 删除(若仅服务内置 corpus;需确认无其他模块依赖) |
| `tauri.conf.json` | `bundle.resources` 移除 `resources/agents`、`resources/nexus` |
| `scripts/gen-agent-catalog.mjs` | 删除 |

## 7. 测试计划

### 单元测试(Rust,本机只能 `cargo check --lib`,交 CI 跑)

- `dispatch_mcp_server`:4 个 build_*_frame 参数校验(slug 非空/格式、必填字段);`tools_list_returns_all_tools` 期望从 4 改为 10
- `ask_listener`:4 个 handle_*_frame token 校验 + 成功路径 mock
- `nexus_pipeline::start_roster`:无 rosters.json 但有 rosters-user.json 时正常;两者皆无时报错;旧用户 rosters.json + rosters-user.json 合并 + 同 slug 覆盖
- `simple_ai/agent.rs::load_agent_def`:读项目级 .md,frontmatter + body 解析正确;文件缺失返回 None
- `find_expert_candidates`:无 corpus 时返回空数组不报错;项目级专家关键词匹配

### 集成验证(人工,真实 LLM 会话)

1. AI 调 `list_agents` → 返回空(新项目)
2. AI 调 `save_agent` 创建 `code-reviewer` → 文件落 `.polaris/agents/code-reviewer.md`
3. AI 调 `save_roster` 组队 `[code-reviewer]` → `rosters-user.json` 更新
4. `/dispatch code-reviewer <task>` → 派发成功,人格注入生效
5. `/nexus user-my-team <goal>` → 波次派发启动
6. 全新安装(无 DataRoot/agents 任何文件)→ Gallery 仅显自定义、无报错、`/nexus` 仍可用、`find_expert` 返回空不报错

## 8. 风险与边界

| 风险 | 缓解 |
|---|---|
| 删除内置后,旧版本升级用户 DataRoot 残留 `agents/corpus/` 目录 | 不主动清理;`uninstall_corpus` 命令删除,或用户手动删;`discover_agents` 不再读该目录,残留无副作用 |
| `rosters-user.json` 全局存储,跨机器不跟 git | 阶段 4 加项目级导出(本期非目标,文档标注) |
| `user_roster_save_inner` read-modify-write 并发竞态 | 实际低频;真要严格可加文件锁(后续) |
| claude 引擎 `options.agent` 不认 `.polaris/agents` | 已知限制;走 /dispatch 派发链路有效 |
| slug 冲突覆盖 | `save_agent` 前提示 AI 先 `list_agents` 查重;项目级覆盖全局已有语义 |
| `resources/nexus/` 可能被其他模块依赖 | 删除前需 grep 确认无其他引用(见 6 资源清单注) |
| `load_claude_agent_def` 迁移改动 3 个调用点 | 迁移后签名变 `(work_dir, slug)`,3 处同步改;`cargo check --lib` 卡编译 |

## 9. 阶段拆分

| 阶段 | 范围 | 产出 |
|---|---|---|
| **P1(最小闭环)** | 4.2/4.3/4.4:MCP 四工具 + 帧协议 + 提示词 | AI 能自助建专家/专家团并消费 |
| **P2(删除内置)** | 4.5:删除 corpus 资源/命令/前端 + `load_agent_def` 迁移 + start_roster 软化 + find_expert 精简 | 彻底无内置,跨机器靠 git + 用户自建 |
| **P3(可选)** | 用户专家团项目级导出 + git 同步 | 跨机器专家团也跟项目走 |

建议 P1+P2 同批做(P2 是删除,与 P1 正交,合在一起一次性切干净)。

## 10. 复审记录

见 §11。

## 11. 复审

### 11.1 复审项

| # | 检查点 | 结论 |
|---|---|---|
| 1 | 写入逻辑是否复用现有纯函数,未重造 | ✅ `custom_agent_save_inner` / `user_roster_save_inner` 直接复用 |
| 2 | 帧协议是否与现有 find_expert/dispatch_targets 同构 | ✅ token 校验 → 纯函数 → write_frame → shutdown |
| 3 | slug 校验是否一致 | ✅ 复用 `validate_custom_slug`(`^[a-z0-9-]{1,64}$`) |
| 4 | MCP 工具入参 schema 是否完整(必填/可选) | ✅ 见 4.2 |
| 5 | `start_roster` 软化后,scenario 查找逻辑是否正确 | ✅ 见 11.2-A(已修正顺序:先内置后用户) |
| 6 | `find_expert` 精简后,无 corpus 时是否报错 | ✅ 返回空数组,不报错 |
| 7 | `load_claude_agent_def` 迁移是否覆盖所有调用点 | ✅ claude.rs:372 / nexus_pipeline.rs:396 / ask_listener.rs:639 三处,见 4.5.2 |
| 8 | 删除 `services/agent_corpus.rs` 是否有遗漏引用 | ✅ grep 确认引用点仅上述三处 + commands/agent_corpus.rs(自身保留薄封装) |
| 9 | `discover_agents` 合并后,`list_agents`/`list_project_agents` 是否需同步 | ✅ 合并为项目级 only,两个函数统一 |
| 10 | 提示词注入方案是否可行 | ✅ 方案 A 更新 SKILL.md 最轻(但 corpus 删除后 nexus-agent-index skill 不再随包;提示词改走方案 B serverInfo.instructions 或内联到 MCP 工具描述) |
| 11 | workDir 必填是否会阻碍 AI | ⚠️ 见 11.2-B |
| 12 | 删除专家是否需要校验是否被 roster 引用 | ⚠️ 见 11.2-C |
| 13 | `list_agents` 是否应同时返回 corpus 专家 | ✅ 删除后无 corpus,只返回项目自定义 + 用户专家团成员,标 source |
| 14 | `tools_list_returns_all_tools` 测试期望需更新 | ✅ 4 → 10 |
| 15 | 删除内置后,`/nexus <scenario>` 的 scenario 枚举是否仍硬编码内置场景 | ⚠️ 见 11.2-D |
| 16 | `resources/nexus/` 删除前需确认无其他模块依赖 | ⚠️ 见 11.2-E |

### 11.2 复审发现(需决策)

#### A. `start_roster` scenario 查找顺序

**问题**:软化后用户自建 roster 与旧内置 roster 同 slug 时,谁覆盖谁?
**决策**:保持"用户覆盖内置"语义,先读内置 rosters.json、后读 rosters-user.json 并覆盖。§4.5.4 代码已修正顺序。

#### B. workDir 必填的阻碍

**问题**:MCP 会话内 AI 可能不知道当前 workspace 绝对路径。
**决策**:`save_agent`/`delete_agent`/`list_agents` 的 workDir 改为**可选**,`DispatchMcpConfig` 加 `work_dir: Option<String>`,主进程启动时注入;工具参数缺省时用配置值。

#### C. 删除专家与 roster 引用

**问题**:删除被 roster 引用的专家会导致 roster 派发时找不到成员。
**决策**:P1 不做引用检测,P2 在回帧附加 `referencedBy: [roster slug...]` 警告,AI 自行决策。

#### D. `/nexus <scenario>` scenario 枚举

**问题**:删除内置后,`dispatch_roster` 工具的 `scenario` 枚举 `["startup-mvp", "enterprise-feature", ...]` 不再有意义,用户自建 roster 的 slug 是任意的。
**决策**:`scenario` 参数从枚举改为自由 string;`/nexus` 命令补全改为从 `rosters-user.json` 动态拉取可用 slug。MCP 工具描述更新为"用户自建专家团 slug,用 list_agents 查看"。

#### E. `resources/nexus/` 依赖确认

**问题**:`resources/nexus/` 含 coordination.json / schemas / gates.json,删除前需确认无其他模块硬依赖。
**需核实**:`nexus_verdict.rs` 的 schema 注册表是否读 `resources/nexus/schemas/*.json`(若是,需保留 schemas 或迁入代码常量)。
**决策**:实施前 grep 确认;若 nexus verdict schema 是代码内定义(记忆显示 `nexus_verdict.rs` 是 schema 注册表),则 `resources/nexus/` 可整体删;否则保留 schemas 子目录。

### 11.3 复审结论

**通过(P1+P2 同批)**,需落实以下修正:

1. §4.5.4 start_roster 顺序:先内置后用户(A 项,已修正)
2. `save_agent`/`delete_agent`/`list_agents` 的 workDir 改可选,`DispatchMcpConfig` 加 `work_dir`(B 项)
3. `delete_agent` 引用检测延后 P2(C 项)
4. `dispatch_roster` 的 scenario 从枚举改自由 string,`/nexus` 补全动态拉取(D 项)
5. 实施前 grep 确认 `resources/nexus/` 依赖,决定是否整体删(E 项)
6. 提示词注入:corpus 删除后 nexus-agent-index skill 不再随包,改走 MCP serverInfo.instructions 或内联工具描述(§10 #10)
7. 更新 `tools_list_returns_all_tools` 测试期望(4 → 10)
8. `find_expert` 工具描述去掉"267 experts"

**待用户确认**:

- P3(专家团项目级导出)是否本期做?
- 提示词注入最终用 serverInfo.instructions 还是内联工具描述?(我倾向 serverInfo.instructions,所有客户端可见且无需 skill 通道)

---

*作者:小白 · 复审:小白(自审)*
