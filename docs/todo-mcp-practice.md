# Polaris Todo MCP 实战总结

## 1. 文档目的

这份文档总结 Polaris 在 Todo 能力上从系统提示词注入迁移到 MCP 工具化的完整实战过程，重点说明：

- 为什么要把待办从 prompt 注入改成 MCP 工具
- Polaris × Claude Code × MCP 的整体接入链是怎么打通的
- Todo MCP 的实现分层与关键代码落点
- 这次落地过程中遇到的典型坑与修复思路
- 后续扩展 scheduler、requirements 等 MCP 时可以直接复用的模式

这不是一份单纯解释代码的文档，而是一份偏工程实战、偏方法论的总结。

---

## 2. 问题背景：为什么原来的方式不够好

Polaris 早期对待办、定时任务、需求库等扩展能力的做法，本质是：

- 在 system prompt 中告诉 Claude Code 某些规则
- 要求模型自行读写 `.polaris/*.json`
- 通过提示词约束模型完成增删改查

这种做法能工作，但存在明显问题。

### 2.1 这不是真正的工具

模型并没有获得一个正式的 Todo API，只是被提示去：

- 读 JSON
- 改 JSON
- 再写回 JSON

这会导致：

- 参数不结构化
- 行为容易漂移
- 依赖 prompt 质量
- 不方便复用与审计
- 很难沉淀为长期稳定能力

### 2.2 业务语义泄漏给模型

比如：

- 待办文件在哪
- JSON 怎么格式化
- 状态如何流转
- `completedAt` 应该什么时候写入

这些都不应该依赖模型自己推断，而应该由应用侧封装。

### 2.3 扩展性差

如果后面继续给 Claude 注入：

- 待办
- 定时任务
- 需求库
- 协议任务

system prompt 会越来越重，维护成本和冲突概率都会快速上升。

所以，正确方向不是继续增强 prompt，而是把工作区能力正式升级为 Claude 可调用的工具。

---

## 3. 为什么选择 MCP，而不是继续堆 prompt 或只用 Skill

MCP 的价值在于：

- 应用把自己的能力暴露成标准工具
- 模型按 schema 调用工具
- 宿主控制实现与权限边界
- 工具调用链天然结构化

对 Polaris 来说，Todo 更像一组工作区级 API，而不是一个固定工作流命令，因此 MCP 比 Skill 更合适。

### 3.1 Skill 更适合固定流程

Skill 更像：

- slash command
- 模板化操作
- 固定命令流

而 Todo 能力要求：

- 增删改查
- 结构化输入输出
- 工作区隔离
- 可持续扩展

这更像 API，不像命令模板。

### 3.2 MCP 天然适合工作区隔离

Todo 强依赖 workspace：

- 每个 workspace 都有自己的 `.polaris/todos.json`
- 每个 workspace 都应该有自己的 `.polaris/claude/mcp.json`
- 多开 Polaris 时不能互相污染

所以最佳方案不是修改用户全局配置，而是：

- 为每个 workspace 生成专属 MCP 配置
- 启动 Claude Code 时把该配置显式传给 Claude CLI

---

## 4. 这次 Todo MCP 的总体演进路线

这次实现不是一步到位，而是经历了两个阶段。

### 4.1 第一阶段：Node 版 Todo MCP MVP

最早先做的是快速 MVP：

- 用 MCP SDK 实现 Todo tools
- 用 Node stdio server 暴露给 Claude
- 由 Polaris 生成 workspace 级 `mcp.json`
- 启动 Claude 时通过 `--mcp-config` 注入

这个阶段的目标不是做长期发布方案，而是验证：

1. Claude 能不能真正发现 Todo 工具
2. Polaris 能不能为当前 workspace 注入 MCP
3. 工具调用链能不能替代原来的 prompt 注入

答案是：可以。

但这个阶段也暴露了长期问题：

- 依赖 Node
- 依赖 JS 构建产物
- 路径解析复杂
- 打包后资源定位不稳定

### 4.2 第二阶段：Rust 原生 Todo MCP

为了彻底消除发布态对系统 Node 的依赖，后续升级为：

- Rust Todo model
- Rust Todo repository
- Rust stdio MCP server
- Rust 独立 bin：`polaris-todo-mcp`
- `mcp_config_service.rs` 直接生成指向原生 exe 的 `mcp.json`

这一阶段才是长期稳定版本。

---

## 5. 最终架构：Todo MCP 的 5 层结构

这次 Todo MCP 最终可以拆成五层。

### 5.1 数据层：Todo Repository

职责：

- 读写 `.polaris/todos.json`
- 缺文件自动初始化
- normalize 脏数据
- 提供 CRUD 能力
- 维护 `completedAt` 语义
- 统一 JSON pretty-print 与换行

对应文件：

- Node 版：`src/mcp/todoRepository.ts`
- Rust 版：`src-tauri/src/services/todo_repository.rs`

核心认知：

> Repository 承载真实业务语义，MCP server 只是协议外壳。

也就是说，待办的正确性应该由 repository 保证，而不是由模型保证。

### 5.2 协议层：Todo MCP Server

