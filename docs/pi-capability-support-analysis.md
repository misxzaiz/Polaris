# Pi Agent 能力扩展方案分析

## 背景

Pi（pi-coding-agent）原生仅提供 4 个内置工具：

| 工具 | 功能 |
|------|------|
| `read` | 读取文件 |
| `bash` | 执行命令 |
| `edit` | 精确编辑 |
| `write` | 创建/覆盖文件 |

**不支持：** MCP 原生协议、浏览器自动化、电脑操作、网络搜索等。

**Polaris 项目** 已实现了完善的 MCP 能力，包括浏览器和电脑操作，可通过扩展 Pi 来复用这些能力。

---

## 方案一：Pi Extension 桥接 Polaris MCP（推荐 ⭐⭐⭐⭐⭐）

### 原理

编写一个 Pi TypeScript Extension，通过 **stdio JSON-RPC 2.0** 调用 Polaris 已启动的 MCP Server（`polaris-browser-mcp`、`polaris-computer-mcp` 等），将其能力暴露为 Pi 的自定义工具。

### 架构

```
┌─────────────────────────────────────────────────┐
│ Pi Agent                                        │
│  ┌───────────────────────────────────────────┐  │
│  │ polaris-mcp-bridge Extension              │  │
│  │  → registerTool("browser_navigate")       │  │
│  │  → registerTool("browser_click")          │  │
│  │  → registerTool("screenshot")             │  │
│  │  → registerTool("click")                  │  │
│  │  → ...                                    │  │
│  └──────────────┬────────────────────────────┘  │
└─────────────────┼────────────────────────────────┘
                  │ stdio JSON-RPC 2.0
                  ▼
┌─────────────────────────────────────────────────┐
│ Polaris MCP Server                              │
│  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ browser-mcp     │  │ computer-mcp         │  │
│  │ → browser_list  │  │ → screenshot         │  │
│  │ → browser_acquire│  │ → click / drag      │  │
│  │ → browser_navigate│  │ → type_text / press_key│
│  │ → browser_click  │  │ → inspect_ui        │  │
│  │ → browser_fill   │  │ → list_windows      │  │
│  │ → browser_context │  │ → clipboard         │  │
│  └─────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 扩展结构

```
~/.pi/agent/extensions/polaris-mcp-bridge/
├── package.json            # 依赖声明
├── src/
│   └── index.ts            # 入口：注册工具 + 生命周期管理
├── tools/
│   ├── browser.ts           # 浏览器工具集
│   └── computer.ts          # 电脑操作工具集
└── README.md
```

### 核心实现逻辑

```typescript
// 伪代码示意
export default function (pi: ExtensionAPI) {
  let browserProcess: ChildProcess | null = null;
  let computerProcess: ChildProcess | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // 1. 查找 polaris-browser-mcp 二进制
    // 2. 启动子进程（stdio 模式）
    browserProcess = spawn("polaris-browser-mcp", [/* config */]);
    computerProcess = spawn("polaris-computer-mcp", [/* config */]);
  });

  // 注册浏览器工具
  pi.registerTool({
    name: "browser_navigate",
    description: "Navigate a Polaris built-in browser tab to a URL",
    parameters: Type.Object({
      url: Type.String({ description: "Destination URL" }),
      label: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      // 通过 stdio 发送 JSON-RPC 请求
      const result = await sendRpc(browserProcess, "tools/call", {
        name: "browser_navigate",
        arguments: params,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // 注册电脑操作工具
  pi.registerTool({
    name: "screenshot",
    description: "Capture screen screenshot",
    // ...
  });

  pi.on("session_shutdown", async () => {
    browserProcess?.kill();
    computerProcess?.kill();
  });
}
```

### 浏览器工具清单（来自 `polaris-browser-mcp`）

| 工具名 | 功能 |
|--------|------|
| `browser_list` | 列出当前打开的浏览器标签页 |
| `browser_acquire` | 获取/绑定一个浏览器标签页 |
| `browser_navigate` | 导航到 URL |
| `browser_context` | 读取当前页面标题、URL、文本、链接 |
| `browser_diagnostics` | 调试快照（含截图） |
| `browser_inspect` | 列出可交互元素（带索引） |
| `browser_click` | 按索引或文本点击元素 |
| `browser_fill` | 填写输入框 |
| `browser_reload` | 刷新页面 |
| `browser_back` / `browser_forward` | 前进/后退 |

### 电脑操作工具清单（来自 `polaris-computer-mcp`）

| 工具名 | 功能 |
|--------|------|
| `screenshot` | 截取屏幕（支持区域/缩放） |
| `cursor_position` | 获取鼠标坐标 |
| `move_mouse` | 移动鼠标 |
| `click` | 鼠标点击（支持左右键/双击） |
| `drag` | 拖拽 |
| `type_text` | 逐字符输入文本 |
| `press_key` | 按下组合键 |
| `scroll` | 滚动滚轮 |
| `inspect_ui` | 无障碍控件树（Windows） |
| `click_element` | 按控件名点击 |
| `set_text` | 按控件名填入文本 |
| `clipboard` | 读写剪贴板 |
| `find_element` | 查找控件 |
| `list_windows` | 列出窗口 |
| `activate_window` | 激活窗口 |

### 优势

- **零重复开发** — 直接复用 Polaris 已有能力
- **标准协议** — JSON-RPC 2.0，扩展性强
- **即插即用** — 安装后 Pi 模型可直接调用
- **可热加载** — Pi 支持 `/reload`

### 复杂度

中等。需要处理：
- 子进程生命周期管理
- JSON-RPC 请求/响应封装
- 错误处理与重连
- 跨平台路径解析

---

## 方案二：Skill 直接调用 MCP 二进制（⭐⭐⭐）

### 原理

利用 Pi 的 Skills 机制，通过 `bash` 工具包装 `polaris-browser-mcp` / `polaris-computer-mcp` 的调用。

### 结构

```
.polaris/skills/polaris-browser/
├── SKILL.md
└── scripts/
    ├── browser.sh          # 包装 stdio 调用
    └── computer.sh
```

### 示例 Skill

```markdown
---
name: polaris-browser
description: Polaris 内置浏览器控制。用 browser_navigate 跳转、browser_click 点击、browser_inspect 获取可交互元素。
---

# Polaris Browser

启动：
```bash
polaris-browser-mcp --port 12345 --token xxx
```

使用：
```bash
# 通过 bash 管道发送 JSON-RPC
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com"}}}' | polaris-browser-mcp --port 12345 --token xxx
```
```

### 优劣势

- ✅ 开发量最小，纯 Markdown + Shell
- ✅ 无需写 TypeScript
- ❌ 每步都要通过 `bash` 起进程，效率低
- ❌ JSON-RPC 通过 Shell 组装不可靠
- ❌ 模型需要理解底层协议，容易出错

---

## 方案三：独立 Extension（不依赖 Polaris MCP）（⭐⭐）

### 原理

完全在 Pi Extension 中实现浏览器/电脑操作，使用 `puppeteer` / `playwright` 或系统 API。

### 优劣势

- ✅ 完全独立，不依赖 Polaris 运行
- ❌ 大量重复开发
- ❌ 需要 npm 依赖（puppeteer 约 300MB）
- ❌ Windows 电脑操作需要 Rust/napi 绑定

---

## 方案四：Web 模式 API + Extension 桥接（⭐⭐⭐⭐⭐）

### 原理

1. 启动 Polaris Web 模式（`polaris-web` 二进制）
2. 通过 HTTP/WebSocket 暴露浏览器和电脑操作 API
3. Pi Extension 通过 HTTP 调用

### 架构

```
Pi Agent → Extension → HTTP API → polaris-web → 浏览器 WebView / 电脑操作
```

### 优势

- **Web 模式** 自带浏览器 WebView
- **REST/WS** 比 stdio 更稳定
- 多客户端可同时接入
- 支持远程访问（服务器场景）

---

## 方案对比总结

| 方案 | 开发量 | 复用 Polaris | 可靠性 | 易用性 | 推荐度 |
|------|:------:|:-----------:|:------:|:------:|:------:|
| **方案一：Extension 桥接 MCP** | 中 | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| **方案二：Skill 调用二进制** | 低 | ✅ | ⚠️ | ❌ | ⭐⭐⭐ |
| **方案三：独立 Extension** | 高 | ❌ | ✅ | ✅ | ⭐⭐ |
| **方案四：Web API + Extension** | 中 | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ |

---

## 推荐实施路径

### 短期（最快见效）：方案一

1. 创建 `~/.pi/agent/extensions/polaris-mcp-bridge/` 目录
2. 实现 `index.ts`：
   - `session_start` 时启动 `polaris-browser-mcp` 和 `polaris-computer-mcp`
   - 注册所有 browser 和 computer 工具
   - `session_shutdown` 时清理子进程
3. 安装后即可使用

### 中期：方案四

当 Polaris Web 模式稳定后，改为 HTTP 桥接：
- 支持远程访问
- 更稳定的连接管理
- 更好的多客户端支持

### 长期

考虑将 Polaris MCP 能力直接封装为 Pi Package，发布到 npm：
- `pi install npm:@polaris/pi-mcp-bridge`
- 社区可直接使用