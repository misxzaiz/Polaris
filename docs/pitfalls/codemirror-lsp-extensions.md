# CodeMirror LSP 扩展挂载踩坑记录

## 症状

打开任意文件后，控制台报错并且编辑器不显示内容、LSP 功能无效：

```
Uncaught (in promise) Error: Unrecognized extension value in extension set ([object Object]).
This sometimes happens because multiple instances of @codemirror/state are loaded,
breaking instanceof checks.
    at createEditor (Editor.tsx:305:33)
```

错误栈指向 `EditorState.create({ doc, extensions })`。一旦抛异常，编辑器视图创建中止，两个表象同时出现：

1. 编辑器里看不到文件内容（view 从未被 new 出来）。
2. LSP 功能无效（扩展根本没被装载到编辑器里）。

## 根本原因（两层）

### 第一层：`@codemirror/state` 双实例（已先解决）

错误信息虽然提示"多份 state 实例导致 instanceof 失败"，这是一个**通用的兜底提示**，只要 `Facet` / `StateField` 等的 `instanceof` 校验不过就会报这句话，**不代表真的有两份 state**。

历史上我们确实遇到过 Vite 预打包带来的双实例问题，现在的 `vite.config.ts` 固定做了：

- `resolve.dedupe` 列出所有 `@codemirror/*`、`@lezer/*` 包，强制整树只解析到一份。
- `optimizeDeps.include` 把编辑器和 `@codemirror/lsp-client` 一起塞进同一次 esbuild 预打包，保证它们共享同一份 state chunk。

验证办法：查看 `node_modules/.vite/deps/@codemirror_state.js` 与 `@codemirror_lsp-client.js`，它们必须从**同一个** `chunk-XXXXX.js` 导入 state 的内部符号。

### 第二层：`languageServerExtensions()` 用错位置（这次真凶）

`@codemirror/lsp-client` 的类型签名：

```ts
declare function languageServerExtensions(): readonly (Extension | LSPClientExtension)[];

type LSPClientExtension = {
  clientCapabilities?: Record<string, any>;
  notificationHandlers?: { [method: string]: (client, params) => boolean };
  // ...
};

type LSPClientConfig = {
  rootUri?: string;
  timeout?: number;
  extensions?: readonly (Extension | LSPClientExtension)[];
  // ...
};

declare function languageServerSupport(
  client: LSPClient,
  uri: string,
  languageID?: string,
): Extension;
```

关键：**`languageServerExtensions()` 的返回值是给 `new LSPClient({ extensions })` 用的客户端级配置**（里面混着 `LSPClientExtension` 这种配置对象，不是 CodeMirror Extension），**不能直接塞进 `EditorState.create({ extensions })`**。

之前 `lspStore.ts` 里这样写：

```ts
return [
  ...languageServerExtensions() as Extension[], // 强转掩盖了类型错误
  client.plugin(uri) as Extension,
];
```

运行时 state 遇到 `{ clientCapabilities: ... }` 这种对象，既不是 `Facet`、也不是 `StateField`、也没有 `.extension` 字段，就抛 `Unrecognized extension value`。

## 正确做法

`@codemirror/lsp-client` 提供两个"全家桶" helper，它们**大面积重叠**，是**二选一**的关系，不能同时使用：

| helper | 位置 | 内容 |
|---|---|---|
| `languageServerExtensions()` | 传给 `new LSPClient({ extensions })` | `serverCompletion()` + `hoverTooltips()` + `signatureHelp()` + 相关 keymap + `serverDiagnostics()` |
| `languageServerSupport(client, uri, languageID)` | 传给 `EditorState.create({ extensions })` | `LSPPlugin.create(...)` + `serverCompletion()` + `hoverTooltips()` + `signatureHelp()` + 相关 keymap（**不含 `serverDiagnostics`**） |

**两个同时挂会导致 hover / 补全 / 签名帮助重复显示**（悬浮提示看起来连着出现两份）。

本项目选"方案 B"——诊断在 client 层注册，其它编辑器扩展走 `languageServerSupport`：

```ts
// 构造 client 时：只放 LSPClientExtension 配置对象
const client = new LSPClient({
  rootUri,
  timeout: 5000,
  extensions: [serverDiagnostics()], // ✅ 只加诊断，必须在 client 级
}).connect(transport);

// 给 EditorState 提供扩展时
function getExtensionsForClient(
  client: LSPClient,
  filePath: string,
  languageID?: string,
): Extension[] {
  const uri = pathToUri(filePath);
  return [languageServerSupport(client, uri, languageID)]; // ✅ 编辑器侧
}
```

等价的"方案 A"：`new LSPClient({ extensions: languageServerExtensions() })`，编辑器侧只加 `client.plugin(uri, languageID)`。两种都可以，但**不能混用**。

## 诊断小抄

遇到 `Unrecognized extension value in extension set`，按下列顺序排查：

1. **检查是不是传了配置对象给 EditorState**：先查自己代码里所有 `EditorState.create` / `Compartment.reconfigure` / `view.dispatch({ effects })` 的扩展来源，看有没有把某个库的"配置对象"误当成了 `Extension`。`@codemirror/lsp-client` 的 `languageServerExtensions()`、某些三方库的配置 helper 都是这种坑。强转 `as Extension[]` 的地方要格外怀疑。
2. **再看是不是真有两份 state**：在 `node_modules/.vite/deps/_metadata.json` 里确认 `@codemirror/state` 是顶级条目；看 `@codemirror_<xxx>.js` 都从同一个 state chunk 导入；必要时在 `vite.config.ts` 里加 `resolve.dedupe`，并在 `optimizeDeps.include` 把相关 CM 包一起预打包。修改后一定要 `rm -rf node_modules/.vite` 并以 `--force` 重启 Vite。
3. **开发环境下临时打印**：把要传给 `EditorState.create` 的 `extensions` 数组 `console.log` 一下，逐项看哪个不是 `Facet` / `StateField` / 嵌套数组。

## 相关文件

- `src/stores/lspStore.ts` — LSP client 创建与扩展构造。
- `src/components/Editor/Editor.tsx` — 编辑器挂载、调用 `activateForFile`。
- `vite.config.ts` — `resolve.dedupe`、`optimizeDeps.include` 保证 CM 单实例。
