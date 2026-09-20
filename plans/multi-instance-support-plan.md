# 多实例支持规划

> 状态：已落地（P1–P4，2026-09-19）；仅剩 P4 快捷方式生成器未做
> 相关提交：`6c626ad2`（2026-08-19，引入 single-instance 插件 + 代码创建主窗口）
> 收尾遗留见 §9；行尾（LF/CRLF）处理暂缓，见 §10

## 1. 问题陈述

当前应用无法同时运行多个进程。此前（2026-08-19 之前）可以，是因为那时还没有单实例守护。

**当前阻塞点**：`src-tauri/src/lib.rs:543`

```rust
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    // 新进程启动 → 唤起旧实例 main 窗口 → 新进程退出
}))
```

这个插件在 `Cargo.toml` 中属于 `tauri-app` feature，是 `default` 必含项，**当前没有编译开关可以关掉**。

**关键认知**：当时加单实例不是最终方案，是止血。原根因从未被修复：

> 多个 `polaris.exe` 共用同一个 WebView2 `UserData` 目录，旧实例锁住目录后，
> 新实例创建 webview 失败（`0x8007139F`「组或资源状态不正确」）——
> 后台服务全绿，桌面窗口不显示。8-18 当天 44 次启动 39 次失败（≈89%）。

现在的代码只做了**跨构建模式**的目录隔离（dev / test-profile / release），
**同模式内多进程仍然落到同一个目录**。所以直接删插件 = 89% 的启动失败率原样回归。
**正确做法：先修目录隔离，再放开多实例。**

## 2. 跨实例资源盘点

逐个核对了会跨进程共享的每一项资源：

| # | 资源 | 位置 | 当前状态 | 多实例后果 |
|---|---|---|---|---|
| 1 | WebView2 `UserData` | `lib.rs:646-665` | 按编译模式隔离，同模式内共用 | **硬阻塞**。`0x8007139F`，第二个实例窗口不显示 |
| 2 | 数据根 DataRoot | `services/data_root.rs:163` | `%APPDATA%/Polaris`，无实例维度 | 数据互不可见 |
| 3 | `config.json` | `services/config_store.rs:158` | 原子写（tmp + rename），**无跨进程锁** | **静默竞态**，后写覆盖先写 |
| 4 | 日志 `app.log` | `services/logger.rs:30` | `rolling::daily`，按天滚动 | 安全，两实例交织写入 |
| 5 | `dialogs/index.db` | `services/dialog_index.rs:139` | SQLite + **WAL 模式** | 读并发安全，但**未设 `busy_timeout`**，第二个实例写入会直接 `database is locked` |
| 6 | `.polaris/index.db` | `services/lsp_index/db.rs:79` | 每工作区独立，**已有 WAL** | 同上，缺 `busy_timeout` |
| 7 | 插件服务子进程 | `services/plugin_service_manager.rs:210` | 无实例标记/锁 | **重复 spawn**，可能端口冲突 |
| 8 | 内置 Web 服务 | `web/server.rs:205` | **已有 `AddrInUse` 自增重试**（原无上限） | 可用，但可能扫遍整个端口空间 |
| 9 | 代理转发器 | `services/proxy/mod.rs:73` | 恒传 `port = 0`（OS 分配） | 安全，无冲突 |
| 10 | `ask_listener` | `services/ask_listener.rs:125` | `bind("127.0.0.1:0")` | 安全 |
| 11 | dev discovery 文件 | `web/server.rs:52` | `.polaris-dev/server.json` 单文件覆盖 | 仅 debug，第二实例覆盖第一个 |
| 12 | Vite dev server | `vite.config.ts:78` | 端口 9827 固定，`strictPort` | dev 起不了两个（与单实例无关） |
| 13 | 托盘 / 全局快捷键 | — | **未使用** | 无冲突 |
| 14 | 文件锁 / 命名互斥体 | — | **完全没有** | 无 |

**结论**：只有 #1 是硬阻塞；#3、#7 是会真正损坏数据的静默问题；#5、#6、#8 是可用性问题；其余安全。

## 3. 设计目标

1. 正式版（release MSI）支持同时运行 N 个独立实例
2. 每个实例独立数据，互不覆盖
3. 单实例语义作为**默认关闭的能力保留**（回退路径）
4. dev 与 release 的隔离语义不变
5. 不引入新的第三方依赖

**不做**：窗口聚合管理、实例间通信、实例列表 UI。这些留到后续版本。

## 4. 方案选型

### 方案 A：每实例完全隔离（类 VS Code 新窗口）

`--instance <n>` → 全部数据落在 `%APPDATA%/Polaris/instances/<n>/`

- 优点：实现最简单，零竞态
- 缺点：每实例一份 config.json → **改一次设置要改 N 次**；插件重复下载/重复起进程
- 评价：安全但体验差，配置漂移是长期负债

