# 交互面板全屏改造 —— 实施 spec（定稿）

> 状态：**已定稿**（按推荐方案，2026-11-09）
> 定案：操作栏样式 **A（醒目主按钮）**，不新增额外按钮；宿主零改动。
> 上游：`plans/interactive-v2-spec.md`（v2 自包含插件）、`plugins/docs/interactive-component-implementation-plan.md`。
> 原型：`plans/interactive-fullscreen-prototype.html`（三态对照，`#fs` / `#legacy` 直达）。
> 关联分析：`plans/prd-preview-ux-optimization.md`、`plans/prd-preview-card-ui-overhaul.md`（旧实现形态）。
> 实施仓：`D:\space\base\Polaris-plugin\plugins\interactive-component`（v2.0.0）。

---

## 一、问题与根因（复述，作为验收依据）

聊天卡片的「全屏」由插件 `src/card.tsx` 自绘：`fixed inset-0 z-[9999]` 覆盖层，
`{toolbar}` 却在覆盖层之外的普通流里 → 被完全盖住；覆盖层内只有 iframe + 一行
「按 Esc 退出全屏」文字，**零个可点按钮**。Esc 监听挂在宿主 `window`，而 iframe 是
`srcDoc` + sandbox（无 `allow-same-origin`）的独立 document，焦点落在 iframe 内时
keydown 不冒泡到宿主 → **按钮被盖 + Esc 收不到 = 退不出**。

另：`z-[9999]` 会盖住宿主 TopMenuBar 与 `z-modal` 全局弹窗；组件树内 `fixed` 还会被
react-virtuoso 的 transform item 与 `PluginCardHost` 的 `overflow-hidden` 劫持/裁剪。

旧实现（`ArtifactPreviewRenderer.tsx`，主仓 `dc88f3b5` 已删）恰好相反：`createPortal`
到 body、`top:40px` 保留宿主顶栏、`z-overlay`，覆盖层**内部第一层**是 48px 工具栏，
含醒目红色「退出全屏」按钮，Esc 只是兜底。

---

## 二、目标 / 非目标

**目标**
1. 全屏改为「应用内覆盖层」：`top:40px`，顶部常驻 48px 操作栏，含醒目「退出全屏」。
2. 退出按钮在覆盖层 DOM、iframe 之外 → 焦点在 iframe 内也点得到，根治退不出。
3. 卡片与面板两处全屏形态统一、单源实现，不再分叉。
4. 退出回原位、内嵌 iframe 不卸载（组件交互状态保留）。

**非目标**
- 不做浏览器 / 窗口级真全屏（不调 `requestFullscreen`、`setFullscreen`）。
- 不改宿主任何代码（不加桥、不加 shim 导出、不动 `types.ts`）。
- 不新增功能：不做等比/铺满切换、不加新按钮、不做 iframe 内 Esc 转发（列为可选 P2）。
- 不改 MCP 协议、不改数据格式、不动 `server.js`。

---

## 三、定案方案

### 3.1 归属与所有者

| 项 | 所有者 |
|---|---|
| 全屏状态、覆盖层、操作栏、退出 | **插件**（`interactive-component`），本地 `useState` |
| 宿主 | 仅提供 React shim / 加载壳；**不参与全屏** |
| `panel.supportsFullscreen` | 宿主全仓无消费者（`src/plugin-system/types.ts:107` 仅类型声明）；从插件 `plugin.json` **移除**该声明（语义与自绘覆盖层重叠且冲突）。宿主 `types.ts` 字段保留不动 |

### 3.2 覆盖层形态（对齐原型「方案态」）

| 项 | 定案 |
|---|---|
| 挂载点 | `document.body`（脱离 virtuoso transform item 与 `overflow-hidden`） |
| 几何 | `position: fixed; top: 40px; left/right/bottom: 0`（40px = 宿主 TopMenuBar `h-10`，与旧实现 `TOPBAR_HEIGHT` 一致） |
| 层级 | `style.setProperty('z-index', 'var(--z-overlay, 40)')`；**不用** `z-[9999]`，不压 `z-popover:50` / `z-modal:70` |
| 结构 | `flex flex-col`：第一层 48px 操作栏 `shrink-0`，第二层 `flex-1` 放 iframe |
| 操作栏 | 左：标题 + 版本/来源标识；右：静音 / 复制源码路径（沿用现有）＋ **红色「✕ 退出全屏」主按钮**（样式 A） |
| 底部 | 无提示条（不再以 Esc 文案作为唯一出口） |

样式沿用插件现有 tailwind 主题类（`bg-background` / `border-border` /
`text-text-primary` 等，宿主 CSS 已生成）；仅退出按钮的醒目色用内联 style，
不新增 CSS 文件、不硬编码其他颜色/字号。

