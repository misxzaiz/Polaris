# pet-overlay spike：桌面悬浮宠物窗（R1，方案 v2 · 11.4/11.5）

> ⚠️ **本文为 R1 spike 决策归档，实态已远超原 spec。**
> 当前权威规格见 [`pet-overlay-r2-spec.md`](./pet-overlay-r2-spec.md)（v0.5.0 实态对齐 + 模块化拆分蓝图）。
> 本文件保留作为 R1 去留决策的历史记录，不再作为功能边界依据。

> 目标：用最小宿主改动验证「ds大肥鱼以透明置顶小窗活在桌面上」是否成立，
> 为 R2（AI 联动）打通悬浮页事件通道预研。1 天 spike，产出「去留 + 路径」决策。
> 背景与验收清单：`Polaris-plugin/docs/pet-host-framework-plan.md` §11。

## 所有者与边界

- **悬浮窗生命周期所有者**：宿主前端 `src/petOverlay/OverlayApp.tsx`（页面内自管理：
  资源加载 / 拖拽 / 位置记忆 / 关闭）+ `src/main.tsx` 桥（开窗）。
- **不做**：不改任何 Rust 命令层（零 Rust 改动）；不做 AI 联动本体（R2）；
  不做多宠物；不动插件面板既有渲染逻辑。

## 接口

1. **capabilities**（`src-tauri/capabilities/default.json`）：
   - `webviews` 追加 `"pet-overlay"`（继承既有窗口操作权限：start-dragging /
     set-position / close / always-on-top 等，悬浮岛同款集合）；
   - `permissions` 追加 `core:webview:allow-create-webview-window`（主 webview 建窗口子）。
2. **桥**（`src/main.tsx`）：`window.__POLARIS_PET_OVERLAY__ = { open, close }`，
   经 `@tauri-apps/api/webviewWindow#WebviewWindow` 创建固定配置窗口：
   label 固定 `pet-overlay`、transparent、decorations:false、alwaysOnTop、
   skipTaskbar、resizable:false、shadow:false、center。面板无法注入任意参数
   （对比 16 命令白名单的安全面：新增的是「仅这一个固定窗口」的通道）。
   纯 Web / 移动环境经 `__TAURI_INTERNALS__` 探测不存在，桥不暴露。
3. **启动分支**（`src/main.tsx`）：`?petOverlay=1` → 动态 import 悬浮页
   （不进主 bundle），其余环境渲染既有 `RootApp` 不变。
4. **悬浮页**（`src/petOverlay/OverlayApp.tsx`）：经 `plugin_service_list` 解析
   whale-pet 服务端口 → 直连 `localhost:<port>/asset/webm/...`（v0.3.3 direct
   通道同款）→ idle 循环 + 点击回应；拖拽 `startDragging()`（>6px 位移阈值区分
   点击）；位置记忆走 `cap.kv`（key `whale-pet.overlay.pos`，物理像素，onMoved
   防抖保存 / 启动还原）；悬停 ✕ 关闭。事件通道预研：`listen('chat-event')`
   计数显示（R2 的 AI 联动走同一通道）。

## 时序

```
面板按钮 → __POLARIS_PET_OVERLAY__.open()
  → WebviewWindow('pet-overlay', url=index.html?petOverlay=1)
  → main.tsx 启动分支（动态 import）→ OverlayApp
  → plugin_service_list 取端口 → direct 通道加载 idle webm → 循环播放
  → 拖拽（OS 级 startDragging）→ onMoved → cap.kv 记忆
  → 关闭（✕ → window.close()）
```

## 验收（= 方案 v2 §11.5 spike 清单的可自动验证部分）

- [ ] 悬浮窗透明无边框置顶，待机 webm 播放无黑底/白框
- [ ] 拖拽顺滑；重启 Polaris 后位置还原
- [ ] 点击播放随机回应动画后回 idle
- [ ] 主窗最小化后悬浮窗独立存活（用户观察）
- [ ] `chat-event` 事件在悬浮窗内可收到（R2 预研）
- [ ] 门槛：`pnpm exec tsc --noEmit` + `pnpm lint` + `cargo check`
      （capabilities 由 tauri-build 校验合法性）零新增告警

## 风险与回退

- **透明渲染**：WebView2 支持，若出白底 → 检查 html/body 透明 + shadow:false；
  仍失败则 spike 判负，回退面板形态（插件侧不受影响）。
- **建窗权限面**：`create-webview-window` 授予主 webview 后，同源的插件面板代码
  理论上可复用任意 JS——桥固定了 label/尺寸/标志位，且面板本就同源非沙箱
  （既有事实），攻击面无增量。
- **webm 音轨自动播放策略**：spike 统一 muted，声音开关留 R2。
