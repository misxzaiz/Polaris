# PRD / HTML 预览卡片 UI 优化 —— 实施规划

> 关联：`plans/prd-preview-ux-optimization.md`（线 1 hydration 已实现；线 2 全屏等比）。
> 本文档把用户新提出的四项改进落到单一组件 `src/components/Chat/chatBlocks/ArtifactPreviewRenderer.tsx` 及周边。
> 目标：提高信息密度、展示宽度 ×2、边界融合、修复「第二个会话全屏显示第一个」。
>
> **状态：已实施（2026-10-26）**，见文末「五、实施记录」。

## 一、当前链路（2026-10-26 实证）

- AI 调 `preview_html` → Rust `prd_preview_mcp_server.rs` 生成 `Uuid` previewId，
  落 `.polaris/previews/<previewId>/index.html`，返回 structuredContent。
- 前端 `eventHandler.ts` `tool_call_end` → `parseCardData` → `PluginCardBlock.data`。
- `PluginCardHost` → `PrdPreviewCard`（MCP 卡）或直接 `ArtifactPreviewRenderer`（HTML 卡）。
- 渲染核心：`ArtifactPreviewRenderer`（iframe srcDoc + header + 全屏 portal + 源码/下载/新窗）。
- 布局：每会话独立 `SessionCell` + `SessionMessagesView`（react-virtuoso）+ 各自 iframe。

## 二、四项改进与根因

### 1. 根因：第二个会话全屏显示第一个
- Tauri `setFullscreen(true)` 是 **窗口级**全屏，非目标卡片级。
- Polaris 多窗口模式全会话并排，点「第二会话的全屏」→ 整窗全屏，界面停在旧滚动位置 → 观感「显示第一个」。
- **修复**：全屏改为「应用内覆盖层」，只放大本卡片（等比 letterbox + 铺满切换），退出回归原位。
  Tauri 窗口级全屏语义不再用于卡片预览。

### 2. 提高信息密度
- header 压缩：操作按钮收敛（高频：全屏/加宽/新窗；折叠：复制/下载/源码进「更多」菜单）。
- 版本序列 pills（v1/v2/...）切换：同 requirementId 多版本不再并排堆叠 —— 最新版出完整卡，
  历史版折叠为一行摘要，pills 在卡内切换查看（见 §三改动范围）。

### 3. 展示宽度 ×2
- **卡片「弹出加宽」**：点击后 fixed 面板（portal 到 body）锚定卡片位置，宽度 = 卡片宽 ×2
  （视口装不下则取可用宽），iframe 升到 50vh，Esc/收起按钮关闭，与全屏互斥。
- 内嵌卡片宽度被多会话格宽（`multiSessionCellWidth` 默认 350px）锁死，这是「预览窄」的根因；
  不改格宽默认值（被 zustand persist 持久化，对存量用户不生效且全局影响文本阅读宽度），
  ×2 落点在弹出加宽与全屏覆盖层。

### 4. 边界融合
- iframe 白底直接贴合卡片圆角（去灰底包裹）；圆角对齐 `--chat-bubble-radius`；
  iframe onLoad 前显示与聊天背景同色的骨架（防白闪）；`p-1.5` 死条件清理。

## 三、改动范围（实际）

| 文件 | 改动 |
|---|---|
| `ArtifactPreviewRenderer.tsx` | 全屏等比档按实测宽高比（`aspect-ratio`，替代固定正方形）；加载骨架；弹出加宽 portal；版本 pills（`versions` prop）；`p-1.5` 死条件清理 |
| `chatBlocks/artifactVersions.tsx`（新） | 会话级版本分组 context：`buildArtifactVersionsMap` / `ArtifactVersionsProvider` / `useArtifactVersions` / `ArtifactVersionGate`（历史版折叠行）/ `buildArtifactBlockFromData`（MCP data 归一化，与 PrdPreviewCard 单一实现共用） |
| `chatBlocks/index.tsx` | `artifact_preview` / `plugin_card` 两分支统一包 `ArtifactVersionGate`；`ArtifactPreviewWithVersions` 从 context 取 versions 下发 |
| `messages/SessionMessagesView.tsx` | `useMemo(displayMessages) → buildArtifactVersionsMap`，`ArtifactVersionsProvider` 提供会话级版本组（穿透 AssistantBubble memo） |
| `plugins/prd-preview/PrdPreviewCard.tsx` | 复用 `buildArtifactBlockFromData`（删重复映射）；两条渲染分支下发 `versions` |
| `ArtifactPreviewRenderer.test.tsx` / `artifactVersions.test.tsx`（新） | 骨架/加宽/互斥/等比/pills 折叠闸门/分组归集 共 26+9 用例 |

不改后端、不改插件协议、不改 store/JSONL（版本组是只读渲染层归集）。

## 四、验收