### 3.3 关键调整：`createPortal` 不可用 → 原生 DOM 覆盖层

**核实结论**（实施前实证，见 `src/plugin-system/pluginModuleLoader.ts:20-38`、`src/main.tsx:19-20`）：
- 宿主 React shim 只导出 `useState/useEffect/useCallback/useMemo/useRef/memo/
  createElement/Fragment/Component/forwardRef` + jsx runtime，**不含 `createPortal`**；
- 宿主 `window` 未挂 `react-dom`；`tsconfig.json` 的 `types` 也只有 `["react"]`；
- 插件 esbuild 只把 `react` / `react/jsx-runtime` 设为 external，引入 `react-dom` 会被
  打进 bundle 并与宿主 React 实例冲突（shim 是残缺模块，react-dom 内部 API 会崩）。

→ **上一轮方案中的 `createPortal` 在本插件环境不可行**。等效替代：
覆盖层用**原生 DOM**（`document.createElement` + `body.appendChild`）构建，不经 React
渲染。这同样把覆盖层挂到 body、同样规避 transform 劫持，且覆盖层是纯 UI
（一个按钮 + 一个 iframe），无需 React 参与。

**代价**：覆盖层 UI 由原生 DOM 拼装（约 60 行），与卡片其余部分的 JSX 风格不同；
**收益**：宿主零改动成立、无 react-dom 打包/双实例风险、两处全屏共用同一个函数。
若未来宿主把 `createPortal` 纳入 shim（通用契约增强），可平滑替换，本 spec 不预设该路径。

### 3.4 组件契约（单一实现，card / panel 共用）

新增 `src/fullscreen.ts`（纯 TS，无 JSX；`tsconfig` 已覆盖 `src/**/*`）：

```ts
export interface FullscreenOverlayOptions {
  title: string
  meta?: string                                   // 版本 / 「闪造应用」等，拼在标题后
  srcDoc: string
  sandbox: string
  allow: string
  frameBg: string                                 // 'transparent' | '#ffffff'
  actions?: { label: string; onClick: () => void }[]  // 顶部栏次级操作（静音 / 复制路径）
  onClose: () => void                             // 覆盖层内退出 → 回调 React setFullscreen(false)
}
/** 打开覆盖层，返回 close 句柄（供 useEffect cleanup）。重复调用先关旧层。 */
export function openFullscreenOverlay(opts: FullscreenOverlayOptions): () => void
```

- `top: 40px` 与 `z-index: var(--z-overlay, 40)` 为模块内常量，不做配置项（避免投机通用面）。
- 退出样式固定 A；若日后改 B，只换按钮 class，不动契约。
- 覆盖层内的 **iframe 是独立实例**（复用 `buildSrcDoc` / `framePolicy` 的产物）；
  内嵌 iframe 始终保持挂载 → 退出后无重载、交互状态保留。
- Esc：`document.addEventListener('keydown')`，仅在覆盖层打开时挂载，`onClose()` 退出。
  焦点在 iframe 内时仍收不到，**但按钮兜底，不再是唯一出口**（P2 可选：iframe 内
  注入 keydown → postMessage 转发，参照 `plans/browser-f11-panel-fullscreen.md`）。

### 3.5 状态与事件顺序（单源，避免双写）

```
用户点「全屏」 ──► setFullscreen(true)  [React 本地 state]
                     │
   useEffect[fullscreen] ──► openFullscreenOverlay({... onClose})
                     │            └─► 覆盖层 append 到 document.body
                     │                （内嵌 iframe 不卸载）
                     ▼
覆盖层内点「退出全屏」 / Esc（宿主焦点）
                     │
                     ▼  onClose()
              setFullscreen(false)
                     │
   useEffect cleanup ──► close() ──► 覆盖层 remove（含其 iframe）
                     ▼
              内嵌 iframe 始终未卸载 ──► 状态保留、回原位
```

`onClose` 是**唯一**的状态回写路径；覆盖层自身不持有独立 `open` 布尔，避免
React state 与 DOM 出现两份真相。卸载（组件销毁 / 会话切换）走同一 cleanup。

### 3.6 两处统一

- `src/card.tsx`：删除 `:177-191` 的自建 `fixed inset-0 z-[9999]` 分支与
  `:91-98` 的 window Esc 监听；全屏态仅 `useEffect` 调 `openFullscreenOverlay`，
  非全屏态渲染保持不变（内嵌 iframe + 工具栏）。
- `src/panel.tsx`：删除 `:124-141` 自建覆盖层与 `:35-42` Esc 监听，改调同一函数；
  顶部栏「全屏运行」按钮保留。
- 两处共享 `src/fullscreen.ts`，不再各写一套（上次分叉正是「一处有按钮、一处没有」的来源）。

