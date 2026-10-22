# HTML 卡片 Cap 桥 — 需求开发文档（Spec）

> 四段式：目标 / 现状（已验证）/ 契约 / 验收与不做。
> 关联实现：`plans/html-output-card-render-spec.md`（卡片检测/渲染/消息层契约）。
> 本文档供实施 agent 直接分析落地，不要求重读原型源码（关键实现已内联）。

---

## 一、目标

**让 HTML 卡片（`ArtifactPreviewRenderer` 沙箱 iframe）内的脚本，能经宿主调用 Polarist 的 cap 能力**（如 `cap.todo`、`cap.kv` 等），并把结果弹回卡片内继续渲染。

典型场景：
- 卡片内含「刷新待办」按钮 → 点一下 → 宿主经 RouterBus 取 `cap.todo list` → 结果回卡片 → 卡片内 JS 渲染列表。
- 卡片内按钮执行 `cap.kv get/set` 等轻量数据操作。

### 北极星验收一句话
**卡片里的 JS 写一行 `polarisCap.dispatch('cap.todo', { action:'list', scope:'all' })` 就能拿到结果；未声明的目标 / 异常一律安全失败，不泄漏、不逃逸。**

---

## 二、现状（已验证）

1. **卡片渲染链路已成立**：`session_end` → `extractHtmlCardBlocks`（`src/stores/conversationStore/eventHandler.ts:106`）→ 替换为 `artifact_preview` 块（`inlineToBody: true`）→ `ArtifactPreviewRenderer`（`src/components/Chat/chatBlocks/ArtifactPreviewRenderer.tsx`）渲染。
2. **iframe 沙箱**：`sandbox="allow-scripts allow-forms allow-popups allow-modals"`（`:205`），**无 `allow-same-origin`** → 卡片是跨源文档，**无法用同源方式访问宿主**；但 `postMessage` 跨源双向可达（浏览器内置）。
3. **宿主目前不监听卡片 `postMessage`**：无桥 → 卡片内无法触达任何后端能力。
4. **统一调用通道已就绪**：前端 `src/services/transport/index.ts` 的 `invoke`（Tauri IPC / HTTP 自适应），`router_dispatch` 信封形态 `{ req:{ target, payload } } → { ok, result, error, msgId, trace }`（见 `src/services/aiChatDispatch.ts:10-17`）。
5. **RouterBus 是唯一权限/审计通道**：cap 能力列表见 `src-tauri/src/services/router/`（`cap.todo` / `cap.kv` / `cap.fs` / `cap.config` 等）。`cap.todo list` 返回 `{ items: TodoItem[] }`（`todo_capability.rs:175`）。

---

## 三、契约

### 3.1 消息协议（`postMessage`，双向往返）

卡片 → 宿主请求（`window.parent.postMessage`）：
```jsonc
{
  "__polarisCap": 1,           // 协议版本，防串扰
  "id": "card-<uuid>",         // 请求 id，宿主原样带回
  "target": "cap.todo",        // 目标能力 id（白名单外拒绝）
  "payload": { "action": "list", "scope": "all" }
}
```

宿主 → 卡片响应（iframe 内 `window.addEventListener('message')`）：
```jsonc
{
  "__polarisCap": 1,
  "id": "card-<uuid>",
  "ok": true,
  "result": { "items": [] },   // 成功：RouterBus 的 result
  "error": null
}
```
失败：
```jsonc
{ "__polarisCap": 1, "id": "...", "ok": false, "result": null, "error": "cap.todo list 失败: ..." }
```

### 3.2 宿主桥（`ArtifactPreviewRenderer` 内 `useEffect` 挂 `window.message` 监听）

- **只响应 `event.source` 是当前卡片的 iframe**（`event.source === previewFrameRef.current?.contentWindow`），且 `data.__polarisCap === 1` 的请求。
- **白名单校验**：仅放行声明列表内的 `target`（默认 `cap.todo`、`cap.kv`；可扩展）。白名单外 → 回 `ok:false`，**不转发**。
- **统一转发**：`invoke('router_dispatch', { req:{ target, payload } })` → 解析信封 → 回卡片。
- **错误兜底**：`invoke` 抛错 / 信封 `ok:false` → 回 `ok:false + error`；卡片侧 8s 超时自行超时提示。
- **清理**：组件卸载移除监听。
- **全屏 Portal 复用同一份 `previewFrame` jsx**（同一个 iframe 引用），监听在组件级 → 全屏态天然可调，无需额外处理。

### 3.3 卡片侧 SDK（内部 `src/utils/polarisHtmlCardBridge.ts`）

- `postMessage` 请求 + 按 `id` resolve 的 pending map + 8s 超时。
- 导出供演示卡片内联（同文件内附内联实现注释；不发布 npm）。

---

## 四、验收标准

1. 卡片内 `polarisCap.dispatch('cap.todo', { action:'list', scope:'all' })` → 返回 `{ items: TodoItem[] }`，卡片渲染列表。
2. 白名单外 target（如 `cap.config` / 任意字符串）→ 回 `ok:false`，**不调用后端**（无审计副作用）。
3. 请求无 `id` / 非本 iframe source / 协议版本不对 → 宿主忽略不响应。
4. 后端失败（如 `cap.todo get` 不存在 id）→ 卡片收到 `ok:false + error`，不抛未捕获异常。
5. 卡片卸载后（离开会话/重渲染）不再响应；无内存泄漏（监听移除）。
6. 历史恢复、全屏态：桥仍可用。

---

## 五、不做（边界）

- **不做通用 eval / 任意代码注入**：卡片内只能发「白名单 cap 调用」，不能拿宿主任意执行。
- **不放行 `allow-same-origin`**：保持沙箱隔离（主页面 DOM 不可达），桥只走 postMessage 白名单。
- **不做跨卡片共享状态 / 事件订阅**：仅请求-响应。
- **不做后端能力注册表动态同步**：白名单静态扩展（新增 target 需改一端常量）。
- **不改卡片检测/消息层协议**：仍走 `extractHtmlCandidate`。
- **不发布卡片侧 SDK 为公共 npm 包**：内联到演示卡片即可。