1. 点第二会话「全屏」只放大该卡，退出回原位（不再整个窗口全屏）。✅ 单测覆盖；**双会话运行时复测待做**（见实施记录）
2. header 更紧凑，操作按钮收敛；多版本时出现版本 pills，历史版折叠为摘要行。✅ 单测覆盖
3. 卡片宽度约 ×2（弹出加宽，桌面），iframe 更高。✅ 单测覆盖
4. 白底渐隐融入、圆角与消息一致，onLoad 前有骨架不白闪。✅ 单测覆盖
5. `pnpm exec tsc --noEmit` + `pnpm lint` + 相关 vitest 通过。✅（见实施记录）

## 五、实施记录（2026-10-26）

**方案复核后的三处调整**（对照先前分析稿）：
1. **放弃「默认格宽 350→450」**：`multiSessionCellWidth` 被 zustand persist 持久化（view-store），
   改默认值对存量用户不生效，且全局影响所有会话格文本阅读宽度。×2 由弹出加宽承担。
2. **弹出加宽必须 portal 到 document.body**：react-virtuoso 用 transform 定位 item，
   组件树内 `position: fixed` 会被劫持为相对定位。与全屏覆盖层同模式。
3. **保留 iframe「双挂载」**：全屏/加宽时内嵌 iframe 不卸载 —— 退出无重载白闪、
   iframe 内交互状态保留；隐藏副本开销对 KB 级预览可忽略。属有意权衡，不作为缺陷修。

**验证结果**：
- `pnpm exec tsc --noEmit` 通过；改动文件 eslint 0 error 0 warning
  （chatBlocks 目录余 3 条 warning 为存量：FormCard / PluginCardHost / ToolCallBlockRenderer）。
- vitest：受影响范围 `src/components/Chat/` + `src/plugins/prd-preview/` 16 文件 218 用例全过，
  无 unhandled error；`src/stores/conversationStore/` 的 36 个 unhandled error 为存量
  （该目录本次未改动）。
- 渲染器 26 用例（尺寸自适应 3 + 应用内全屏 4 + 更多菜单 2 + 骨架 1 + 弹出加宽 3 + 等比 1 + pills 3 等）、
  artifactVersions 9 用例。

**待人工/运行时验收**：
- 问题 4 的双会话实测（两个会话各出一原型 → 点第二个的全屏 → 只放大该卡）。根因修复属
  结构性消除（组件内已无任何 `setFullscreen` 调用），但 spec §二.1 的候选 A（数据层串扰）
  未做运行时排除 —— 若实测仍复现，按该节排查 memo/数据注入路径。
- 弹出加宽在真实多窗口布局下的定位手感（冻结定位，不跟随滚动；Virtuoso 把卡片滚出
  虚拟化窗口时加宽面板随之卸载 —— 当前接受，反馈差再做存活化）。

## 六、定稿：底部沉浸状态条（2026-10-27）

用户对首轮实现反馈"头部占用空间过多/高度没变/原生滚动条丑"，经两轮原型对比页
（Gen UI 可视化，4+4 方案）定稿：

- **否决悬浮渐显条（原型 B）**：依赖 hover，触屏 App 上不可操作；用户原意倾向悬浮但
  明确以 App 可用性为先，改选 **A 沉浸直通**。
- **底部状态条（32px，常驻）**：文件点 + 标题（tooltip 带 description）+ 版本分段控件 +
  常驻仅 **全屏 / 更多** 两键。元信息（HTML·大小·时间·需求号）为菜单顶部信息行；
  加宽（×2）/新窗/复制 HTML/复制路径/下载/源码 全部收进「更多」菜单（触屏可达）。
- **内嵌高度**：~~桌面 `min(60vh, 640px)`~~ → **`min(75vh, 760px)`，与卡片宽度彻底解耦**
  （2026-10-27 实测反馈修正：旧版按格宽降级 16:9，默认 350px 格只有 240px——"没有加高"的根因；
  窄格同样拿高预览）→ **`min(50vh, 480px)`**（2026-10-27 第二轮实测反馈：75vh/760 偏高大半屏，
  调低为约对话面板一半高，兼顾预览密度与上下文可见性）。
- **滚动条**：展示层向 srcDoc 注入细化 CSS（6px、悬停加深、`scrollbar-width: thin`），
  仅渲染派生串，存储/下载/新窗仍是原始 html。
- 预览区直通卡片上缘（无头部栏），onLoad 前骨架防白闪；版本 pills 为分段控件样式。

### 实测反馈第二轮（2026-10-27）

1. **加宽直达**：用户实测"要在更多点加宽，和我想的不一样"——「加宽（×2）」从菜单提回底栏，
   常驻键为 **全屏 / 加宽 / 更多** 三个；菜单内去掉重复的加宽项。
2. **全屏默认铺满**：默认档由等比改为铺满；localStorage key 升级为
   `polaris.preview.fsmode.v2`，避免旧档位记忆覆盖新默认；等比档保留可切换。
