# cap.* 能力集成测试报告

> 日期：2026-10-25 · 状态：已完成
> 测试工具：`mcp__polaris-dispatch__cap_dispatch`
> 测试目标：验证 5 个核心能力的可用性、边界与已知问题

---

## 1. cap.self.inspect（透视自身）

### 1.1 支持的 action

| action | 用途 | 状态 |
|---|---|---|
| `status` | 系统基本信息（版本/架构/运行时长/数据根） | ✅ |
| `diskUsage` | 数据根存储分布（目录大小/文件数） | ✅ |
| `health` | 健康检查（数据根/配置/审计链） | ✅ ⚠️ |
| `capabilities` | 能力清单（builtin/dynamic/streaming 分类） | ✅ |

### 1.2 测试数据

```json
// status
{
  "version": "10.8.0",
  "arch": "x86_64",
  "os": "windows",
  "uptimeSec": 5278,
  "capabilityCount": 26,
  "dataRoot": "D:\\app\\polaris-s",
  "dataRootIsCustom": true
}

// diskUsage
{
  "dataRootBytes": 3152871140,  // ~3GB
  "dataRootFiles": 7676,
  "largestSubdir": {"name": "plugins", "sizeBytes": 1158356056},
  "subdirs": [
    {"name": "plugins", "fileCount": 4843, "sizeBytes": 1158356056},
    {"name": "logs", "fileCount": 129, "sizeBytes": 1093656823},
    {"name": "dialogs", "fileCount": 534, "sizeBytes": 270875261},
    {"name": "stores", "fileCount": 21, "sizeBytes": 4854392}
  ]
}

// health
{
  "checks": {
    "dataRootReadable": true,
    "configDirReadable": true,
    "auditChain": {"ok": false, "detail": "broken at line 147"}
  }
}

// capabilities
{
  "total": 26,
  "builtinCount": 24,
  "dynamicCount": 0,
  "streamingCount": 2,
  "bySource": {
    "builtin": ["cap.bash", "cap.config", "cap.context", ...],
    "streaming": ["cap.ai.chat", "cap.stream.echo"]
  }
}
```

### 1.3 关键发现

- **审计链断裂**：`health` 返回 `auditChain.ok: false`，详情 `broken at line 147`
- **数据根路径自定义**：`dataRootIsCustom: true`，路径为 `D:\app\polaris-s`
- **插件目录最大**：plugins 占 1.1GB，是存储大户

---

## 2. cap.self.mutate（UI 插槽改造）

### 2.1 支持的 action

| action | 用途 | 状态 |
|---|---|---|
| `listSlots` | 列出当前插槽配置 | ✅ |
| `setSlot` | 设置插槽内容（kind: status-badge/tooltip-label/quick-action） | ✅ |
| `clearSlot` | 清除插槽 | ✅ |

### 2.2 slotId 与 kind 白名单

**slotId：**
- `input-extra` — 输入区附加区域
- `app-badge` — 应用角标区域
- `message-extra` — 消息区附加区域

**kind（每种有各自的 props schema）：**
| kind | 合法 props 字段 |
|---|---|
| `status-badge` | label, text, tone, target, height |
| `tooltip-label` | label, text, tone, target, height |
| `quick-action` | label, text, tone, target, height |

### 2.3 测试结果

```json
// listSlots 初始状态
{"slots": []}

// setSlot 成功
{"ok": true, "kind": "status-badge", "slotId": "app-badge"}

// setSlot 失败（props 字段校验）
{"error": "cap.self.mutate props 未知字段: icon（合法集: label, text, tone, target, height）"}

// clearSlot 成功
{"ok": true, "slotId": "input-extra"}
```

### 2.4 已知问题

- ❌ `quick-action` 的 props **不支持 `icon` 字段**，仅支持 `{label, text, tone, target, height}`
- 可能需要扩展 `quick-action` 的 props schema 以支持图标

---

## 3. cap.todo（待办事项）

### 3.1 支持的 action

| action | 用途 | 状态 |
|---|---|---|
| `list` | 查询待办列表（支持 scope/status/priority/tags 过滤） | ✅ |
| `get` | 查询单个待办 | ✅ |
| `create` | 创建待办 | ✅ |
| `update` | 更新待办 | ✅ |
| `start` | 开始执行（pending → in_progress） | ✅ |
| `complete` | 完成待办（in_progress → completed） | ✅ |
| `delete` | 删除待办 | - |
| `breakdown` | 按工作区分组统计 | ✅ |

