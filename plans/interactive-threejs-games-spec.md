# spec：交互面板支持 Three.js 三维展示与小游戏

> 2026-11-10 · 状态：POC 已验证，待拍板实施
> 插件：Polaris-plugin/plugins/interactive-component（v2.0.0）
> 关联：plans/interactive-panel-fullscreen-spec.md（v2 全屏）、compact-handoff-plugin-extraction-verdict（v2 定案）

## 0. 结论（先答问题）

**能支持，且改动极小——纯插件侧改动，宿主零改动。**

iframe 沙箱（不透明 origin、`allow-scripts` 无 `allow-same-origin`）**不阻断** WebGL/游戏所需的任何能力。全部关键能力已在真实 Chromium 实测通过（证据见 §3）。

## 1. 现状链路（为什么 AI 现在写不了 three.js）

- AI 经 MCP `render_component` 传**单个自包含 HTML 字符串**（≤2MB），卡片段 `chatCards` 用 React `srcDoc` prop 渲进沙箱 iframe（`src/card.tsx`）；策略档位在 `src/shared.ts::framePolicy`（inline 档：`allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock` + `allow="autoplay"`）。
- **痛点**：three.js minify 后 ~660-820KB，AI 既不可能手写内联，静态扫描闸（`mcp/server.js::BLOCK_RULES`）又禁止 `fetch`/动态 `import()`——AI 唯一能走的路（CDN `<script src>`）与插件「不联网」设计红线冲突，且模块版 three 需要静态 `import ... from 'https://...'`，同样违背离线原则。
- 关键有利事实：**宿主 `tauri.conf.json` `csp: null`**——srcdoc iframe 不继承任何 CSP，内联脚本无障碍。

## 2. 方案：插件侧 vendored lib 注入（`libs` 参数）

### 2.1 构建期
- 插件 `package.json` devDependencies 加 `three`；build 脚本追加一步 esbuild：
  `src/vendor-three.ts`（`import * as THREE from 'three'` + OrbitControls/GLTFLoader 等 addons，挂 `window.THREE` / `window.THREE_ADDONS`）→ `--bundle --format=iife --minify` → `dist/vendor/three.iife.js`（实测 818KB，含 OrbitControls+GLTFLoader）。
- IIFE 格式保证无 `import(`，静态扫描闸永不误伤；更新 three 只需重跑构建。

### 2.2 MCP 侧（mcp/server.js）
- `render_component`/`preview_html` schema 增加可选参数 `libs?: string[]`（枚举白名单：`'three'`，后续可扩 babylon 等）。
- 执行序调整：`validateHtmlSize(html)`（用户 HTML 维持 2MB）→ `scanHtml(html)`（**只扫用户 HTML**，lib 内含 fetch 实现，合并扫描必误伤）→ 从插件目录读 `dist/vendor/three.iife.js` 内联为 `<script>` 前置于用户 HTML → 落盘 `index.html`。
- `metadata.json` 记 `libs` 字段（审计与 read_preview 还原用）。
- **MAX_HTML_BYTES 调整**：`read_preview` 对落盘产物（lib+用户代码）校验上限提到 4MB；用户输入仍 2MB。否则 lib 注入后 read_preview 会被自己的 2MB 闸误拒。
- AI 提示词引导（工具 description 更新）：三维场景用 `libs:["three"]`，代码用全局 `THREE`/`THREE_ADDONS`，不写 import、不引 CDN；模型/贴图走 base64 DataURL（GLTFLoader 原生支持）。

### 2.3 前端（card/panel）
- **零改动**。lib 已内联进 html，卡片/全屏覆盖层/应用架/主题注入照常工作。
- 唯一注意：artifact html 带 lib 后单条会话消息体积增大 ~820KB（JSONL 会话存储），可接受；v2 优化方向（非本次）：卡片级注入避免落盘重复。

### 2.4 版本与发布
- 插件版本 v2.1.0；`update.json` 同步；跑 `pnpm --dir plugins/interactive-component test`（tools/list 断言 `length===4` 不受 schema 加参影响）+ `typecheck` + SSR 测试。
- 插件 zip 体积 +~820KB（CDN 限 50MB，无虞）。

## 3. 实测证据（2026-11-10，真实 Chromium）

POC：esbuild 打包 three 0.187 IIFE（818KB）内联进与 `framePolicy('inline')` 完全一致的沙箱 srcdoc iframe（`allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock` + `allow="autoplay"` + no-referrer）。POC 产物：`%TEMP%\polaris-three-poc`。

| 能力 | 结果 | 证据 |
|---|---|---|
| WebGL2 上下文 | ✅ | `WebGL 2.0 (OpenGL ES 3.0 Chromium)` |
| three.js 场景渲染 | ✅ | IAB 截图（光照立方体+地面）；canvas toDataURL 25966B（空白画布仅 ~4-8KB）|
| rAF 游戏循环 | ✅ | 63fps（95帧/1.5s）；IAB 53fps |
| OrbitControls 拖拽 | ✅ | IAB 拖拽后相机视角实际变化（截图对比）|
| **键盘进沙箱 iframe** | ✅ | **OS 级真实按键**（PowerShell SendKeys）keydown/keyup 对全部到达 iframe（`e.code` 空为合成输入特征，真硬件键盘带 KeyW）|
| **Pointer Lock** | ✅ | 真实鼠标点击（user32 坐标点击）→ click-to-lock → `pointerlockchange: locked` |
| AudioContext | ✅ | IAB `state=running`；默认浏览器 `suspended`→点击手势后恢复（标准 autoplay 策略）|
| postMessage 沙箱→宿主 | ✅ | 全部探针经 `window.parent.postMessage` 回传成功 |
| localStorage/indexedDB | ❌ | `SecurityError`（不透明 origin 固有，见 §4）|

## 4. 能力边界（如实交代）

1. **无持久化**：不透明 origin 下 localStorage/indexedDB/cookie 全部 SecurityError。游戏进度/设置只能存内存；如需持久化，后续可用 postMessage→卡片内存档或走 cap.kv（需恢复宿主桥，属 v2+ 选项）。
2. **体积预算**：用户 HTML 2MB（含 base64 模型/贴图）。中小场景 OK；大模型需压缩/减面。
3. **性能**：WebView2 桌面端 60fps 无压力；移动端（polaris-mobile WebView）GPU 侏儒级设备未测，不承诺。
4. **静态扫描缺口（顺带发现，与本特性无关）**：BLOCK_RULES 不拦 `<script src="https://...">` 外链——AI 仍可写 CDN script 绕过「不联网」意图。建议本次顺手补一条 `/<script[^>]+src=/`（排除 data:）规则。
5. **音频**：首次播放需用户手势（点击场景即满足）；卡片静音协议 `__polarisMute` 照常可用。
6. **iframe 内页面全屏 API**：未加 `allow="fullscreen"` 权限令牌，游戏内 requestFullscreen 不可用；全屏统一走卡片工具栏（已实现，体验更统一）。

## 5. 验收（实施后）

1. AI 侧冒烟：对 zcode 引擎说「用 render_component libs:["three"] 做一个可拖拽旋转的三维地球」→ 卡片渲染出可交互 3D 场景，全屏/静音/展开正常。
2. 游戏冒烟：生成 WASD+鼠标视角小游戏 → 键盘移动、指针锁生效、Esc 退出锁定。
3. 回归：`interactive-component` 全部现有测试绿；无 libs 参数的旧调用行为不变（libs 缺省 = 注入零字节）。
4. 静态闸：含 fetch 的用户 HTML 仍被拒；lib 注入产物 read_preview 正常返回。