职责：

- 暴露 Claude 可调用的工具
- 将 repository 能力包装成 MCP tools

当前工具包括：

- `list_todos`
- `create_todo`
- `update_todo`
- `delete_todo`
- `start_todo`
- `complete_todo`

Rust 版支持的协议能力包括：

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

对应文件：

- `src-tauri/src/services/todo_mcp_server.rs`

### 5.3 进程入口层：MCP CLI / Bin

这层是 Claude 实际启动的入口。

最早是：

- `src/mcp/todoMcpServerCli.ts`

后来升级为：

- `src-tauri/src/bin/polaris_todo_mcp.rs`

语义是：

```bash
polaris-todo-mcp <workspacePath>
```

职责很纯粹：

- 接收 workspacePath
- 启动 Todo MCP server

### 5.4 配置层：Workspace MCP Config Service

Claude 不会自动知道 Polaris 有哪些 MCP，必须由 Polaris 主动生成：

```text
<workspace>/.polaris/claude/mcp.json
```

这份配置告诉 Claude：

- server 名称
- command 是什么
- args 是什么

对应文件：

- `src-tauri/src/services/mcp_config_service.rs`

这层是整条链最关键、也最容易被忽略的一层。

### 5.5 Claude 接入层：`--mcp-config`

最后 Polaris 在启动 Claude CLI 时，需要把 workspace 的 `mcp.json` 通过：

```bash
--mcp-config <path>
```

显式传给 Claude。

对应链路：

- `src-tauri/src/commands/chat.rs`
- `src-tauri/src/ai/engine/claude.rs`

如果没有这一步，MCP server 本体写得再好，Claude 也根本发现不了。

---

## 6. 实现步骤：这次是怎么落地的

下面按落地顺序总结。

### 6.1 先做 Node 版 MVP，验证整条接入链

先实现：

- `src/mcp/todoRepository.ts`
- `src/mcp/todoMcpServer.ts`
- `src/mcp/todoMcpServerCli.ts`
- `scripts/build-mcp.mjs`

核心目标是让 Claude 真正能看到工具。

这一阶段重点不是“业务有多完整”，而是验证：

- Claude 是否收到 `--mcp-config`
- Claude 是否能 `tools/list`
- Claude 是否能真实调用 `create_todo` 等工具

### 6.2 打通 Polaris → Claude Code 接入链

只写 MCP server 还不够，必须打通完整链路：

1. Polaris 识别当前 workspace
2. 为 workspace 生成 `.polaris/claude/mcp.json`
3. 启动 Claude 时附带 `--mcp-config`
4. Claude 启动 MCP stdio 进程
5. Claude `tools/list`
6. Claude `tools/call`

这一步的关键代码在：

- `mcp_config_service.rs`
- `chat.rs`
- `claude.rs`

### 6.3 为发布态补齐构建与资源策略

为了让开发态和打包态都可用，需要额外处理：

- 开发态自动构建 MCP 产物
- 打包态把 MCP 资源带进安装包
- 运行时根据环境解析正确路径

这一步最早先是 JS 产物方案，后来切到了原生二进制方案。

### 6.4 升级为 Rust 原生 Todo MCP

后续新增：

- `src-tauri/src/models/todo.rs`
- `src-tauri/src/services/todo_repository.rs`
- `src-tauri/src/services/todo_mcp_server.rs`
- `src-tauri/src/bin/polaris_todo_mcp.rs`

并在 `Cargo.toml` 里增加：

```toml
[[bin]]
name = "polaris-todo-mcp"
path = "src/bin/polaris_todo_mcp.rs"
```

这样发布态就不再需要系统 Node。

### 6.5 把 `mcp_config_service.rs` 切到原生 exe

这是从 Node 版过渡到原生版的关键一步。

也就是把原先：

```json
{
  "command": "node",
  "args": ["...todoMcpServerCli.js", "<workspace>"]
}
```

切成：

```json
{
  "command": "<polaris-todo-mcp.exe>",
  "args": ["<workspace>"]
}
```

这一步完成后，Claude 端的感知没有变化，但发布态依赖关系已经彻底不同。

---

## 7. 这次最容易踩的坑

下面这些坑几乎都是真实踩过的。

### 7.1 直接让 Node 跑 TypeScript 入口失败

典型报错：

```text
Error [ERR_MODULE_NOT_FOUND]
```

原因：

- `.mcp.json` 指向的是 `.ts` 源码
- Node ESM 无法稳定直接执行 TS 依赖链

结论：

- 不要让 MCP config 直接指向 TypeScript 源码
- 要么先构建成 JS
- 要么直接用原生 bin

### 7.2 Node 子进程里误用 Tauri API，报 `window is not defined`

这次很典型的一次错误是：

```text
window is not defined
```

原因：

- MCP server 跑在 Node 子进程里
- 不是前端 WebView 环境
- 却引用了 `@tauri-apps/api/...`

结论：

> MCP 子进程必须是纯后端运行时，不要依赖浏览器/Tauri 前端 API。

### 7.3 Claude 不识别 MCP，通常不是 server 本体问题

