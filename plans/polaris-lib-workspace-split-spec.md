# 立项（待评审）：polaris_lib workspace 拆分 —— 增量编译性能

> 状态：立项 spec，待评审。本文只立项不动代码。
> 关联：`plans/core-slimdown*`（插件化拆分，按进程边界；本方案按编译边界，方向互补）。

## 背景与数据（2026-11-07 实测）

- `src-tauri` 单 crate 约 30 万行；`polaris_lib` 的 debug 产物：rlib **727M** + staticlib **1.5G** + pdb 195M + incremental 缓存 **1.3G**。
- 每次保存任一 Rust 文件 = 增量编译 + **重写 727M rlib**（NTFS 纯 I/O 数秒～十几秒）+ 链接 exe——这是 `tauri:dev` 每编辑的固定硬成本，与改动内容大小无关，只与 crate 总量相关。
- `target/debug/incremental` 中 polaris_lib 单体占 1.3G，是 incremental 目录的绝对大头。

## 目标

把改动频率不同的功能域拆成 workspace member crate，使「每次编辑的重编译范围」从整个 30 万行缩小到被改的域（rlib 从 727M 降到 MB 级）。

## 方案（草案，评审后细化）

1. 第一批只拆「新增改动经常触碰 + 边界清晰」的域（对照 AGENTS.md「拆分须克制」红线）：
   - `services/git/*` + `crates/git-lanes` → `polaris-git`
   - `services/router/`（cap 总线，契约稳定）→ `polaris-router`
   - AI 引擎层（`services/ai_engine.rs`、`engines/`）→ `polaris-ai`（视中断链路耦合度，可能留第二批）
2. `lib.rs` 保留 feature 门控（`tauri-app` 等在最外层 member 声明）；命令层/协议类型随所属域走。
3. 每个 member 支持独立 `cargo check -p <member>`，成为日常内环验证。

## 红线

- 不做无收益的大规模搬家；每拆一个域，先用其改动频率数据证明收益。
- 命令门控（`--no-default-features` web-only 检查）与 cap 契约三处同步义务在每个 member 保持。
- 拆分不改变运行时行为：纯编译结构重组，无协议/状态改动。

## 验收

- 任一 member 内改一行 → `cargo check` 只重编该 member 及其下游 units；`cargo build --timings` 对比拆分前后。
- `target/debug/incremental` 总量与 deps 中 polaris_lib 相关产物显著下降。

## 依赖的前置/并行项

- 依赖库 `debug=false` 已落地（`.cargo/config.toml`，2026-11-07）。
- 构建入口纪律已写入 AGENTS.md §一（2026-11-07）。
- Defender 排除 + sccache 属环境项，与本立项正交。