### 方案 B：共享 + 实例专属混合（推荐）

数据分两层，只有**真正会互踩的**才下沉到实例层：

```
%APPDATA%/Polaris/                 ← 共享层（所有实例）
├── anchor.json                    锚点
├── config.json                    配置（加跨进程锁）
├── plugins/                       插件包与插件服务
├── requirements/
└── cache/

%APPDATA%/Polaris/instances/<n>/   ← 实例层（每实例独立）
├── logs/app.log                   日志按实例分文件
├── dialogs/index.db               会话索引
├── scheduler/                     定时任务
├── downloads/                     下载
└── .meta/
```

- 优点：设置/插件一处维护；互踩的数据物理隔离
- 缺点：`data_root.rs` 需要一层路径路由；`config_store` 需加锁
- 评价：**符合用户对"多开"的直觉**——共用配置，各干各的活

### 方案 C：仅修 WebView 目录，其他全共享（最小改动）

只把 `data_directory` 按实例拆分，DataRoot 不动。

- 优点：改动 < 30 行
- 缺点：#3（配置竞态）、#7（重复插件进程）原样存在，属于**带病放行**
- 评价：只适合"先验证 0x8007139F 已修好"的验证分支，不适合发布

### 选型

**采用方案 B**，按下面的阶段推进。第一阶段（仅 WebView 隔离）本身就是一个可发布的
安全中间态，能独立验证根因修复，再叠加数据分层。

## 5. 分阶段实施

### Phase 1：WebView2 UserData 按实例隔离（解硬阻塞）

改动面：`lib.rs` 一处 + 一个小的参数解析。

1. 引入实例号解析，优先级从高到低：
   `--instance <n>` → `POLARIS_INSTANCE` env → `0`
   参数解析放在 `Builder` 之前、`std::env::args()` 原生解析即可（不引入 clap）。
2. WebView 目录改为：
   - 实例 0：`com.polaris.app\EBWebView`（**保持现状，零迁移**）
   - 实例 ≥1：`com.polaris.app.inst<n>\EBWebView`
3. 同样处理 dev：`com.polaris.app.dev` / `com.polaris.app.dev.inst<n>`
4. 加 feature 开关 `multi-instance`（默认 **on**），
   关闭时继续注册 `tauri-plugin-single-instance`。

验收：起两个 `polaris.exe --instance 1`，两个窗口都出来，
`[Window] 主窗口创建成功` 出现两次，无 `0x8007139F`。

### Phase 2：数据根分层 + 配置跨进程锁（解静默损坏）

1. `DataRoot` 拆成 `SharedRoot` + `InstanceRoot`，`APP_NAME` / `ANCHOR_DIR_NAME` 逻辑不动，
   新增 `instance_root(n)`。
   - 兼容策略：实例 0 继续使用现有 `config_dir()/logs_dir()/...` 的**原路径**，
     零数据迁移；仅实例 ≥1 走 `instances/<n>/`。
2. `config_store.rs` 的 `save()` 加跨进程互斥：Windows 下对 `config.json.lock` 用
   `CreateFile` + `FILE_SHARE_READ`（或 `flock` crate 跨平台），
   **带 2s 超时 + 超时降级告警**。降级必须打 `tracing::warn`，否则竞态照样静默。
3. 日志文件名加实例后缀：`app-0.log` / `app-1.log`（用 `tracing-appender` 的自定义 filename）。
4. `dialogs/index.db` 与 `.polaris/index.db` 加 `busy_timeout = 5000`；
   lsp_index DB 补 `journal_mode = WAL`（当前没设，是写锁的主要来源）。
5. 插件服务管理器按实例起进程，端口写进 `instances/<n>/.meta/plugin_ports.json`
   供插件间发现，避免默认端口撞车。

验收：两实例各改一次配置，两边最终值一致且都是最后一次写入的值；
日志各自独立文件；并发写 index.db 无 `database is locked`。

### Phase 3：Web 服务端口容错（解可用性问题）

`web/server.rs:158 start_on_available_port` 的 `loop` 名不副实——
`bind` 失败直接 `return Err`，并没有自增重试。改为：

```
preferred → preferred+1 → ... → +16（上限，避免遍历整个端口空间）
```

实例 ≥1 时 `preferred` 本身就该错开（`9830 + n * 7`），减少概率性冲突。

### Phase 4：用户入口 + 实例标识

1. 主窗口标题、任务栏标题加实例标记（仅 n ≥ 1 时显示，如 `Polaris · 2`），
   避免用户分不清哪个窗口是哪个。
