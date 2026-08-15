# 功能按需启用：默认关闭资源密集型功能

> 目标：为每个资源密集型功能加配置开关，默认关闭，用户按需开启
> 策略：配置变更不重启生效（热切换）

---

## 一、总体设计

### 1.1 开关模型

在 Rust `Config` 中新增一个聚合结构体：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceFeatures {
    // 文件系统监听
    pub file_watcher: bool,
    // LSP 智能索引（tree-sitter + SQLite）
    pub lsp_index: bool,
    // 后台调度器（定时任务轮询）
    pub scheduler_daemon: bool,
    // 编辑器语法高亮（highlight.js full build）
    pub syntax_highlighting: bool,
    // Mermaid 图表渲染
    pub mermaid_diagrams: bool,
    // KaTeX 数学公式渲染
    pub katex_math: bool,
    // 代码编辑器语言包预加载
    pub code_editor_languages: bool,
    // 插件服务自动启动
    pub plugin_auto_start: bool,
}
```

**所有字段默认 `false`**，通过 `#[serde(default)]` 保证旧配置兼容。

### 1.2 热切换机制

配置变更通过 Tauri 事件系统通知后端，后端**重新评估各服务状态**，按需 start/stop，无需重启应用。

```
用户切换设置页开关
    → configStore 写入 config.json
    → emit("config-changed", { feature, enabled })
    → 后端收到事件
    → 评估该功能当前运行状态 vs 期望状态
    → start / stop 对应服务
```

### 1.3 前端联动

设置页新增"性能与资源"面板，每个开关附带：
- 功能描述（一句话）
- 资源消耗提示（CPU/内存估算）
- 开关（切换即时生效）

---

## 二、逐项实施计划

### 2.1 文件系统监听（file_watcher）

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭 |
| **CPU 消耗** | 高（500ms poll + 递归扫描 + 独立线程） |
| **替代方案** | 用户手动触发刷新 |

**后端改动**（`src-tauri/src/services/file_watcher.rs`）：
1. `FileWatcherManager` 初始化时不自动启动
2. `lib.rs`/`main.rs` 启动逻辑改为：读取 `config.performance.file_watcher`，`true` 才调 `start()`
3. 新增 `restart_if_configured()` 方法：检查配置决定是否启动/停止
4. 接收 `config-changed` 事件，调用 `restart_if_configured()`

**前端改动**：
- 设置页新增"文件自动监听"开关
- 监听事件去掉自动依赖，改为开关开启时才订阅 `file-system-change`

### 2.2 LSP 索引（lsp_index）

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭 |
| **CPU 消耗** | 极高（首次构建打满多核，持续 tree-sitter 解析） |
| **内存消耗** | 中（每 workspace 一个 SQLite DB + 索引缓存） |
| **替代方案** | 保留现有 `regex_fallback` 路径（已存在），不依赖索引也能跳转 |

**后端改动**（`src-tauri/src/services/lsp_index/`）：
1. `IndexService` 初始化时不自动 `open_workspace()` + `start_watcher()`
2. 新增 `apply_config(performance: &PerformanceFeatures)` 方法：
   - `lsp_index=true` → 打开所有 workspace 索引 + 启动 watcher
   - `lsp_index=false` → 关闭所有 watcher + close_workspace（释放内存）
3. `find_definition`/`find_references` 已兼容：无索引时自动走 `regex_fallback`（代码已存在），无需修改调用方
4. 接收 `config-changed` 事件

**前端改动**：
- 设置页新增"LSP 智能索引"开关
- 提示："关闭后代码跳转仍可用（降级为正则匹配），但精度降低"

### 2.3 调度器守护进程（scheduler_daemon）

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭 |
| **CPU 消耗** | 低（10 秒轮询），但空闲时不必要的任务 |
| **替代方案** | 用户有定时任务时自动启用（懒激活） |

**后端改动**（`src-tauri/src/services/scheduler_daemon.rs`）：
1. `SchedulerDaemon` 初始化时不自动 `start()`
2. 新增懒激活逻辑：`apply_config()` 时检查 `unified_scheduler_repository` 是否有活跃任务，有则启动
3. 接收 `config-changed` 事件，无任务且开关关闭则 `stop()`

### 2.4 语法高亮（highlight.js）

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭（仅代码块用等宽字体，不高亮） |
| **内存消耗** | 高（full build ~300KB+） |
| **替代方案** | 按需加载单个语言 |

**前端改动**（`src/utils/syntaxHighlight.ts`）：
1. 检查 `configStore` 的 `performance.syntax_highlighting`
2. `false` 时：跳过 highlight.js，直接返回 `<code class="language-xxx">...</code>`（浏览器默认等宽显示）
3. `true` 时：保持现有行为
4. 进一步优化：改为 `highlight.js/lib/core` + dynamic import 所需语言，替代 full build

### 2.5 Mermaid 图表

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭（代码块原样显示） |
| **内存消耗** | 高（~1.5MB 常驻） |
| **替代方案** | 用户需要时在消息上手动点击"渲染图表" |

**前端改动**（`src/components/Chat/MermaidDiagram.tsx`）：
1. 检查配置开关，`false` 时 mermaid 代码块用普通代码样式展示
2. 在 mermaid 代码块右上角放一个"渲染图表"按钮，点击后 dynamic import mermaid 并渲染
3. 首次点击后本次会话内保持启用状态（不必每次确认）

### 2.6 KaTeX 数学公式

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭（LaTeX 语法原样显示） |
| **内存消耗** | 中（~500KB） |
| **替代方案** | 需要时手动渲染 |

**前端改动**（`src/utils/markdown.ts` 或相关渲染组件）：
1. 检查配置开关，`false` 时跳过 KaTeX 处理
2. 同 Mermaid：提供"渲染公式"按钮