如果 Claude 不知道有哪些 MCP，优先排查的是：

- `mcp.json` 有没有生成
- Claude 启动时有没有附带 `--mcp-config`
- `mcp.json` 指向的 command/args 对不对

结论：

> 先查配置链，再查协议链。

### 7.4 开发态和发布态是两套世界

开发态常见路径：

- `dist/mcp/...`
- `target/debug/...`
- 仓库源码目录

发布态常见路径：

- 安装根目录
- `resource_dir()`
- 安装器重定位后的资源区

不能用“开发态能跑”去推断“打包态也能跑”。

### 7.5 MSI 安装结构和预期不一致

本来以为发布态会装到：

- `bin/polaris-todo-mcp.exe`

但实际 MSI 安装结果是：

- 直接落在安装根目录

这件事是通过读取生成出来的 WiX 文件确认的。

结论：

> 发布态路径不要靠猜，必须看真实安装产物。

### 7.6 多 bin 后 `cargo run` 歧义

因为新增了：

- `polaris`
- `polaris-todo-mcp`

两个 bin，`npm run tauri dev` 底层跑裸 `cargo run` 时会报：

```text
cargo run could not determine which binary to run
```

最终修复方式是：

```toml
default-run = "polaris"
```

这是多 bin Tauri 工程的典型坑。

### 7.7 路径策略变了，diagnostics 也必须同步改

MCP 配置从 JS CLI 改成原生 exe 后，如果 diagnostics 还显示：

- `resolved_cli_path`
- `dist/mcp/...`
- 只检查 `bin/...`

那排障就会被误导。

所以路径策略变更时，diagnostics 一定要同步演进。

---

## 8. 这次最后收敛出来的几个关键经验

### 8.1 Claude 不会自动发现你写的 MCP

很多人容易误以为：

- 项目里有 MCP server
- Claude 就会自动知道

其实不是。

Claude 必须拿到 `--mcp-config`，才能知道：

- server 名称
- 启动方式
- 工具列表

所以真正的完整链路是：

> Polaris 生成 workspace 级 `mcp.json` → 启动 Claude 时传 `--mcp-config` → Claude 连接 MCP → `tools/list` → 工具可用

### 8.2 MCP server 本体不是难点，接入链才是难点

协议实现本身不算最难，真正复杂的是：

- 开发态构建
- 发布态路径
- 安装器落点
- workspace 配置生成
- Claude 启动参数透传
- 多工作区隔离

所以不要把注意力只放在 `tools/list` 和 `tools/call` 上。

### 8.3 Repository 语义要先行

待办真正的规则，比如：

- `completedAt` 怎么维护
- JSON 怎么格式化
- 脏数据怎么 normalize
- 缺文件怎么初始化

这些都应该放在 repository，而不是让模型临场决定。

### 8.4 发布态优先使用原生二进制

Node 版 MVP 非常适合快速验证，但长期发布态稳定性更依赖：

- 原生可执行文件
- 明确路径解析
- 无系统 Node 依赖

这次最终升级到 Rust 原生入口，就是为了解决长期稳定性问题。

### 8.5 路径解析必须做多候选策略

实际工程里不要只相信一个路径。

比较稳的策略是：

- 开发态：`src-tauri/target/debug/polaris-todo-mcp.exe`
- 发布态优先：资源目录下候选路径
- 发布态兼容：安装根目录同级 `polaris-todo-mcp.exe`
- 特殊场景：环境变量 override

---

## 9. 后续扩展其他 MCP 的推荐模板

如果后面要继续做：

- scheduler MCP
- requirements MCP
- protocol MCP

建议直接复用这套模板。

### 9.1 通用落地步骤

1. 定义领域模型
2. 实现 repository / service，封装真实业务语义
3. 设计 MCP tools 输入输出
4. 提供独立 stdio 入口
5. 做 workspace 级 `mcp.json` 生成
6. 在 Claude 启动时透传 `--mcp-config`
7. 增加 diagnostics
8. 验证开发态 / 发布态 / 多工作区

### 9.2 一个很重要的约束

不要让 Claude 直接操作底层 JSON 文件来模拟工具。

正确做法是：

- Claude 调 MCP
- MCP 调 service/repository
- repository 再操作文件或数据库

这样工具边界才清晰。

---

## 10. 最终总结

如果把这次 Todo MCP 实战压缩成几句话，最重要的结论是：

1. **从 prompt 注入迁移到 MCP，本质上是把模型的“自由文件操作”升级为结构化工具调用。**
2. **真正的难点不在 MCP server 本体，而在 Polaris → Claude Code → workspace → MCP process 这整条接入链。**
3. **Node 版适合快速 MVP，Rust 原生版适合长期发布态稳定方案。**
4. **开发态、打包态、安装态往往有不同路径模型，必须靠真实产物验证，而不是靠猜。**
5. **后续扩展其他工作区能力时，Todo MCP 这套模式已经可以作为标准模板直接复用。**

这次 Todo MCP 的价值，不只是完成了一个待办工具，而是为 Polaris 后续所有工作区级工具能力建立了一套可复制的工程方法。
