# 插件系统升级·阶段 1 spec：止血 + 让失败变响亮

> 状态：待评审
> 日期：2026-10-22
> 来源：三 agent 多视角分析投票（ZCode 设计视角 / Polaris 现状视角 / 插件作者视角），见本文档末尾「投票纪要」
> 对照基准：`temp/ZCode`（v3.15.1+，HEAD 3c5b2276）、`D:\space\base\Polaris-plugin`（商城索引仓库）

## 1. 背景与问题

三方侦察实锤的核心缺陷（摘要，行号为侦察当日快照）：

- **P0 安全**：安装/更新全链路从不校验 index.json 声称的 sha256，依赖 jsdelivr `@main` 非冻结源（`plugin_service.rs:1406-1470`）；`RealContext::check_permission` 恒 Allow（`router/mod.rs:680-682`，嵌套派发旁路）；卸载按命令行 LIKE 全局杀进程误杀无辜（`plugin_service.rs:706`）。
- **正确性**：dispatcher 流式-同步回退分支重复广播 `dispatch.end`（`mod.rs:552-579`），破坏事件顺序语义；`apply_local_plugin_update` 不先 `stop_services_for_plugin`，Windows 文件锁致 rename 回退、装完跑旧代码（更新路径不停服——6 选项外新发现）。
- **契约漂移**：manifest schema 三份手写（Rust 结构体 / Rust 校验器 18 icon / 前端 17 icon），`SquareTerminal` 插件装成功但前端静默丢弃 view（`pluginDiscoveryService.ts:168-179`）。
- **作者生态**：一次发版 4 处元数据手工同步（plugin.json / update.json / zip 内 / index.json）+ CDN `@main` 缓存陷阱；panelType 全局唯一冲突后装者静默覆盖。

## 2. 投票结论与顺序裁决

- 总分：A 安全包 = 6、B 契约体系 = 6、E 作者 DX = 4、F 生命周期 = 2、C 治理 / D 前端重构 = 0（其值钱子片被拆入各阶段）。
- 主要冲突（A 先 vs E 先）：安全校验收紧在 publish 工具落地前上线，会放大安装失败率。**裁决：双轨制**——阶段 1 内 sha256 以 warn+audit 软模式上线，publish CLI 同期交付；阶段 2 翻砖 enforce。

## 3. 目标（阶段 1 exit）

P0 清单 6 项中 5 项关闭（插件 JS 面板沙箱除外，入阶段 3）；面板「静默消失」类事故在安装期变为显式报错；作者发版 ≤1 条命令。

## 4. 所有者与落点边界

- **后端**：`src-tauri/src/services/plugin_service.rs`、新增纯模块 `src-tauri/src/services/plugin_package.rs`（下载/校验逻辑，不引入 tauri 类型，保证两向门控可编译、逻辑可测）、`src-tauri/src/services/router/mod.rs`。**不碰 `commands/`**。
- **前端**：`src/plugin-system/schema.ts`（新单一校验器）、`src/plugin-system/registry.ts`、`pluginStore.ts`。
- **发布工具**：`Polaris-plugin/scripts/publish.mjs`（商城仓库，不在本仓库 CI 范围）。

## 5. 工作项（每项独立可交付，先 spec 后实现，commitlint 单主题提交）

