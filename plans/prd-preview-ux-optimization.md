# PRD 预览用户体验优化 —— 方案规划

> 背景：opencode Code Mode 卡片链路修复后的两轮实测暴露两个用户侧痛点（2026-10-17）。
> 视角：从用户实际体验出发定义行为承诺，再落到实现。状态：**线 1 已实现**（2026-10-17 —— `PrdPreviewCard.tsx` 新增 `HydratingPreview`：投影 data 经 `getFileContent(sourcePath)` 静默补齐 html 直出 iframe，失败退通知兜底，不回写存储；测试 `PrdPreviewCard.test.tsx` 5 用例）。**线 2（全屏等比）已按 `plans/prd-preview-card-ui-overhaul.md` 落地**（2026-10-26：全屏改为应用内覆盖层 + 等比/铺满切换 + localStorage 记忆；等比档按进全屏前实测的内嵌盒宽高比 `aspect-ratio` letterbox，验收项「比例≈内嵌实测值」达成）。

## 一、用户痛点（实测还原）

### 痛点 1：预览时有时无
- **场景**：让 AI 出原型预览 → 回复结束后，预览区有时是可交互的 iframe 页面，有时只有一条"✅ 预览已生成 → 打开源码"，还要再点一次才能看到页面。
- **根源**：同一个工具、同一张卡，但模型 return 的 data 形状不稳定 —— 完整 artifact 出真预览，投影字段（只挑 version/previewId 等）落通知分支。
- **用户期待**：预览就是预览，不需要为模型的书写习惯买单。

### 痛点 2：全屏"变横屏"
- **场景**：聊天里的预览是 420px 高的近方形盒子，观感正常；点全屏后铺满宽屏显示器，窄卡片居中 + 左右大片空白，看起来"躺倒了"。
- **根源**：全屏覆盖层 `h-full w-full` 无条件铺满，无宽高比约束、无 letterbox；预览内容又多为竖向排版。
- **用户期待**：全屏 = 内嵌同一页面的放大版，比例不突变。

## 二、行为承诺（改完之后用户看到什么）

1. **投影视图自动升级为真预览**：data 缺 html 但有 `previewId`+`sourcePath` 时，卡片自己读回落盘文件，直接渲染 iframe（次数 0 次点击）；升级失败才退回"预览已生成 + 打开源码"。
2. **全屏保持内嵌比例**：默认按内嵌盒子实测宽高比等比放大、居中留边（letterbox）；工具栏提供"铺满"切换；选择记忆（localStorage），下次全屏沿用。
3. 两条线落地后，"预览已生成"降级为极罕见的兜底（文件被删/读取失败）。

## 三、实现方案

### 线 1：投影 hydration（纯前端，无协议/后端改动）

- **位置**：`src/plugins/prd-preview/PrdPreviewCard.tsx`。
- **改动**：
  - `PreviewGeneratedNotice` → 升级为自 hydrating 组件 `HydratingPreview`：mount 时若 data 无 html 且有 previewId+sourcePath → 走 `fileExplorerStore.get_file_content(sourcePath)`（已有能力，走 `invoke('get_file_content')`）读回 html → 无告警成功即把块数据替换为完整 artifact 形状 → 渲染 `ArtifactPreviewRenderer`。
  - 读文件前先应用户操作边界：**读取本身不需要确认**（sourcePath 由本地 MCP 落盘生成，路径拿来即用；非信任边界）。
  - 失败路径（文件不存在/读取超时）→ 保持现有 `PreviewGeneratedNotice` 兜底，不打扰。
  - 状态管理：组件内部 useState（loading/failed/hydrated），不写回 store/JSONL（避免大字段二次落盘与双写路径 —— 单一写入路径仍是 eventHandler）。
- **边界**：只对本插件卡片生效，不动通用 PluginCardHost；iframe 沙箱属性不变。

### 线 2：全屏等比 + 铺满切换（纯样式/交互）

- **位置**：`src/components/Chat/chatBlocks/ArtifactPreviewRenderer.tsx` 全屏 portal 段（303-322 一带）。
- **改动**：
  1. 进全屏前**实测内嵌盒子**（header 下方那个预览 div）的 `getBoundingClientRect()`，取宽高比 `ratio`。
  2. 全屏内容区改为 flex 居中容器，iframe 包一层盒子：`width: min(100%, (视口高-上下栏) * ratio); aspect-ratio: ratio` → 等比放大、超出留边，视觉即"内嵌同版放大"。
  3. 工具栏加"铺满/等比"IconButton（Maximize2/FitScreen），一键切换；默认"等比"，选择写 `localStorage['polaris.preview.fsmode']`，下次进入沿用。
  4. 铺满档 == 现行为（`h-full w-full`），冒烟回归零风险。
- **边界**：`TOPBAR_HEIGHT` 遮挡逻辑不变；"在浏览器打开"等按钮行为不变。

## 四、所有者与验收

| 项 | 所有者 | 验收 |
|---|---|---|
| 线 1 | `PrdPreviewCard.tsx` + `fileExplorerStore`（只读复用） | 1) 投影 data 的卡片 0 交互出 iframe；2) 断言 data 缺 html+文件存在 → hydrate 成功；3) 文件删除 → 通知兜底；4) hydration 不回写 store/JSONL |
| 线 2 | `ArtifactPreviewRenderer.tsx` | 1) 全屏默认等比居中（比例≈内嵌实测值）；2) 切铺满 == 旧行为；3) 刷新后记住上次档位；4) Esc 退出、40px 顶栏保留不回归 |

- 全量门槛：`tsc --noEmit` / `eslint` / 相关 vitest 通过；simpleai 原生路径（structuredContent 全量 data）渲染回归。
- 人工验收：新 opencode 会话各发一次"裸 return"与"投影 return"，均出真预览；桌面端实际全屏观察比例。

## 五、风险与回退

- 线 1：读取大文件（>MB 级预览）→ 现有预览 HTML 均 KB 级；仍失败即兜底通知，无死路径。不回写存储 → 无数据风险。
- 线 2：默认档变更（铺满 → 等比）——等比即"内嵌原样放大"，心智连续；localStorage 可随时切回，`git revert` 单文件可撤。
