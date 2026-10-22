# AI 输出 HTML 自动卡片渲染 — 需求开发文档（Spec）
> 四段式：目标 / 现状（已验证）/ 契约 / 验收与不做。
> 关联原型：`temp/html-output-prototype/`（index.html + server.js，端口 9826，已端到端验证通过）。
> 关联需求：`plans/radio-broadcast-infinite-listening-prd.html`（该原型用于验证其「AI 输出 HTML → 卡片渲染」链路）。
> 本文档供实施 agent 直接分析落地，不要求重读原型源码（关键实现已内联）。

---

## 一、目标

### 1.1 定位
AI 会话输出**完整自包含 HTML**（图表、看板、介绍页等）时，自动检测并渲染为**可交互卡片**：
- 卡片内嵌在会话消息流中，头部含来源标题 + `HTML` 标识 + 全屏按钮；
- 卡片内容在**沙箱 iframe** 内运行（脚本可跑、交互可用，但隔离页面环境、禁外部资源）；
- 纯文字/markdown 回复保持文本渲染，**绝不误判为卡片**；
- 流式生成过程实时检测，切「AI 正在生成 HTML 卡片…」占位，完成后替换为卡片。

### 1.2 场景
- 用户说「做一张本周收听周报卡片 / 可视化页面 / 好看的介绍页」→ AI 输出 HTML → 自动变卡片。
- 卡片内交互（按钮、点击计数、切换 tab）在沙箱内正常工作。
- 手机端可全屏查看卡片。

### 1.3 北极星验收一句话
**「AI 输出完整 HTML 文档 → 无感变成可交互卡片；纯文字永不误判。」**

---

## 二、现状与已验证结论（原型勘察）

### 2.1 链路（原型已跑通）
```
用户输入 → POST /api/chat（OpenAI 兼容 SSE 流式，后端 9826 代理转发）
  → onDelta 逐块累积 + 实时检测 HTML 开头（isHtmlOpening）
      ├─ 是 → body 切占位「AI 正在生成 HTML 卡片…」（spinner）
      └─ 否 → miniMd(累积文本) 流式渲染 + caret
  → onEnd 提取完整 HTML（extractHtmlCandidate）
      ├─ 有 → renderCard(body, html, title) + state.messages.push({kind:'card', html})
      └─ 无 → miniMd 最终渲染 + push({kind:'text'})
```

### 2.2 关键实现（可直接复用）

