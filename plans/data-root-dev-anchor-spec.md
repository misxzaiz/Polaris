# 数据根 dev 锚点修复 spec（dev 改路径无效 + 安装版锚点启动）

日期：2026-11-11　状态：已实施
关联：`AGENTS.md` §3.3 数据根与隔离；`services/data_root.rs`；`scripts/tauri-dev-web.mjs`

## 1. 背景与根因

解析优先级（`data_root.rs::resolve_default`）：`POLARIS_DATA_ROOT` env > anchor.json > 默认目录。

dev 会话（`tauri:dev:web` 注入 env → `%APPDATA%/Polaris-dev`）里执行 `cap.data_root set_root`：

```
dev set_root(Y) ──写──> %APPDATA%/Polaris/anchor.json   ← 生产锚点（dev 非 test-profile，
                                                            ANCHOR_DIR_NAME 编译期 = "Polaris"）
重启（env 重新注入）──env 优先级 1──> 数据根回 Polaris-dev，「改了又变回去」
```

**根因：写读不对称——dev 进程读的是 env、写的是生产锚点。** 违反不变式：

> 进程写的锚点 ≡ 进程下次启动读的锚点

生产级后果（2026-11-11 01:31 实发事故）：dev 会话 move_data 把数据复制到 `D:\app\polaris-dev-s`
并把自定义路径写进生产锚点；安装版（release）从此解析到该路径，dev 却回退 C 盘，数据分裂双头。

## 2. 目标

1. `pnpm tauri:prod:web`：dev 构建直接读**安装版锚点**（`%APPDATA%/Polaris/anchor.json`）。
2. dev 里改数据根路径**重启后生效**（两种 dev 启动模式都成立）。
3. 数据统一到 `D:\app\polaris-dev-s`（用户指定，C 盘只留锚点），残留清理。

## 3. 方案

### 3.1 Rust（`data_root.rs` + `router/data_root_capability.rs`）

- **锚点目录重定向**：`anchor_dir()` 优先读 `POLARIS_ANCHOR_DIR` env（非空才生效）；
  未设置时行为不变（编译期 `ANCHOR_DIR_NAME`）。dev 脚本注入 `%APPDATA%/Polaris-dev`，
  使 dev 的 set_root 写到 **dev 专属锚点**。
- **set_root 守卫**：`POLARIS_DATA_ROOT` 有值而 `POLARIS_ANCHOR_DIR` 无值时
  （env 外部注入且无对应锚点，写了必然无效），`set_root` / `validate_target` 直接报错拒绝，
  文案指路启动脚本。消除「静默假成功」。
- **决策层透明**：`DataRoot` 捕获来源枚举 `source ∈ {env, anchor, default}`；
  `get_info` 新增 `source` 与 `debugBuild`（`cfg!(debug_assertions)`）两个附加字段
  （只增不改，协议保守）。
- 修正 `test_resolve_env_priority` 的过时注释（原文「不覆盖 anchor 自定义」与代码相反）。

### 3.2 启动脚本（`scripts/tauri-dev-web.mjs` + `package.json`）

- `tauri:dev:web`（默认，隔离模式）：解析 **dev 锚点链**：
  读 `%APPDATA%/Polaris-dev/anchor.json` → 有 `dataRoot` 用之，否则回退 `%APPDATA%/Polaris-dev`；
  注入 `POLARIS_DATA_ROOT=<解析值>` + `POLARIS_ANCHOR_DIR=%APPDATA%/Polaris-dev`。
  用户已手工导出 `POLARIS_DATA_ROOT` 时透传不覆盖。
- `tauri:prod:web`（新增 `--installed-anchor`）：**不注入**数据根/锚点相关 env，
  Rust 解析自然落到安装版锚点链；保留 `POLARIS_WEB_PORT`/`POLARIS_DEV_WEB_TOKEN`。
- `--print-root`：干跑打印两种模式的解析结果与环境变量注入表，用于验证与用户自查。

### 3.3 数据统一与清理（已执行，属运维操作不入库）

1. 停两个运行实例（dev 83632 整树 + 安装版 107472）。
2. `robocopy /E /XO` 增量合并 Polaris-dev → `D:\app\polaris-dev-s`（11 文件 5.12MB，
   二次 /L 校验待拷=0；目标自 00:31 快照后零写入，合并为纯后代超集，无 .legacy 冲突）。
3. 双锚点落盘：安装版（已存在）与 dev 锚点均指 `D:\app\polaris-dev-s`。
4. 清理 Polaris-dev：122MB → 19KB（仅剩 anchor.json + .meta 历史）。
   C 盘 `%APPDATA%/Polaris`（1.26GB 旧生产数据，09-27 起休眠）**不删**，留给用户决策。

## 4. 时序（修复后）

```
tauri:dev:web ──读 dev 锚点──> 注入 POLARIS_DATA_ROOT=Y + POLARIS_ANCHOR_DIR=<dev锚点目录>
  set_root(Z) ──写──> dev 锚点（Z）
重启 ──脚本读 dev 锚点 Z──> 注入 Z ──> 生效 ✔      （不变式成立）

tauri:prod:web ──不注入──> Rust 读安装版锚点
  set_root(W) ──写──> 安装版锚点（W）
重启 ──读安装版锚点 W──> 生效 ✔                  （与安装版同链，dev=生产行为一致）
```

## 5. 验收

- [ ] `cargo check` / `cargo clippy --lib` 无新增告警；web-only 门禁通过
- [ ] `pnpm exec tsc --noEmit` 通过
- [ ] 脚本 `--print-root`：dev 模式解析出 dev 锚点值；prod 模式解析出安装版锚点值
- [ ] 守卫单测：env 有/锚点无 → 拒绝；env 有/锚点有 → 放行；env 无 → 放行
- [ ] `get_info` 含 `source`/`debugBuild`

## 6. 边界与挂账

- `bin/polaris_mcp.rs:182`、`services/ask_listener_meta.rs:81` 各自重复实现 env 解析
  （单权威违例），本次不动，后续收敛进 `data_root()`。
- `tauri:dev` / `tauri:dev:win`（无 env 注入，直跑生产链）本次不改行为，仅 spec 记录风险。
- `is_isolated()` 判定不变（env 或 test-profile）；`tauri:prod:web` 下自启护栏与既有
  `tauri:dev` 同水位，未恶化。
- 浏览器侧 OPFS 历史会话不受 DataRoot 管辖，另案。

## 7. 参考

- Tauri 上游同题缺陷：[tauri#16337 dev 数据写入系统目录](https://github.com/tauri-apps/tauri/issues/16337)
- 通行做法即 env 覆盖 + dev 后缀目录（[Tauri Config](https://v2.tauri.app/reference/config)、
  [Path API](https://v2.tauri.app/reference/javascript/api/namespacepath)）；
  本方案在其上加锚点重定向补齐写读对称。
