# Spring Boot Runner 集成文档

> Polaris 轻量级 Spring Boot 调试/运行/热部署工具 —— 面向 AI 开发流程的辅助能力。
> 本文档随开发持续更新。最后更新：2026-06-28（Phase 0 完成；Phase 1 第一增量：Maven/Gradle 发现）。

## 1. 背景与目标

- **目标**：在 Polaris 内提供轻量级的 Spring Boot 运行 / 热部署 / 调试能力，服务 AI 辅助开发流程。
- **定位**：轻量辅助工具，**非全功能 IDE 复刻**；交互参考 IDEA 的 Run/Debug 心智模型。
- **核心原则**：最大化复用 Polaris 既有能力（PTY、终端脚本、插件面板、文件监听、MCP），**复用而非重造**；分阶段验证，先搭可用框架。

## 2. 现状摸底：可复用能力

| 能力 | 现有实现 | 复用方式 |
|---|---|---|
| **进程引擎** | `src-tauri/src/commands/terminal.rs`（portable-pty）| `terminal_create(cwd, initial_command, env, purpose, script_id)` 跑 `mvn/gradle bootRun`；输出走 `terminal:output` 事件（base64 流），退出走 `terminal:exit`（带 exit_code），停止=`terminal_close` |
| **运行配置模型** | `src/stores/terminalScriptStore.ts` + `src/types/terminalScript.ts`（`TerminalScript`：name/command/cwd/env/source/autoRun/状态）| 借鉴"发现→配置→运行→状态"模型 |
| **脚本发现** | `terminal_script.rs` `terminal_discover_scripts`（**当前仅 package.json**）| 扩展 Maven(`pom.xml`)/Gradle(`build.gradle`) 发现 |
| **面板系统** | `src/plugin-system/`（`pluginPanelRegistry.register()` + manifest `views`）| 新增内置插件 `polaris.spring-boot`，挂 activityBar 面板 |
| **文件监听** | `src-tauri/src/commands/file_watcher.rs` | Phase 2 热部署：变更触发重编译/重启 |
| **MCP 接入** | `src-tauri/src/services/*_mcp_server.rs`（todo/scheduler/...）| Phase 4：暴露 `spring_boot_*` AI 工具 |
| **前端通信** | `src/services/transport`（`invoke` / `listen`，Tauri+web 兼容）| 复用 |

## 3. Phase 0 验证结果 ✅

### 3.1 环境

| 项 | 状态 |
|---|---|
| JDK | ✅ OpenJDK **17.0.19** LTS（`JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot`）|
| Maven CLI | ❌ 未安装（`~/.m2` 不存在）|
| Gradle CLI | ❌ 未在 PATH；但 `~/.gradle/wrapper/dists/gradle-8.14.3-bin` **有缓存发行版可用** |
| IDE | MarsCode（`.idea` 由其生成），非 IntelliJ，无 bundled Maven |

### 3.2 免依赖探针验证（`temp/spring-pty-probe/App.java`）

纯 JDK 单文件 web 服务（`java App.java`，零外部依赖），模拟 Spring Boot 启动特征，用于验证 PTY 链路。实测输出：

```
2026-06-28 02:13:01.715  INFO  --- [main] c.example.probe.App        : Starting App using Java 17.0.19
2026-06-28 02:13:02.126  INFO  --- [main] o.s.b.w.embedded.tomcat... : Tomcat initialized with port(s): 18080 (http)
2026-06-28 02:13:02.694  INFO  --- [main] o.s.b.w.embedded.tomcat... : Tomcat started on port(s): 18080 (http) with context path ''
2026-06-28 02:13:02.696  INFO  --- [main] c.example.probe.App        : Started App in 1.004 seconds (JVM running for 1.404)
```

| 验证点 | 结果 | 对 Phase 1 的意义 |
|---|---|---|
| Java 长进程启动 | ✅ | 进程引擎可承载 |
| 流式日志（stdout 时序捕获）| ✅ | 实时日志视图可行 |
| **启动完成锚点** | ✅ `Started ... in N seconds` | 启动状态判定正则锚点 |
| **端口就绪锚点** | ✅ `Tomcat started on port(s): N` | 端口探测正则锚点 |
| 真实端口监听 | ✅ `curl /` 正常 | — |
| 健康检查 | ✅ `/actuator/health` → `{"status":"UP"}` | 健康探测可复用 |
| 进程停止 | ✅ 终止成功 | 停止链路可行 |

