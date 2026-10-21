# spec: 内置 MCP 工具缺失——双重 .exe 后缀 bug 与 Web 打包旧名修复

## 背景（问题现象）

用户反馈：在别的电脑安装 Polaris 后，SimpleAI 会话**有时**识别不到 `cap.*` / `ask` / `prd` 等内置 MCP 工具。

典型工具列表对比（用户贴的缺失场景）：
- 在：`read_file / write_file / bash / browser / computer / recognize_image / search_plugins / dispatch_agent / update_plan`（SimpleAI 原生工具 + 外部插件 MCP，如 marketplace-server）
- 缺：`cap_dispatch / cap_list / bus_help / ask_user_question / list_requirements / prd_*` 等（全部由内置 `polaris-mcp` 提供的工具）

## 根因分析（两个独立 bug，均导致"内置全缺、外部插件在"）

### Bug 1（本次新增确认，**桌面/便携平铺布局下的主因**）：双重 `.exe` 后缀

`src-tauri/src/services/mcp_config_service.rs` 的 `resolve_mcp_executable_path()` 平铺兜底分支对已含平台后缀的路径做了二次 `.exe` 包裹：

```rust
// 调用方 resolve_mcp_contribution_binary 传入：
&mcp_exe_path(MCP_FALLBACK_PATH)        // 已 = "polaris-mcp.exe"（Windows）
// 平铺分支：
let flat_exe_path = mcp_exe_path(bundled_fallback_relative_path);  // = "polaris-mcp.exe" + ".exe" = "polaris-mcp.exe.exe" ❌
let flat_path = exe_dir.join(flat_exe_path);                        // 查 "…\polaris-mcp.exe.exe"，不存在
```

**触发条件**：`resource_dir=None`（平铺安装无 `Resources/` 子目录）且 env 未设、dev/release 路径不存在（安装机上 `CARGO_MANIFEST_DIR` 推导路径不存在）时，平铺分支是唯一兜底。此时查 `polaris-mcp.exe.exe` 必然失败 → **全部 10 个内置 MCP server 定位失败、跳过**。

**日志实锤**（本机 dev 数据根 2026-10-21 05:01，构建 polaris-mcp 前）：
```
WARN [MCP] 跳过可选 MCP server polaris-prd-preview: 进程错误: 无法定位 polaris-mcp。
  已检查资源路径 '<无资源目录>'、'<无资源目录>'、平铺安装路径 'D:\space\base\Polaris\src-tauri\target\debug\polaris-mcp.exe.exe' …
```
注意日志里 `polaris-mcp.exe.exe` 双后缀。构建出二进制后（05:45），dev_path 分支短路平铺分支，才恢复正常。

**修复**：平铺分支直接用传入的 `bundled_fallback_relative_path`（已含正确平台后缀），不再 `mcp_exe_path()` 二次包裹。新增回归测试（已存在 `prefers_flat_install_layout_when_resource_dir_missing` 期望单后缀，修复后由红转绿）。

### Bug 2（已在另一份 spec 提过，Web 便携部署）：`package-web.mjs` 拷贝旧 MCP 二进制名

`scripts/package-web.mjs` 的 `mcpBins` 仍是 f2906391（MCP 二进制合并）前的旧名：
`polaris-todo-mcp / polaris-requirements-mcp / polaris-scheduler-mcp / polaris-prd-preview-mcp / polaris-computer-mcp / polaris-ask-mcp / polaris-dispatch-mcp / polaris-browser-mcp / polaris-agnes-mcp`。

这些二进制合并后**已不存在**（仅 `polaris-mcp.exe`），Web 便携部署 `polaris-web/` 目录拷不到 MCP 二进制 → Web 端内置工具全缺。

**修复**：`mcpBins` 收敛为单一 `[{ name: 'polaris-mcp', required: true }]`；`required: true` 保证缺失时打包直接失败提示，防回归。

## 版本时间线澄清（排除的假设）

- f2906391（MCP 二进制合并，2026-08-01）已在 v10.7.0 中 —— 版本合并滞后假设排除。
- builtin 标记与过滤（d751d755 / bb996c0c）在 v10.7.0 之后但非缺失根因 —— 过滤逻辑对内置总是放行。
- `D:/APP/polaris` 上 `polaris-mcp.exe` 存在且握手成功 —— 二进制缺失假设排除；握手是手动调用，绕过解析。

## 修改方案

1. `src-tauri/src/services/mcp_config_service.rs`（Bug 1）：
   ```rust
   let flat_exe_path = bundled_fallback_relative_path.to_string();  // 不再 mcp_exe_path() 二次包裹
   ```
2. `scripts/package-web.mjs`（Bug 2）：
   ```js
   const mcpBins = [{ name: 'polaris-mcp', required: true }];
   ```

## 验收

1. 平铺安装（如 `D:/APP/polaris`，无 Resources 子目录）下启动桌面版，SimpleAI 会话工具列表包含 `cap_dispatch / cap_list / bus_help / ask_user_question / list_requirements` 等内置工具；日志出现 `[MCP] polaris-mcp 在平铺安装目录找到: …\polaris-mcp.exe`（单后缀）。
2. `node scripts/package-web.mjs --no-build` 输出目录含 `polaris-mcp.exe`，不再出现"未找到可选 MCP 二进制" warn；缺失时 `required: true` 强制失败。
3. `cargo check --bin polaris-mcp` 通过；`prefers_flat_install_layout_when_resource_dir_missing` 测试绿。

## 回归影响

- Bug 1 修复只影响 `resource_dir=None` 的平铺兜底分支；资源目录 / dev / release / env 分支行为不变。
- Bug 2 修复只影响 Web 便携打包产物；桌面 MSI/NSIS 打包路径不受影响（tauri v2 自动收 bin）。
- 两者都使内置 MCP 工具在对应部署形态下从"缺失"变为"可用"。
