# 主题瘦身 Phase 1 — 去手动编辑化（AI 优先）

## 背景

主题手动管理（新建/编辑/复制）与内置 Spider-Man 主题将从核心移除。主题调整的正路是
AI 对话（`cap.ui.theme`，已全链路可用）；手动导入/导出/删除暂留作安全网（AI patch 会
堆积新主题、生成指南旧工作流依赖导入），Phase 3 管道补齐后再评估退役。分析过程见
多 agent 摸底（2026-10-25 会话）。

## 目标

1. 删除编辑器链：`ThemeEditor/ThemePreview/CssEditor/ColorPicker/themeAssets/cssValidator`（6 文件，~1620 行，已核实无其他消费者）。
2. `ThemeManager` 仅保留：卡片列表 + 使用/导入/导出/删除。删除 新建/编辑/复制 按钮与编辑器挂载。
3. 删除内置 Spider-Man 主题（数据/短名映射/favicon 分支/`applyPreset` 枚举项）；保留 `public/spiderman/*.jpg` 资产（老用户自定义主题可能引用，CSS url 404 静默降级不崩溃）。
4. 顺删死代码：themeStore 旧 `applyTheme/setTheme/migrateFromLegacy/exportTheme` 包装、`duplicateTheme`、themeService `migrateLegacyConfigTheme`、themeEngine `readLegacySpiderManConfig`（均无调用方）。
5. 保留：`cap.ui.theme` AI 通道（applyPreset 枚举收窄为 dark|light）、ThemeTab 生成指南、legacy `spidermanTheme` config 字段（Phase 4 独立协议变更再删）。

## 所有者与接口

- 状态真相不变：前端 `themeStore`（localStorage + activeThemeId→config 持久化）。
- 接口变化仅一处：`cap.ui.theme applyPreset` 合法值 `dark|light`（Rust 校验 + describe 同步收紧）；其余 6 动作协议不变。

## 迁移与安全

- 存量 `active_theme_id` 指向 Spider-Man：三重兜底优雅回退 Dark（getActiveThemeId 校验 / applyThemeSync 回退 / applyThemeById warn+回退），已验证不崩溃。
- 老 config.theme='spiderman'：短名映射移除后 `getBuiltInThemeByShortName` 返回 undefined → 不切主题（保持当前），无副作用。

## 验收

- `pnpm typecheck` / `pnpm lint` 通过；`uiDispatchService.test.ts`、`uiConsumeLink.test.ts`、`config-refactor.test.ts` 全绿。
- `cargo check` 与 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过；`apply_preset_validates` 测试语义不变（dark 合法 / unknown 拒绝）。
- 净删除 ≥1500 行前端代码。