> **注**：探针的优雅停止 `Shutting down` hook 在命令行 `kill` 下未触发——因 MSYS `kill` 在 Windows 走 `TerminateProcess`（无真 SIGTERM）。这**不影响** Polaris 真实场景：PTY `close_session` 关闭 master 让子进程收到挂断（EOF），与命令行 kill 语义不同。

### 3.3 真实 Spring Boot 项目骨架（`temp/springboot-demo/`）

标准最小 Spring Boot 3.2.5 项目，JDK17，源文件已就绪：

```
temp/springboot-demo/
├── pom.xml                                  # web + actuator + devtools(P2) + boot-maven-plugin
└── src/main/
    ├── java/com/example/demo/
    │   ├── DemoApplication.java             # @SpringBootApplication 主类
    │   └── HelloController.java             # / 与 /api/hello(带时间戳，供 P2 验证热部署)
    └── resources/application.properties     # server.port=8080 + 暴露 health
```

**状态**：源文件就绪。端到端跑 `bootRun` 需构建工具拉取依赖（见 §6 待决策）。

## 4. 架构方案（建议）

```
┌─ Spring Boot 插件面板 (前端 React) ─────────────┐
│  项目检测卡 │ 运行配置 │ 运行/停止/重启 │ 日志视图 │ 状态  │
└──────────────┬───────────────────────────────────┘
               │ invoke / listen (transport)
┌──────────────▼───────────────────────────────────┐
│  springBootStore  ──复用──>  terminal_create       │
│  (配置持久化+运行态)         terminal:output/exit   │
│                              terminal_close        │
└──────────────┬───────────────────────────────────┘
               │
┌──────────────▼─ 后端 (Rust) ─────────────────────┐
│  spring_boot_detect: pom/gradle 探测、主类、命令推断 │
│  portable-pty (复用现有 terminal.rs)               │
└───────────────────────────────────────────────────┘
```

**启动状态机**（基于日志解析）：`IDLE → STARTING →`（匹配 `Started .* in .* seconds`）`→ RUNNING`（+ 解析端口）；`terminal:exit → STOPPED/FAILED`。

## 5. 分阶段路线

| 阶段 | 范围 | 状态 |
|---|---|---|
| **P0** | temp 测试项目 + PTY 链路验证 + 文档 | ✅ 完成 |
| **P1** | 终端脚本发现增强 + Spring Boot Runner 面板（检测/运行/调试/停止/重启/状态/日志） | ✅ 完成 |
| **P2** | 热部署（devtools 自动重启 / file_watcher 触发重编译） | 待 |
| **P3** | 调试：**内置断点调试（自研 JDI 代理）**——编辑器行号设断点、命中暂停、调用栈/变量/对象展开、单步。**真实 Spring Boot 端到端验证通过** | ✅ 完成 |
| **P4** | MCP 工具（`spring_boot_run/stop/logs/status`）接入 AI | 待 |

## 5.1 Phase 1 进展（先轻后重 · 第一增量）

**决策**（用户确认）：工具形态采用"先轻后重渐进"；暂不联网跑真实 Spring Boot。

**已实现**：后端 `src-tauri/src/commands/terminal_script.rs` 扩展构建工具发现：
- 检测 `pom.xml` → Spring Boot 项目生成 `spring-boot:run`，通用生成 `package` / `test`
- 检测 `build.gradle[.kts]` → Spring Boot 项目生成 `bootRun`，通用生成 `build` / `test`
- wrapper（`mvnw` / `gradlew`）存在时优先，免全局安装
- Spring Boot 识别：pom 含 `spring-boot-starter-parent` / `spring-boot-maven-plugin` / `org.springframework.boot`；gradle 含 `org.springframework.boot` / `spring-boot-gradle-plugin`
- 新增 4 个单元测试；前端 `TerminalScriptSource` 放宽加入 `maven` / `gradle`