### 3.7 契约澄清

`plugin.json` 的 `contributes.panel` 移除 `supportsFullscreen: true`（当前 `plugin.json:20-23`）。
理由：宿主无消费者；宿主语义「隐藏其他面板、填充工作区」与插件自绘覆盖层重叠/冲突；
留着会误导后续维护。宿主 `src/plugin-system/types.ts` 字段保留（optional，删除无收益）。

---

## 四、改动清单（全部在插件仓）

| 文件 | 动作 |
|---|---|
| `src/fullscreen.ts` | **新增**：原生 DOM 覆盖层单源实现（§3.4 契约） |
| `src/card.tsx` | 全屏分支改用 `openFullscreenOverlay`；删自建覆盖层与 window Esc 监听；保留内嵌 iframe |
| `src/panel.tsx` | 同上，去掉自建覆盖层与 Esc 监听 |
| `plugin.json` | 移除 `contributes.panel.supportsFullscreen` |
| `dist/card.js` / `dist/panel.js` | `pnpm build` 重新 esbuild 产出 |
| `test/run-tests.mjs` | 扩展静态扫描闸：断言 `dist/*.js` **不含** `z-[9999]`、**含** `var(--z-overlay`，且覆盖层退出按钮存在 |

主仓仅新增本 spec 与既有原型 HTML，**无源码改动**。

---

## 五、实施步骤（单主题，一批完成）

1. 新增 `src/fullscreen.ts`，实现 §3.4 契约（含 `onClose` / Esc / cleanup / 重复调用关旧层）。
2. 接入 `card.tsx`、`panel.tsx`；`plugin.json` 去声明。
3. 扩展静态扫描闸用例 → `pnpm test` 红转绿。
4. `pnpm typecheck` + `pnpm build` 重新打包。
5. 真机冒烟（dev 数据根）：聊天卡片全屏、活动栏面板全屏各一轮，按 §六 验收。

---

## 六、验收

1. 点全屏 → 覆盖层出现，顶部 48px 操作栏常驻，宿主 TopMenuBar 仍可见可操作。
2. **焦点在 iframe 内时点「退出全屏」→ 能退出并回原位**（核心，根治退不出）。
3. 退出后 iframe 不重载，组件内输入/交互状态保留。
4. 多会话 / 滚动（virtuoso）下覆盖层定位正确，只放大本卡片；不遮挡全局 Dialog。
5. 卡片与面板两处形态一致；Esc 在宿主焦点时仍可退出。
6. 插件 `typecheck` / `test` / `build` 全绿；静态扫描闸断言成立。
7. 宿主 `main` 无源码改动（`git status` 仅本 spec + 原型 HTML）。

---

## 七、验证命令

```bash
# 插件仓（唯一改动仓）
cd D:/space/base/Polaris-plugin/plugins/interactive-component
pnpm typecheck
pnpm test          # node:test 服务端金标 + card-ssr 渲染冒烟 + 新增静态扫描闸
pnpm build         # typecheck + esbuild 双 entry → dist/card.js / dist/panel.js
```

- 主仓零源码改动 → **不触发** `tsc --noEmit` / `cargo check` / web-only 门控。
- `card-ssr.test.mjs` 走 `renderToString`，`useEffect` 不在 SSR 执行 → 覆盖层逻辑不影响
  现有形态矩阵；仍需实跑确认无回归。
- 真机：dev 数据根安装插件后，AI 对话出一张 `render_component` 卡片 + 活动栏面板，
  各按 §六 走一遍；双端（桌面 / Web）各一轮。

---

## 八、偏差与风险登记（如实）

1. **相对上一轮方案的偏差**：`createPortal` → 原生 DOM 覆盖层。原因见 §3.3
   （宿主 shim 无 `createPortal`、无 react-dom 全局）。等效性：同样挂到 body、
   同样规避 transform 劫持；宿主零改动约束不变。**这一处需要先对齐再实施。**
2. 覆盖层 DOM 由原生 API 拼装，样式类沿用宿主已生成的 tailwind 类；若某类未被
   宿主生成（content 扫描未覆盖插件 dist），退化为内联 style，不新增 CSS 文件。
3. Esc 在 iframe 焦点内仍不可靠 —— 已由退出按钮兜底，不再作为唯一出口；
   iframe 内转发列为 P2，不进本次范围。
4. `top: 40px` 取自宿主 TopMenuBar `h-10`（与旧 `TOPBAR_HEIGHT` 一致）；若 Web 端
   顶栏高度不同，实施时实测校正，不引入跨仓常量。
5. 原型 `plans/interactive-fullscreen-prototype.html` 用 `position:absolute` 模拟
   应用内覆盖层、且未复刻双挂载；**以本 spec 为准，原型仅作形态对照**。