### 3.2 测试流程

```typescript
// 1. 创建
create({ content: "测试 cap.todo - 创建第一个任务", priority: "normal", tags: ["测试"] })
→ { id: "cdf2cbe6-4e4b-40d4-b891-797441a0fb0f", status: "pending" }

// 2. 查询
get({ id: "cdf2cbe6-..." })
→ { content: "...", priority: "normal", status: "pending" }

// 3. 开始
start({ id: "cdf2cbe6-..." })
→ { status: "in_progress" }

// 4. 完成
complete({ id: "cdf2cbe6-..." })
→ { status: "completed", completedAt: "2026-10-24T17:11:36.910Z" }

// 5. 统计
breakdown()
→ { stats: { "Polaris": 1, "全局": 9 } }
```

### 3.3 测试数据

当前环境待办共 9 个（8 pending + 1 completed，含历史测试数据）：

| ID 前缀 | 内容 | 优先级 | 状态 |
|---|---|---|---|
| 709af548 | 总线验证用待办 | normal | pending |
| fe9f7a84 | bus-mcp验证-0912 | normal | pending |
| f7bc0e8c | bus-mcp验证-0912 | normal | pending |
| 9c215bdc | 【测试】验证 cap.todo 联动能力 | normal | pending |
| 72a8b489 | [cap.ui.render] 扩展 DSL... | normal | pending |
| 1ad53597 | 测试待办事项 - 使用 cap.todo 创建 | high | pending |
| cdf2cbe6 | 测试 cap.todo - 创建第一个任务 | normal | **completed** |
| 9f3f6c84 | 测试 cap.todo - 高优先级任务 | high | pending |

---

## 4. cap.ui.chat（对话渲染配置）

### 4.1 支持的 action

| action | 用途 | 状态 |
|---|---|---|
| `get` | 读取当前 chatDisplay 配置 | ✅ |
| `patch` | 部分更新配置 | ✅ |
| `reset` | 重置为默认值 | ✅ |

### 4.2 配置字段（chatDisplay）

```typescript
interface ChatDisplaySettings {
  fontSize?: number           // 字号（默认 14）
  lineHeight?: number         // 行高（默认 1.5）
  messageSpacing?: 'compact' | 'normal' | 'spacious'
  codeFontSize?: number       // 代码块字号
  fontFamily?: string         // 字体族
  // ... 其他字段见 types/config.ts
}
```

### 4.3 测试流程

```typescript
// 1. 读取初始配置
get() → { config: { fontSize: 14, lineHeight: 1.5, ... } }

// 2. 修改配置
patch({ config: { fontSize: 18, lineHeight: 1.8, messageSpacing: "spacious" } })
→ { ok: true, config: { fontSize: 18, lineHeight: 1.8, messageSpacing: "spacious" } }

// 3. 验证生效
get() → { config: { fontSize: 18, lineHeight: 1.8, messageSpacing: "spacious" } }

// 4. 重置
reset() → { ok: true }
```

---

## 5. cap.ui.input（输入区 UI 控制）

### 5.1 支持的 action

| action | 用途 | 状态 |
|---|---|---|
| `get` | 读取当前输入区状态 | ✅ |
| `patch` | 更新配置（floating 悬浮层参数） | ✅ |
| `banner` | 设置/清除动态横幅 | ✅ |
| `reset` | 重置为默认值 | ✅ |

### 5.2 banner 协议

```typescript
interface BannerConfig {
  text: string        // 横幅文本
  tone?: 'info' | 'warning' | 'success' | 'danger'  // 色调
  action?: {          // 可选操作按钮
    label: string
    callback: string  // 触发的事件名
  }
}
```

### 5.3 测试流程

```typescript
// 1. 设置横幅
banner({ banner: { text: "🔍 测试横幅", tone: "info" } })
→ { ok: true, shown: true }

// 2. 清除横幅
banner({ banner: null })
→ { ok: true, shown: false }

// 3. 配置悬浮层
patch({ config: { floating: { enabled: true, gap: "md", height: 200 } } })
→ { ok: true, applied: true }

// 4. 重置
reset() → { ok: true, reset: true }
```