**效果**：打开 Spring Boot 项目时，现有 Terminal「项目脚本」面板直接出现 `spring-boot:run` / `bootRun`，可一键运行 / 停止，**复用现有全部 UI 与 PTY 运行链路**；前端仅放宽 source 类型，无其他改动。

**验证**：`cargo check --lib` 通过（无新增警告）；单元测试覆盖发现逻辑（Spring Boot 识别 / 纯 Maven 跳过 run / Gradle bootRun / wrapper 优先）。

## 5.2 Phase 1 进展（先轻后重 · 第二增量：Spring Boot Runner 面板）

**已实现**（纯前端，零 Rust 改动，最大化复用 PTY；聚焦 Maven）：
- `src/plugins/spring-boot/logParser.ts`：启动日志状态机纯函数（`starting → running(:port) / failed`），锚点 `Started ... in N seconds` / `Tomcat started on port(s)` / 失败信号 — **vitest 9/9 通过**
- `src/stores/springBootStore.ts`：`detect`（复用 `terminal_discover_scripts`）/ `start('run'|'debug')` / `stop` / `restart`；监听 `terminal:output` 解析状态、`terminal:exit` 收敛；日志 tail（16KB 上限）
- `src/plugins/spring-boot/SpringBootRunnerPanel.tsx`：项目检测卡 + 运行/调试/停止/重启 + 状态徽标 + 端口直达链接 + 启动耗时 + 日志视图
- 接入：`manifest.ts` + `builtinPlugins` 注册 + `pluginPanelRegistry` 懒加载 + 图标 `Rocket` + i18n(zh/en) + 工具切换器分组(run)/描述
- **调试（P3 提前轻量落地）**：Debug 模式经 `-Dspring-boot.run.jvmArguments="-agentlib:jdwp=...:5005"` 启动，外部调试器（IDEA/VS Code）可 attach

**验证**：vitest 9/9（日志解析）；`tsc --noEmit` 全量通过；待 `tauri:dev` 端到端实测。

**架构要点**：面板走 `PluginPanelHost`（`LeftPanel` 对插件 panelType 渲染），自身从 `useWorkspaceStore` 取当前工作区；运行复用 `useTerminalStore.createSession/closeSession`，与终端面板共享同一 PTY 会话模型。

## 5.3 乱码修复

**根因**：① Spring Boot/Maven 在 PTY(TTY) 下默认输出 ANSI 颜色码，面板 `<pre>` 裸显示成乱码；② 中文 Windows 下 JVM 默认 GBK 输出，前端按 UTF-8 解码乱码（实测 `jdb -version` 中文输出即乱码，当场印证）。
**修复**：① 运行命令加 `-B`（Maven 关颜色/进度）+ `-Dspring.output.ansi.enabled=never`；② env `MAVEN_OPTS` + 应用 JVM `-Dfile.encoding=UTF-8`；③ 面板侧 `stripAnsi` 兜底（`logParser.ts`）。
**验证**：vitest 12/12（含 `stripAnsi` 3 测）+ tsc 通过。

## 5.4 内置断点调试（自研 JDI 代理）✅

**决策演进**：jdb 文本解析（上一轮 MVP）→ **自研 JDI 代理**。jdb 输出格式跨 JDK 版本/场景不稳定、解析脆弱，不适合生产；改用 JDK 自带 `com.sun.jdi`（`jdk.jdi` 模块，零外部依赖）拿**结构化**调试数据。已删除 jdb 残留（`jdbParser.ts` / `SpringBootDebugSection.tsx`）。

**架构**：
```
被调试 JVM (spring-boot:run + -agentlib:jdwp ...:5005)
   ↕ JDWP
PolarisDebugAgent.java  (JDI, 单文件源码模式 java --add-modules jdk.jdi 运行, 免编译)
   ↕ 行命令(stdin) / JSON 事件(stdout)
commands/spring_boot_debug.rs  (Rust: 子进程管理 + 双向管道 → Tauri 事件)
   ↕ invoke / 'spring-boot-debug:event'
springBootDebugStore + DebugView + Editor 断点 gutter
```

