# 手机自包含路线探路报告(三道闸门)

> 背景:用户澄清「纯手机端无需连接电脑」= **解读②(手机完全自包含)**。已实施的三批(P0 安全闸/⑥单写者/1B PWA)服务于方案 A(后端在别处),对解读②未交付。
> 本报告 = 报告推荐路线里 B/C 重启前置条件 2 的三道闸门探路,结论决定是否全面开工 M1(内嵌极简核)。
> 执行日:2026-10-25。

## 闸门③:${usesCleartextTraffic} release 解析值 —— ✅ 已核实,问题成立,修复便宜

- `gen/android/app/src/main/AndroidManifest.xml`:`android:usesCleartextTraffic="${usesCleartextTraffic}"`(字面占位符)
- `gen/android/app/build.gradle.kts`:`defaultConfig` → `"false"`;`debug` → `"true"`;**`release` 继承 default → `"false"`**
- **结论:release APK 中 WebView 访问 `http://127.0.0.1:<port>`(内嵌核)会被 cleartext 策略拦截**(Android 的明文限制对回环同样生效)——分析报告担心的「内嵌核物理不可用」**成立**。
- **修复(已定型,未实施)**:加 `networkSecurityConfig` 仅对 `127.0.0.1` 放行明文(不要全局放开——用户可能配远程 http 服务端,全局放开会降级其安全);同时需决策 gen/android 入库或 CI 固定 init(现 `.gitignore:111` 不入库,改动会被重新 init 覆盖的隐患要排除)。

## 闸门②:data_root 启动顺序契约 —— ✅ 已核实,Android 必 panic,修复便宜

证据链(全部本日读码):
- `lib.rs:500` `run()` 第一行 = `Logger::init(true)`;
- `logger.rs:26` `init` → `log_dir()` → `data_root().logs_dir()` —— **首次 data_root() 发生在 Logger::init 内部**;
- `data_root.rs:344-346` `data_root()` = `OnceLock::get_or_init(resolve_default().expect(...))`;
- `data_root.rs:145-147` `default_data_root()` = `dirs::config_dir().ok_or_else(...)`;Cargo.lock 锁定 dirs 5.0.1 → dirs-sys 0.4.1,**android 下 home_dir/config_dir 返回 None**(注册表源码实读,分析报告 §3.6)。
- **结论:Android 上 run() 第一行即 panic("DataRoot 初始化失败")。** 桌面路径不受影响(Windows config_dir 正常)。
- **修复(已定型,未实施)**:`run()` 在 `Logger::init` 之前加 `#[cfg(target_os = "android")]` 块,用 `ndk-context`(tauri android 传递依赖)取 App 沙箱 filesDir 设 `POLARIS_DATA_ROOT` env(进程内 env 注入即被 resolve_default 优先级 1 接住),~10 行。

## 闸门①:git2/openssl 交叉编译 —— 门控已实施,check 进行中

- **根因确认**:`Cargo.toml` 的 `git = []` 是空 feature,只门控代码;`git2 = { features = ["vendored-openssl"] }` 依赖本身**无条件**,vendored-openssl 因此进入所有目标(分析报告两个作者独立复现失败于 openssl-sys 与此一致)。
- **利好面核实**:reqwest = rustls(无 native-tls);rusqlite = bundled(NDK clang 可编);notify 6 支持 android;portable-pty 已显式排除 android。
- **已实施**:`git2` 改 optional + `git = ["dep:git2"]`(默认构建含 git feature,桌面行为不变)。
- **进行中**:`cargo check --target aarch64-linux-android --lib`(默认 features=tauri-app+git+lsp-index,即 APK 完整配置;NDK 26 clang + minSdk 24)。结果与剩余错误面见 §结果。

## 结果(2026-10-25,aarch64-linux-android check 完成)

**命令**:`cargo check --target aarch64-linux-android --lib --no-default-features --features tauri-app`(NDK 26 / clang API 24 / minSdk 24;`git`/`lsp-index` 剔除)。

**结论:闸门①实质通过——核心链路全部编译,错误面 31 个、集中且机械。**

- **通过的部分**:rusqlite(bundled,NDK clang 编 C 通过)、reqwest(rustls)、ring、session-v2 存储、router 总线、ai_chat_core、SimpleAI——M1 需要的核心全部过了 android 编译。
- **错误面归类**(31 errors / 11 文件):
  | 类别 | 文件 | 数量 | 性质 |
  |---|---|---|---|
  | 桌面命令层 | `commands/terminal.rs`(17)、`commands/browser.rs`(14)、`commands/window.rs`(2) | 33 处命中 | tauri 桌面 API(menu/webview.close/PtySize/set_always_on_top)在 android target 被 tauri configure out;需 `#[cfg(desktop)]` 门控——即报告预言的"run() 桌面面",机械修复 |
  | git models | `models/git.rs` | 3 | git2 门控暴露的无 feature 门引用;**已修**(`models/mod.rs` 加 `#[cfg(feature="git")]`,web-only 构建恢复绿色) |
  | 零散桌面假设 | `ipc.rs`/`registry_capability`/`cli_resolver`/`lib.rs`/`router/mod`/`mcp_capability`/`dialog_storage` | 各 1-2 | AppHandle/CLI 解析等零散点 |
- **另注**:默认 features(含 git)下 openssl-sys 构建失败于 **Git Bash perl 缺 Locale 模块**——host 工具链问题非 android 问题;移动构建不带 git feature,不触此雷。

**三道闸门总账**:
| 闸门 | 结论 | 修复量级 |
|---|---|---|
| ① 交叉编译 | ✅ 核心过,31 错误机械门控 | ~半天(cfg(desktop) 包 3 个命令模块 + 零散点 + invoke_handler 注册分支) |
| ② data_root panic | ✅ 成立,Android 必 panic | ~10 行(cfg(android) 在 Logger::init 前经 ndk-context 注入 env) |
| ③ release cleartext | ✅ 成立(release=false 拦回环明文) | networkSecurityConfig 仅放行 127.0.0.1 + gen/android 入库决策;**仅内嵌核路线需要**(纯前端直连方案不监听回环,不需要) |

## M1 全量成本预估(闸门①结果修正)

- 前置闸门修复:①+② ≈ 1 天(③ 视路线)
- **纯前端直连路线(P0,本次用户新指令)**:闸门①② 仍需(APK 要打包 lib)但 Rust 侧零新增逻辑;前端新增本地对话引擎(直连 OpenAI 兼容端点 + OPFS 会话 + Gate 第二入口)≈ 天级;**不需要闸门③**
- **内嵌核路线(P1/M1)**:闸门①②③ + run() 移动分支装配(run_web_server 进 mobile)+ 本机 UI 的 Source::Remote 契约课 ≈ 1-2 周级;换来后端权威架构一致与后续工具/插件扩展
- 两路线 UI 完全一致(复用现有前端),差异只在引擎层——按"引擎适配器"接口设计可先 P0 后 P1 平滑替换