| # | 工作项 | 内容 | 验收 |
|---|---|---|---|
| 1.1 | **B-lite 契约止血 ✅（2026-10-22 实施）** | Rust：manifest 类型树全加 `#[serde(deny_unknown_fields)]` + 新增 `manifestVersion` 字段（缺省=当前版本，未声明即 fail fast）；TS：`plugin-system/schema.ts` 单一 zod `.strict()` 校验器替换 `pluginDiscoveryService.ts:107-129` 手写副本；icon 白名单 17↔18 双向对齐（`SquareTerminal` 收编进前端） | `pnpm typecheck` ✅；新增 vitest：① SquareTerminal view 不被静默丢弃 ✅ ② 未知字段拒绝 ✅ ③ icon 双向 diff 测试（两侧常量集相等断言）✅；`cargo check` 两向 ✅ / test profile ✅ / web 门控 ✅。保守取舍：缺省 manifestVersion 兼容存量商城 manifest（已核实 14 插件字段全被模型树覆盖）；`manifest.compat` 扩展字段同步落地（serde default，spec 1.9 前置）；Rust 单测执行仍受 DLL 限制（编译通过） |
| 1.2 | **嵌套派发权限收口** | `RealContext` 持有宿主 `Permission` 引用，`check_permission` 复宿主同一 PolicyPermission 判定；Prompt 仍 Deny + audit 落链 | `cargo check` 两向；`router/mod.rs` 既有测试编译通过；`policy_permission.rs` 内新增 Plugin 来源 deny 断言（尝试 `cargo test --lib -- policy_permission`，跑不通如实记录） |
| 1.3 | **双 dispatch.end 修复 + reason 化 ✅（2026-10-22，部分）** | 双 `dispatch.end` 广播已删除（`router/mod.rs` 流式回退分支，一次 dispatch 恰一个终态事件）；`plugin.lifecycle` reason 枚举逐一核实：`plugin_discovery_capability` 7 处 emit（installed/updated/uninstalled）与 `plugin_events`/`mcp_capability`（state_changed）全部经由统一 `lifecycle_payload` 构造器，两通道 payload 形状已对齐 | `cargo check` 两向 ✅ / test profile ✅ / web 门控 ✅。残留：`ctx.emit` 走 Claude 风格 `{kind,payload,trace}` Event、`broadcast_plugin_lifecycle` 走 `{"event","payload","seq"}` 字符串通道——wire 形态统一需要 UI 联动验证（前端事件归一逻辑），盲改协议不做，待验收转手测 |
| 1.4 | **更新路径停服 + MCP client 驱逐** | `apply_local_plugin_update` / `install_remote` 前调 `psm.stop_services_for_plugin`；`cap.mcp` 新增 `evict(serverId)` action，update/uninstall 后调用 | `cargo check` 两向 + `--no-default-features` 门控；更新后进程退出旧代码验证（手测记录） |
| 1.5 | **进程杀收敛** | 删 `plugin_service.rs:706` 无条件命令行 LIKE 兜底杀（通用运行时保留 image-name 精确杀）；进程归属收敛到 PSM/pid 登记；杀不掉降级 warn（宁漏勿杀）+ audit | `cargo check` 两向；卸载 e2e 手测：并行无关 node 进程存活 |
| 1.6 | **下载链加固（软启动）** | 新 `plugin_package.rs`：reqwest connect/total timeout + 字节上限（64MiB）+ 禁 `http://` + loopback/内网目标默认拒绝（显式 config 豁免）；sha256 校验逻辑就位但**仅 warn + audit 记录 mismatch**（双轨软模式，enforce 翻砖在阶段 2） | `cargo check` 两向；篡改 zip → 安装仍成功但 audit 有 sha256 mismatch 告警；逻辑单元测试（若 `cargo test --lib -- plugin_package` 可跑则附） |
| 1.7 | **publish CLI + 冒烟测试** | `Polaris-plugin/scripts/publish.mjs`：读 plugin.json 单源 → 同步 update.json / index.json / zip 内清单 → 计算 sha256 回写 → 校验 version ≈ tag、检出 `@main` 残留 → 交互确认打 tag；另加 `smoke.mjs`：spawn `node mcp/server.js` → initialize → tools/list 握手 | 商城仓库 dry-run 真实输出核对；smoke 对现有 14 插件全绿（记录真实结果，失败列清单不隐瞒） |
| 1.8 | **注册冲突显式化** | panelType / views[].id 跨插件唯一性：安装与启动期检测，冲突拒绝后装者 + 设置面板红条（含双方插件名） | 前端 vitest：冲突注册被拒且 UI 呈现；ActivityBar 不再「点这个开那个」 |

## 6. 事件顺序与所有权（1.4/1.5/1.6 交互）

```
安装/更新(install_remote / apply_local_plugin_update):
  1. download (plugin_package.rs: 限流+SSRF 检查+sha256 warn)
  2. psm.stop_services_for_plugin(id)        ← 1.4
  3. cap.mcp evict(serverId)                 ← 1.4
  4. staging → 备份 → rename（保留既有原子流）
  5. manifest 校验(deny_unknown_fields)      ← 1.1，失败=显式报错不静默丢 view
  6. emit plugin.lifecycle {reason:installed|updated}

卸载:
  1. psm.stop_services_for_plugin(id)
  2. cap.mcp evict(serverId)
  3. pid 精确清理（仅 PSM 登记 + image-name）；无 LIKE 兜底    ← 1.5
  4. 删目录（保留 canonicalize_allowed_plugin_dir 白名单）
```

不变量：**进程所有权单轨 = PSM**；**事件一次一终态**；**校验失败必须显式可归因**。

## 7. 不做（防止范围蔓延）

- 不做 iframe 面板沙箱、React 双副本清理、状态 owner 迁移（阶段 3）。
- 不做 codegen schema 工具链（阶段 2 决策点）。
- 不动 `commands/` 旧路径；不在本阶段拆分 `plugin_service.rs` 主体（仅移除死代码与迁移函数到 `plugin_package.rs`，净缩小于巨石但不做大手术）。

## 8. 已知边界（如实）

- 本机 `cargo test --lib` 不可用（DLL 限制）：1.1/1.2/1.6 新逻辑尽量落无 tauri 依赖的纯模块，测试能跑则跑、不能跑如实标注；DLL 根因排查单独立项（不在本 spec）。
- 商城 sha256 字段从未被验证过，enforce 前需 publish CLI 产出数据先自证一致（1.7 的 dry-run 即为此准备）。

## 9. 投票纪要（存档）

| 方向 | ZCode 视角 | 现实视角 | 作者视角 | 总分 |
|---|---|---|---|---|
| A P0 安全包 | 3 | 3 | 0 | 6 |
| B 契约权限 | 2 | 2 | 2 | 6 |
| E 作者 DX | 0 | 1 | 3 | 4 |
| F 生命周期 | 1 | 0 | 1 | 2 |
| C 治理 / D 前端重构 | 0 | 0 | 0 | 0 |

对 A/E 冲突的裁决理由：sha256 enforce 与 publish CLI 顺序绑定（作者视角主张成立）；但 A 中四件纯后端推进项（嵌套权限、双 dispatch、进程杀、下载限流）与 DX 无冲突，先行——多数派「止血不等人」与其「可验收性」论证（改动小、`cargo check` 两向 + vitest 覆盖）成立。