### 2.7 代码编辑器语言包预加载

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭（仅加载基础编辑器） |
| **内存消耗** | 中（12 个 lang-* 包常驻） |
| **替代方案** | 打开文件时按扩展名 dynamic import 对应语言包 |

**前端改动**（编辑器相关初始化代码）：
1. 检查配置开关，`false` 时不预加载任何 `@codemirror/lang-*`
2. 编辑器打开 `.java` 文件时 dynamic import `@codemirror/lang-java`
3. 维护一个 `Map<ext, Promise>` 缓存已加载的语言包

### 2.8 插件服务自动启动

| 项目 | 内容 |
|------|------|
| **默认状态** | 关闭（插件手动启动） |
| **内存消耗** | 高（每个插件一个独立进程，10-50MB/个） |
| **替代方案** | 首次使用该插件功能时自动拉起 |

**前端改动**（`src/hooks/useAppInit.ts`）：
1. 启动时检查 `config.performance.plugin_auto_start`
2. `false` 时：不调用 `pluginServiceManager.autoStartAll()`
3. `true` 时：保持现有行为
4. 各插件功能调用处加懒激活逻辑：首次调用时检查服务是否运行，未运行则拉起

---

## 三、配置存储与兼容性

### 3.1 新增配置字段

在 `src-tauri/src/models/config.rs` 中：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    // ... 现有字段 ...

    #[serde(default = "default_performance")]
    pub performance: PerformanceFeatures,
}

fn default_performance() -> PerformanceFeatures {
    PerformanceFeatures {
        file_watcher: false,
        lsp_index: false,
        scheduler_daemon: false,
        syntax_highlighting: false,
        mermaid_diagrams: false,
        katex_math: false,
        code_editor_languages: false,
        plugin_auto_start: false,
    }
}
```

### 3.2 版本迁移

首次升级时 `config.json` 无 `performance` 字段，反序列化用 `#[serde(default)]` 自动填充默认值（全部关闭）。已有用户升级后：**文件监听和调度器将停止工作**——需要在设置页提示用户。

处理方案：
- 升级后首次启动，设置页显示一个横幅："检测到性能优化更新：以下功能已默认关闭以节省资源，如需使用请手动开启"
- 列出受影响的已有功能，引导用户逐一确认

### 3.3 前端配置模型

在 `src/stores/configStore.ts` 中同步新增 `performance` 字段定义和同步逻辑。

---

## 四、设置界面

新增设置面板 "性能与资源"（建议放在"编辑器"旁边）：

| 功能 | 默认 | 资源标签 | 说明 |
|------|------|----------|------|
| 文件自动监听 | ❌ | CPU | 监听工作区文件变化，自动刷新文件树 |
| LSP 智能索引 | ❌ | CPU + 内存 | 构建 AST 索引，提升代码跳转精度 |
| 调度器守护进程 | ❌ | CPU（低） | 后台轮询定时任务，到期自动执行 |
| 语法高亮 | ❌ | 内存 | 代码块语法着色（需 Mermaid/公式独立） |
| Mermaid 图表渲染 | ❌ | 内存 | 自动渲染 mermaid 代码块为图表 |
| KaTeX 公式渲染 | ❌ | 内存 | 自动渲染 LaTeX 数学公式 |
| 编辑器语言包预加载 | ❌ | 内存 | 预加载全部编程语言支持 |
| 插件服务自动启动 | ❌ | 内存 | 启动时自动拉起已启用插件的后台服务 |

---

## 五、实施顺序与工作量估算

### Phase 0：基础设施（0.5 人日）

- [ ] 定义 `PerformanceFeatures` 结构体（Rust）
- [ ] 添加到 `Config` + 默认值函数
- [ ] 前端 `configStore` 同步
- [ ] `config-changed` 事件通道打通
- [ ] 设置页"性能与资源"面板骨架

### Phase 1：后端开关（1.5 人日）

- [ ] file_watcher 开关（影响最大，CPU）
- [ ] lsp_index 开关
- [ ] scheduler_daemon 开关
- [ ] plugin_auto_start 开关

### Phase 2：前端开关（1 人日）

- [ ] syntax_highlighting 开关
- [ ] mermaid_diagrams 开关（含手动渲染按钮）
- [ ] katex_math 开关（含手动渲染按钮）
- [ ] code_editor_languages 开关

### Phase 3：兼容性与迁移（0.5 人日）

- [ ] 版本迁移横幅
- [ ] 旧配置兼容测试
- [ ] 端到端验证（每个开关开/关各测一次）

**总计：约 3.5 人日**

---

## 六、风险提示

1. **`regex_fallback` 精度**：LSP 索引关闭后回退到正则匹配，Java 多态/继承场景跳转可能不准
2. **插件懒激活用户体验**：首次使用插件功能时需要等待服务启动（2-3 秒），需加 loading 提示
3. **Mermaid/KaTeX 关闭后的展示**：代码块原样显示可能让用户误以为功能坏了，需在代码块上方加提示"点击渲染"
4. **版本升级体验**：老用户升级后多个功能突然"失效"，必须通过迁移横幅引导
5. **`enable_extensions` 已存在**：已有 `enable_extensions: false` 开关（见 config.rs 第 49-50 行），需与 `plugin_auto_start` 区分边界——前者是功能门控，后者是启动时机

---

## 七、不做的优化（非本方案范围）

- **重构代码**：不加开关也能减少的代码冗余（如合并重复 store）不在本次范围
- **依赖替换**：highlight.js 切 core、CodeMirror 语言包按需加载是 Phase 2 的"额外优化"，核心只是加开关
- **架构分层**：将编辑器能力拆为可选模块是大工程，本次只通过开关控制启用状态