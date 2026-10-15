# 修复：设置面板关闭时"闪一下"（退场动画无 forwards）

> 状态：已修复 · 归属：前端 · 类型：bugfix
> 关联：`src/App.tsx` 退场时序、`tailwind.config.js` 动画 token

## 问题现象

手机 App 端（`polaris-mobile`，复用完整 Web App）关闭设置面板时会闪一下。

## 根因

`App.tsx:405-420` 关闭设置时进入退场流程：

1. `showSettings=false`，`settingsKept=true` 保留渲染 200ms；
2. 容器切到 `animate-panel-out`（淡出 140ms）；
3. 动画播完后元素样式回落（无 `animation-fill-mode: forwards`），
   `opacity` 从关键帧 100% 状态回到动画前 `opacity:1`；
4. 但 DOM 要等到 200ms 才卸载——中间约 60ms 窗口内，
   已淡出的全屏设置面板"瞬回不透明再消失"，即用户看到的"闪一下"。

同类缺陷还存在于 `dialog-out` / `mask-out` / `drawer-out-*` / `capsule-out`
（`LeftPanel.tsx:67` 注释已记录过一次同问题：遮罩无 forwards 播完回弹全黑）。

## 修复

`tailwind.config.js`：给全部退场动画 token 追加 `forwards`：

- `panel-out` / `dialog-out` / `mask-out` / `drawer-out-left`
- `drawer-out-right` / `drawer-out-bottom` / `capsule-out`

`forwards` 让动画播完保持 100% 关键帧（透明/移出状态），直到组件卸载，
消除"动画结束 → 卸载"窗口内的样式回落闪烁。

## 验收

- [x] `pnpm run build` 产物 CSS 中 3 个在用退场动画均含 `forwards`
      （`dialog-out` / `mask-out` / `panel-out`）
- [x] `pnpm exec tsc --noEmit` 通过
- [x] `eslint tailwind.config.js` 通过
- [ ] 手机端重打包 APK 后确认关闭设置不再闪