**文件清单**：
- `src-tauri/resources/debug-agent/PolarisDebugAgent.java`：JDI 代理。attach / setBreakpoint(类延迟绑定 ClassPrepare) / continue / stepOver·Into·Out / 命中→调用栈+变量 / getChildren 对象展开 / 框架帧标记。`include_str!` 内嵌进二进制，运行时落地临时文件。
- `src-tauri/src/commands/spring_boot_debug.rs`：`spring_boot_debug_start/send/stop/java_path`；起停 agent、stdout→`spring-boot-debug:event`、stdin←命令。门控 `tauri-app`，`AppState.spring_debug` 持有会话。
- `src/plugins/spring-boot/debugProtocol.ts`：协议类型 + `parseDebugEvent` + `DebugCmd` + `deriveClassName`（文件→FQCN）。
- `src/stores/springBootDebugStore.ts`：编排 `start('debug')`→等 JDWP 就绪→attach 代理→下发断点；处理 stopped/continued/children/terminated；断点持久化、命中文件反查。
- `src/components/Editor/breakpointGutter.ts`：CM6 断点 gutter（点行号设/删）+ 命中行高亮；`Editor.tsx` 仅对 Java 启用并订阅 store 同步。
- `src/plugins/spring-boot/DebugView.tsx`：控制条（继续/单步/停止）+ 调用栈（框架帧折叠）+ 变量树（对象懒展开）；集成进 `SpringBootRunnerPanel`「调试」按钮。

**端到端验证（真实 Spring Boot，已实测通过）**：
- 环境实证：补 Maven（华为云镜像下载到 `temp/.toolchain`）+ 阿里云依赖镜像，`spring-boot:run` 真实启动（`Started DemoApplication in 4.7s`，:8080，devtools 生效）。
- 调试实证：agent attach :5005 → 断点 `DemoApplication:22` verified → `curl /` 触发 → **命中 Tomcat 请求线程** `http-nio-...-exec-2`，顶帧 `DemoApplication.home:22`（业务帧），其下 54 框架帧全部 `framework:true` 折叠；变量 `this=DemoApplication$$SpringCGLIB$$0`、`response=HashMap`（带 objectId 可展开）；continue 后 curl 正确返回。
- 编译：`cargo check --lib` exit 0（调试桥零警告）；前端 `tsc --noEmit` 0 错误。

**用法**：打开 Spring Boot（Maven）项目 → Spring Boot 面板点「调试」→ 在 Java 源码行号槽点红点设断点 → 触发对应请求 → 命中后在面板看调用栈/变量、单步/继续。断点须用 `mvnw`（项目自带）或系统 `mvn` 能启动应用。

**已知边界**：变量为顶帧（帧切换看变量为后续）；断点条件/表达式求值未做；devtools restart classloader 下同一断点会绑定两个 classloader（verified 事件重复，命中仍一次，无副作用）。

## 6. 关键设计决策

1. **工具形态** ✅ 已定：**先轻后重渐进**——先增强终端脚本（第一增量已完成），再按需升级独立面板。
2. **构建工具策略** ✅ 已定：**暂不跑真实 Spring Boot**，以 probe 验证的可行性推进开发；后续需要时用缓存 Gradle 8.14.3 或安装 Maven。
3. **调试方案** ✅ 已定（用户反馈后调整）：完整自研 JDWP 客户端太重 → 改为 **jdb 封装**（复用 JDK 自带 jdb + PTY，Polaris 内断点/单步/变量，零依赖）；远程 attach 保留为过渡出口。

## 7. 复现命令

```bash
# 免依赖探针（验证 PTY 链路）
cd temp/spring-pty-probe && java App.java 18080
curl http://localhost:18080/                 # -> Hello ...
curl http://localhost:18080/actuator/health  # -> {"status":"UP"}

# 真实 Spring Boot（需构建工具，见 §6）
# cd temp/springboot-demo && mvn spring-boot:run   # 或 gradle bootRun（需先建 build.gradle）
```