**HTML 检测三件套**（`index.html` 325-340 行）：
```js
function isCompleteHtmlDoc(text) {
  const t = text.trimStart();
  const opens = /^(<!doctype\s+html|<html[\s>])/i.test(t);
  if (!opens) return false;
  return /<\/html>\s*$/i.test(t);
}
function isHtmlOpening(text) {           // 流式中途：只要开头命中即判定进入卡片模式
  const t = text.trimStart();
  return /^(<!doctype\s+html|<html[\s>])/i.test(t);
}
/** 优先取 ```html 围栏，其次整体判定 */
function extractHtmlCandidate(text) {
  const fenceMatch = text.match(/```(?:html)?\s*\n?([\s\S]*?)\n?```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  return isCompleteHtmlDoc(candidate) ? candidate : null;
}
```

**流式防误判**：`stripFence(t)` 把已出现但未闭合的 ```html 前缀剥掉后再判开头，避免「先说话再给代码」时假阳性（442-445 行）。

**标题提取**：`guessTitle(text)` 取 `<title>` 内容，缺省 'HTML 卡片'（446-449 行）。

**卡片渲染**（343-359 行）：
```js
function renderCard(body, html, title) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <header>
      <span class="ic">✓</span>
      <span class="t">${title}</span>
      <span class="tag">HTML</span>
      <button class="act" onclick="openFs(this)" title="全屏">⛶</button>
    </header>
    <iframe sandbox="allow-scripts allow-forms allow-popups allow-modals" srcdoc=""></iframe>`;
  card.querySelector('iframe').srcdoc = html;
  card.querySelector('.act').dataset.title = title;
  body.appendChild(card);
}
```

**全屏**（360-367 行）：`openFs(btn)` 把 iframe 的 srcdoc 拷入全屏弹层 `<iframe id="fsFrame">`，`closeFs()` 清空。沙箱属性与卡片一致。

**消息模型**：`state.messages[]` 每条 `{ role, content, kind: 'text'|'card', html? }`。

**SSE 客户端**（467 行起）：fetch POST → getReader 逐块解码 → 按 `\n` 拆行 → 只认 `data:` 前缀 → JSON.parse → 取 `choices[0].delta.content` → `data: [DONE]` 结束。兼容 OpenAI 流式协议。

**后端代理**（`server.js`）：`/api/chat` 把 `{baseUrl, apiKey, model, messages, system, temperature, maxTokens}` 转发到 `{baseUrl}/chat/completions`（stream:true，Bearer 认证），SSE 透传。解决浏览器直连 CORS + key 泄露；监听 0.0.0.0 供手机访问。

### 2.3 本次已验证的修复（必须带入实施）
`miniMd` 轻量 markdown 渲染器原有一条**破坏性正则**（会把所有非 HTML 标签开头的行删成空串），导致**纯文字消息渲染为空**。已删除该行并回归通过：

| 输入 | 修复前 | 修复后 |
|---|---|---|
| 纯文本一行 | `""` | `<p>你好，这是一段纯文字</p>` |
| 多行/段落 | `""` | `<p>…</p>\n<p>…</p>` |
| 粗体/列表/引用/链接/代码围栏/分隔线 | 正常 | 正常（未回归） |
| 含 `<br>` 文本 | — | `&lt;br&gt;` 正确转义，不误判 |

⚠️ **遗留隐患（本次未动，建议一并修）**：`miniMd` 表格分支的 `filter((_, i, arr) => !(i === 0 && arr.length > 1 && !c.trim() && true))` 引用了回调外的 `c`，在 Node 引擎下抛 `ReferenceError`（浏览器因短路不触发）。表格渲染依赖此分支，建议改为 `filter(Boolean)` 并修复头部分隔行判定。

---

## 三、契约（落地到 Polaris 正式产品时）

### 3.1 检测层（纯函数，无 DOM 依赖，建议独立模块 `htmlCardDetect.ts`）
- `isHtmlOpening(text): boolean` — 流式中途判定（trimStart 后 `/^(<!doctype\s+html|<html[\s>])/i`）。
- `isCompleteHtmlDoc(text): boolean` — 完整判定（开头命中 + `</html>\s*$`）。
- `extractHtmlCandidate(text): string | null` — 围栏优先（```html 或 ``` 均可），整体回退；两者都过 `isCompleteHtmlDoc` 才返回。
- `stripFence(text): string` — 剥掉未闭合围栏前缀，防流式假阳性。
- `guessTitle(text): string` — `<title>` 提取，缺省 'HTML 卡片'。

### 3.2 渲染层（组件 `HtmlCardView`）
- 头部：`✓ 图标 + 标题 + HTML 标签 + 全屏按钮（⛶）`。
- iframe 沙箱**固定**：`sandbox="allow-scripts allow-forms allow-popups allow-modals"`（禁 allow-same-origin，防逃逸；禁外部资源由 srcdoc 自包含保证）。
- `iframe.srcdoc = html`（不落临时文件、无 XSS 面）。
- 全屏：独立弹层 iframe，srcDoc 拷贝，关闭即清空。
- 失败兜底：srcdoc 空/渲染异常 → 降级为代码块展示（可加）。

### 3.3 消息层
- 消息扩展 `kind: 'text' | 'card'`，card 消息携带 `html` 原文。
- 流式过程：`streaming && htmlOpening` → 占位态；`onEnd` 才落定 kind。
- 历史回显：会话恢复时按 `kind` 重建（card → 重新 renderCard，text → miniMd）。

### 3.4 安全边界（本次不实现，靠 sandbox 兜底）
- 不做 HTML 白名单/消毒引擎：沙箱内脚本默认可信（AI 生成内容），`allow-scripts` 放行交互，`allow-same-origin` 不放行即与主页面隔离。
- 禁外部资源：srcdoc 内 `src/href` 指向外网的资源在沙箱无 `allow-same-origin` 下仍可尝试加载——**验收要求**：提示词约束 AI 输出完全自包含（无外部 CSS/JS/图片），并可在 iframe 加 CSP `default-src 'unsafe-inline' data:;` 兜底。

---

## 四、验收标准

### 4.1 必过用例（浏览器端到端）
1. 纯文字回复 → 正常文本渲染，`kind='text'`，**无卡片、无全屏按钮**。
2. 「做一张卡片」→ 流式过程出现「AI 正在生成 HTML 卡片…」占位 → 完成后变卡片（`kind='card'` + `html` 原文）。
3. 卡片内交互可用（点击按钮计数/切换）。
4. ⛶ 全屏弹出，内容与卡片一致，可关闭。
5. ```html 围栏包裹的完整 HTML → 正确提取渲染。
6. 含 `<br>`、`<script>` 字样但**非完整 HTML** 的文本 → 仍为 text（不误判）。

### 4.2 回归用例（miniMd）
7. 纯文本一行/多行/空行分段 → 全部渲染可见（防 2.3 bug 回归）。
8. 粗体/列表/引用/链接/代码围栏/分隔线/表格 → 正常。
9. HTML 特殊字符转义正确（`& < > " '`）。

### 4.3 安全用例
10. 卡片内脚本尝试 `window.top.location` / 访问主页面 DOM → 被沙箱隔离（无 allow-same-origin）。
11. 卡片引用外部 `https://` 资源 → 不生效或被 CSP 拦截（提示词约束 + 可选 CSP 兜底）。

---

## 五、不做（边界）
- 不做 HTML 模板库 / 卡片分类管理。
- 不做卡片截图预览 / 下载导出。
- 不做 HTML 内容白名单校验引擎（第一版靠沙箱 + CSP + 提示词约束）。
- 不做卡片内 JS 错误上报 / 性能监控。
- 不改动既有纯文本消息历史（旧消息无 kind 时按 text 渲染）。