2. 提供"再开一个实例"入口。两种做法：
   - **推荐**：在 `bin/` 下生成 `polaris --instance N` 快捷方式
     （`%APPDATA%/Polaris/Shortcuts/polaris-2.lnk`，用 COM IShellLink 或 sh 协议）。
     用户在开始菜单/桌面拖图标即可，最直观。
   - 备选：托盘菜单 `Command::new(exe).arg("--instance").arg(n).spawn()`。
3. 首次启动检测"是否有历史多实例数据残留"，给迁移提示。

### 里程碑

| 阶段 | 内容 | 预估 | 可独立发布 | 状态 |
|---|---|---|---|---|
| P1 | WebView 隔离 + feature 开关 | 小 | ✅ | 已实施 |
| P2 | 数据分层 + 配置锁 + SQLite 调优 | 中 | ✅（含 P1） | 已实施 |
| P3 | Web 端口容错 | 小 | ✅ | 已实施 |
| P4 | 用户入口 + 标题标识 | 中 | ✅ | 标题已做，快捷方式未做 |

### P2 落地时的实际取舍（与原设计不同）

**调度器不隔离**。原设计把 `scheduler/` 划入实例层，实施时发现
`commands/scheduler.rs` 通过 `data_root().config_dir()` 解析路径——
这个调用同时被 25 处**插件、agents、skills** 代码复用。把 `config_dir()`
整体下沉到实例层会连插件和 agents 一起搬走，而插件/agents 是明确共享层资源。
因此调度器跟随共享层，作为已知限制记录在 §6。

**日志按实例分文件而非分目录**：`app-<n>.log`。避免 `log_dir()` 的
2 处调用方要感知实例目录。

**不加 `fs2` 依赖**：`Cargo.lock` 无此 crate，用手写 Windows `CreateFile`
锁。超时（3s）后打 `tracing::warn` 并继续写——降级不静默。

## 6. 风险与已知限制

1. **WebView2 目录成本**：每个实例一个 `EBWebView`，缓存随使用增长（每实例百 MB 级）。
   需在设置里加"清理实例缓存"，否则长期会累积。
2. **updater 逐实例弹**：`tauri-plugin-updater` 是进程级的，
   N 个实例会弹 N 次更新提示。可接受，但要在产品上知晓。
3. **插件子进程重复**：即使按实例起进程，同一插件的多次实例仍是多份内存占用。
   不做插件进程共享（跨实例 IPC 复杂度高、收益低）。
4. **锚点 anchor.json 仍是全局的**：用户改了自定义 dataRoot，
   所有实例跟着变。这与"共享层"语义一致，但要写进文档。
5. **配置锁超时即降级**：锁等待超时后如果选择"继续写"，竞态仍可能发生。
   超时值（建议 2s）要覆盖典型写耗时，并且**必须有日志**，
   否则等于没锁。
6. **MSI 安装不杀进程**：安装器没有 stop-service/close-application hook，
   升级时若已有实例在跑，MSI 文件会被占用导致安装失败。这是现有问题，
   多实例只会让它更容易触发（在跑的进程更多）。Phase 2 顺带修。
7. **回退路径**：`--features multi-instance` 关掉即恢复单实例行为，
   出问题可以只关 feature 出热修，不用回滚数据。

## 7. 验证计划

每个 Phase 完成后跑：

```bash
# 1. 编译（正式版）
cargo build --release

# 2. 起两个实例，确认都创建窗口成功
./target/release/polaris.exe --instance 0 &
./target/release/polaris.exe --instance 1 &
tasklist | grep -c polaris          # 期望 2

# 3. 检查 UserData 目录分离
ls "$LOCALAPPDATA" | grep com.polaris.app   # 期望出现 .inst1

# 4. 日志各自独立（Phase 2 后）
ls "%APPDATA%/Polaris/instances/1/logs/"

# 5. 配置互不覆盖（Phase 2 后）
#    两实例交替修改同一配置项，确认最终值一致

# 6. 关闭开关回退
cargo build --release --no-default-features --features "tauri-app git lsp-index -multi-instance"
#    起两个实例，第二个应聚焦第一个并退出
```

## 8. 待决问题

1. **实例号分配策略**：`--instance N` 显式指定，还是自动分配空闲槽位？
   倾向显式——自动分配需要全局 registry，又多一个共享写入点。
2. **快捷方式生成时机**：启动时惰性创建 vs 安装器创建。倾向惰性。
3. **是否保留 single-instance 作为默认**：倾向**默认关闭**（即默认允许多开），
   理由是这个功能回归到加锁前的行为，且已有一条明确的 feature 回退路径。
   如果担心误开导致 0x8007139F，也可以默认开启、用户显式 `--multi-instance` 开启，
   但那样和"要支持多实例"的目标相反。