---

## 6. 能力边界对比

### 6.1 bus_dispatch vs cap_dispatch

| 能力 | bus_dispatch | cap_dispatch | 推荐入口 |
|---|---|---|---|
| `cap.todo` | ✅ | ✅ | bus（轻量） |
| `cap.http` | ✅ | ✅ | bus |
| `cap.bash` | ✅ | ✅ | bus |
| `cap.fs` | ✅ | ✅ | bus |
| `cap.git` | ✅ | ✅ | bus |
| `cap.ui.theme` | ✅ | ✅ | bus |
| `cap.ui.chat` | ✅ | ✅ | bus |
| `cap.ui.input` | ✅ | ✅ | bus |
| `cap.self.inspect` | ❌ | ✅ | **必须 cap_dispatch** |
| `cap.self.mutate` | ❌ | ✅ | **必须 cap_dispatch** |
| `cap.ui.render` | ❌ | ✅ | **必须 cap_dispatch** |
| `cap.ai.chat` | ❌ | ✅ | **必须 cap_dispatch** |
| `cap.kv` | ❌ | ✅ | **必须 cap_dispatch** |
| `cap.mcp` | ❌ | ✅ | **必须 cap_dispatch** |

### 6.2 决策树

```
需要调用 cap.*？
├─ 是否在 bus_dispatch 白名单？（todo/http/bash/fs/git/ui.*）
│  ├─ 是 → 使用 bus_dispatch（更轻量、独立进程）
│  └─ 否 → 使用 cap_dispatch
│
├─ 是否涉及主进程特有状态？（context/kv/render/ai.chat）
│  ├─ 是 → 必须用 cap_dispatch
│  └─ 否 → 走上面决策
│
└─ 是否流式操作？（ai.chat start/continue）
   └─ 是 → 必须用 cap_dispatch（WebSocket 事件订阅）
```

---

## 7. 已知问题与建议

### 7.1 严重问题

| 问题 | 影响 | 建议 |
|---|---|---|
| 审计链断裂（line 147） | 安全性审计不完整 | 排查 `dispatch.jsonl` line 147 |

### 7.2 体验问题

| 问题 | 影响 | 建议 |
|---|---|---|
| `quick-action` props 不支持 `icon` | 无法显示图标 | 扩展 props schema 增加 `icon` 字段 |
| `bus_dispatch` 白名单硬编码 | 新增 cap 需手动维护白名单 | 考虑动态注册或自动同步 |

### 7.3 文档缺口

- `cap.self.mutate` 的 props schema 未在 `describe()` 中完整返回
- `banner` 的 `action` 字段缺少回调注册机制说明

---

## 8. 参考文档

- `plans/two-bus-architecture.md` — 双总线架构说明
- `plans/cap-ui-render-chart-node-spec.md` — 图表节点扩展方案
- `src-tauri/src/services/router/ui_render_capability.rs` — cap.ui.render 实现
- `src/services/uiDispatchService.ts` — cap.ui.* 前端消费层

---

## 9. 勘误（2026-10-25，代码复核）

本报告为历史实测记录，结论按当时二进制行为记录；以下事项经后续代码核对已与现状不符：

- **§6.1「bus_dispatch 白名单」机制已废除**：`bus_mcp_server.rs` 现从注册表派生可转发目标（`dispatchable_capabilities`），bus 进程静态注册 17 个能力（远多于表中 8 个），静态 `DISPATCH_WHITELIST` 已删除。表中「必须 cap_dispatch」的能力（self.inspect/self.mutate/ui.render/ai.chat/kv/mcp）里，`cap.self.inspect`、`cap.self.mutate`、`cap.kv` 现已可在 bus_dispatch 触达；`cap.ui.render` / `cap.ai.chat` / `cap.mcp` 仍为主进程特有。实测时若白名单仍生效，说明当时运行的 bus-mcp 独立 bin 为旧构建（参考记忆 `polaris-mcp-schema-exe-staleness` 的同类过期问题）。
- **§7.2「bus_dispatch 白名单硬编码」建议已解决**：注册表派生后新增能力无需再维护第二处名单。
- **§3.3 计数修正**：表格实为 8 pending + 1 completed，原表述「9 个 pending」不准。

---

**文档版本**：v1.1  
**最后更新**：2026-10-25
