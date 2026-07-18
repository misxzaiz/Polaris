# 自定义主题功能 — 实现记录与待解决问题

> **日期**: 2026-07-18
> **状态**: Phase 1-4 代码完成，编译通过，但**实际效果不符合预期，需重新评估**
> **分支**: 提交至远程临时分支（本地不保留）

---

## 一、当前实现状态

### 已完成（编译通过）

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 数据结构 / themeStore / Rust config / FOUC 脚本 | ✅ 代码完成 |
| Phase 2 | ThemeCustomTab / ColorPicker / 预设 CRUD / 导入导出 / 中英文案 | ✅ 代码完成 |
| Phase 3 | 背景（纯色/渐变/图片）/ 圆角档位 / 字体 / 透明度 / 毛玻璃 / 阴影 | ✅ 代码完成 |
| Phase 4 | CodeMirror / xterm / Mermaid 主题跟随 | ✅ 代码完成 |
| Phase 5 | 全量编译验证 + 端到端自测 | ⏸ 未完成 |

### 编译验证
- 后端 `cargo check --lib`：通过（仅无关既有 dead_code 警告）
- 前端 `tsc --noEmit`：本次改动文件零错误（既有基线错误 ModelProviderTab.tsx / PromptSnippetTab.tsx 与本次无关）

---

## 二、核心问题：实际效果不符合预期

**用户反馈**：目前效果不是想要的。

> ⚠️ 具体不符合点尚未细化，下次继续前需先明确「期望效果 vs 当前效果」的差距，再决定是调整还是重做。

### 待排查的可能方向（假设，需验证）

1. **视觉呈现层面**
   - 圆角档位用 `!important` 属性选择器批量覆盖 `.rounded-*`，可能覆盖过度/不足，导致局部布局观感异常。
   - 背景图/渐变通过 `body::before` + `body` 背景注入，可能被上层容器不透明背景遮挡，实际看不到效果。
   - 毛玻璃 `backdrop-filter` 作用于 `.bg-background-elevated/.bg-background-surface`，可能范围过大或性能差。

2. **交互/信息架构层面**
   - ThemeCustomTab 采用「预设列表 + 分区编辑器」布局，可能过于复杂/不直观。
   - 40 个颜色变量全量铺开，可能让用户无从下手（缺少「简易模式」）。
   - 内置预设与用户预设混排，切换/编辑心智模型可能不清晰。

3. **实时预览层面**
   - 预览通过 `previewCustomTheme` 直接改 DOM，切走 Tab 时 `endPreview` 恢复，可能存在预览态与持久态不一致的边界问题。

4. **期望可能是完全不同的方向**
   - 用户或许期望的是「整体换肤/皮肤包」而非「逐变量调色」。
   - 或期望更接近某个参考产品（如 VS Code 主题市场、Raycast 主题）的形态。

---

## 三、已交付的代码资产（可复用）

即便方向需调整，以下底层设施大概率可保留：

### 新增文件
| 文件 | 作用 | 复用价值 |
|------|------|----------|
| `src/types/theme.ts` | 数据结构 + 40 色变量清单 + 内置明暗色值镜像 + hex/rgb 工具 | 高 |
| `src/utils/customThemeRuntime.ts` | 运行时应用引擎（setProperty + `<style>` 注入） | 高 |
| `src/stores/builtinThemePresets.ts` | 5 套内置预设 | 中 |
| `src/components/Settings/ThemeCustomColorPicker.tsx` | 取色器组件 | 中 |
| `src/components/Settings/ThemeCustomEditors.tsx` | 背景/尺寸/特效编辑器 | 中 |
| `src/components/Settings/tabs/ThemeCustomTab.tsx` | 主设置面板（可能需重设计） | 低-中 |

### 改动文件
- `src/stores/themeStore.ts` — 自定义主题状态 + 预设管理 + debounce 落盘（**核心，建议保留**）
- `src/stores/configStore.ts` — 4 处 applyTheme 调用点补 hydrateThemeCustom（初始加载路径 loadConfig/submitToken）
- `src/types/config.ts` / `src/types/index.ts` — Config 加 themeCustom 字段
- `src/main.tsx` — FOUC 脚本扩展（自包含颜色预注入）
- `src/components/Settings/SettingsSidebar.tsx` / `SettingsPage.tsx` — Tab 注册
- `src/components/Editor/modernTheme.ts` — CM palette 硬编码 hex → `rgb(var(--c-*))`
- `src/components/Terminal/TerminalPanel.tsx` — xterm getComputedStyle 读变量
- `src/utils/mermaid-config.ts` — Mermaid themeVariables CSS 变量覆盖
- `src-tauri/src/models/config.rs` — Config 加 `theme_custom: Option<ThemeCustomConfig>`（serde default，不加 validate 重置）
- `src-tauri/src/services/config_store.rs` — OldConfig 迁移补字段
- `src/locales/{zh-CN,en-US}/settings.json` — themeCustom 文案

---

## 四、架构关键决策（供后续参考）

1. **CSS 变量覆盖方案**：颜色走 `documentElement.style.setProperty('--c-*', 'R G B')`，非颜色走 `<style id="polaris-custom-theme">` 注入。运行时生效，无需重编译 Tailwind。
2. **后端浅合并**：`config_store.patch()` 是顶层浅合并，`themeCustom` 必须整体回写；前端 themeStore 持完整 presets 副本作为单一数据源。
3. **落盘 debounce 400ms**：避免拖动 ColorPicker 时高频写 config.json。
4. **hydrate 只在初始加载路径**：loadConfig / submitToken 才 hydrateThemeCustom，updateConfig/updateConfigPatch 不回灌，避免与用户编辑竞态。
5. **内置预设 enabled=false 初始化**：首次使用不改变观感，用户主动开启才生效。

---

## 五、下次继续的建议起点

1. **先对齐期望**：让用户描述或截图「想要的效果」，或指出参考产品。
2. **再评估现有代码**：底层 runtime + themeStore + 数据结构大概率可复用，重点可能在 UI 呈现层与默认预设的视觉质量。
3. **可能的调整方向**：
   - 若嫌复杂 → 增加「简易模式」（只调主色 + 明暗 + 背景）。
   - 若嫌不好看 → 重做内置预设的配色质量 + 增加预览缩略图。
   - 若方向错了 → 保留 runtime，重设计交互形态。

---

## 六、验证方式（下次自测清单）

- [ ] 开启自定义主题 → 切换预设 → 界面配色实时变化
- [ ] 编辑颜色 → 实时预览 + 刷新后保持（FOUC 无闪白）
- [ ] 背景图/渐变实际可见（未被容器背景遮挡）
- [ ] 圆角档位切换全局生效且不破坏布局
- [ ] CodeMirror / 终端 / Mermaid 配色跟随
- [ ] 删除预设后其余预设不丢失（验证浅合并整体回写）
- [ ] 多语言文案正确