4. **Windows 专属**：`additional_browser_args` 和 `CreateFile` 锁都是 Windows 语义。
   当前 `Cargo.toml` 没有非 Windows 目标，暂不做跨平台抽象，
   但配置锁建议直接用 `flock`/`fs2` crate 而不是手写 CreateFile，
   顺手就跨平台了（这条与"不引入新依赖"的约束冲突，需拍板）。

## 9. 多开收尾遗留项

P4 只做了窗口标题标识（正式版多实例显示 `Polaris 2`，dev 版 `Polaris - dev 2`）。
未做的两项：

1. **快捷方式生成器**（原设计 §5 Phase 4 推荐项）。没有它，用户只能手动改
   启动命令传 `--instance N`，「再开一个实例」这条主路径不通。
2. **MSI 安装不注入实例参数**。多实例依赖 `POLARIS_INSTANCE_ID` 环境变量区分，
   若安装脚本（wix/msi）没实现这一步，装两份时两边都拿到默认值、互不隔离。
   代码层已就绪，打包脚本未改。

## 10. 暂缓事项：行尾（LF / CRLF）

> **状态：记录后暂缓，本多开计划完成后再处理。**

### 现象（已实测）

仓库 `core.autocrlf = false`，`.gitattributes` 对所有文本文件声明 `text eol=lf`。
在此配置下，工作区与 Git index 的行尾**不一致**：

| 位置 | 行尾 | 说明 |
|---|---|---|
| Git index / HEAD | **LF** | `.gitattributes` 规范化结果 |
| 工作区 | **混合** | 原始检出为 CRLF；被工具或 `git add` 触碰过的变成 LF |

**各编辑工具的行为（实测，差异显著，务必注意）**

| 工具 | 实测行尾行为 |
|---|---|
| `write_file` | **会转换**：传入 LF 内容，在 Windows 下落盘为 CRLF |
| `apply_patch` | **会转换**：把整份文件规范化为 LF |
| `edit_file` | 不确定；但**在 CRLF 文件上不支持多行 `old_string`**（已实测报错） |

实测依据：本文件本身即为证据——它由 `write_file` 写入（传入纯 LF 内容），
落盘后 Python `rb` 读取为 **325 个 CRLF**，与 17501 字节的 LF 版本不同。
`apply_patch` 则把同一文件翻成了 **纯 LF**。两者的转换方向相反，
说明「编辑工具改过的文件是 LF、没改过的是 CRLF」这种分裂是工具行为导致的。

当前工作区实况：`lib.rs` / `data_root.rs` / `logger.rs` / `dialog_index.rs` /
`lsp_index/db.rs` / `services/mod.rs` 为 **纯 LF**，`config_store.rs` 为
**纯 CRLF**。每个文件内部都自洽，**没有混合行尾的文件**。

### 结论

1. **Git 侧自动规范化正常生效**，`git diff` 未被行尾污染
   （`--numstat --ignore-space-at-eol` 与普通 `--numstat` 结果一致），
   提交后不会把行尾变更带进历史。这是安全的。
2. **编辑工具与 Git 会互相"抵消"**：`apply_patch` 把工作区文件规范化成 LF，
   `git add` 也会按 `.gitattributes` 存成 LF。因为 index 本来就是 LF，
   这些翻转**不会污染提交**，副作用只是工作区里"改过的文件是 LF、没改过的是 CRLF"
   这种状态分裂。
3. 每次触碰 CRLF 文件，Git 都会打印
   `warning: in the working copy of '...rs', CRLF will be replaced by LF the next time Git touches it`。
   属噪音，但说明工作区行尾并未真正收敛。
4. 用 `grep -c $'\r'` 之类的 shell 方式统计行尾**不可靠**（`git_bash` 下 `\r`
   转义行为不固定）：同一次会话里 `grep` 报 CRLF=1142，Python `rb` 读取报 CRLF=0。
   **需要时统一用 Python 以二进制模式读取统计。**
5. 由于每个文件内部行尾自洽，IDE 不会显示混杂标记；但逐字符比对的 diff 工具
   仍会把 LF / CRLF 两版判为整文件变更。

### 处理方案（暂缓执行）

多开收尾完成后统一处理，二选一：

- **A（推荐）：全仓规范化为 LF。** 一次性把工作区所有 `.rs` 等文本文件
  转成 LF，让工作区与 index 一致，警告消失。
  风险：会产生一次巨大的纯行尾 diff，必须**单独成一个 commit**，
  不能与任何功能改动混在一起，否则 review 无法进行。
- **B：保留现状，把警告当已知噪音。** 零风险、零 diff，但警告持续存在，
  且工作区与 index 行尾不一致的状态会一直留着。

**注意**：`git add` 会把工作区 CRLF 规范化为 LF 再入 index，因此任何
「改代码 + 顺带规范化行尾」的混合提交都会把行尾变更掺进功能提交。
处理时必须与功能提交分离。
