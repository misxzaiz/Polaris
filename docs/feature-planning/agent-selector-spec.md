# Agent 选择器功能规划文档

> 版本：1.0.0
> 日期：2026-04-14
> 状态：规划中

---

## 一、功能概述

为 Polaris 添加 Agent 选择功能，让用户可以选择不同的 Agent 来执行任务，以获得更专业或更高效的结果。

### 目标用户

- 需要执行特定类型任务的用户
- 希望优化执行效率的用户
- 需要代码审查等专业操作的用户

### 核心价值

1. **任务专业化**：不同 Agent 针对不同场景优化
2. **成本优化**：简单任务使用轻量 Agent
3. **质量保证**：代码审查等使用专业 Agent
4. **灵活配置**：支持自定义 Agent

---

## 二、Agent 架构分析

### 2.1 Claude CLI Agent 支持

#### CLI 参数

```bash
# 使用指定 Agent
claude --agent <agent-name>

# 自定义 Agent 定义
claude --agents '{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}'
```

#### 内置 Agent

| Agent | 模型 | 用途 |
|-------|------|------|
| `general-purpose` | inherit | 通用任务 |
| `Explore` | haiku | 代码库探索 |
| `Plan` | inherit | 规划任务 |
| `statusline-setup` | sonnet | 状态栏设置 |

#### 插件 Agent

| Agent | 来源 | 用途 |
|-------|------|------|
| `superpowers:code-reviewer` | superpowers 插件 | 代码审查 |

### 2.2 Agent 类型说明

| 模型配置 | 含义 |
|---------|------|
| `inherit` | 继承父会话模型 |
| `haiku` | 使用 Haiku 模型（快速、低成本） |
| `sonnet` | 使用 Sonnet 模型（平衡） |
| `opus` | 使用 Opus 模型（最高质量） |

### 2.3 Polaris 现有 Agent 架构

```typescript
// src/core/agents/AgentRunner.ts

interface AgentRunner {
  id: string
  name: string
  description?: string
  capabilities: AgentCapabilities
  isAvailable(): Promise<boolean>
  initialize?(): Promise<void>
  run(input: AgentInput): Promise<AgentOutput>
}
```

当前已注册 Agent：
- `claude-code`: Claude Code CLI 适配器

---

## 三、UI 设计

### 3.1 入口位置

**方案**：对话输入区域上方添加 Agent 选择器

```
┌─────────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [🔄 general-purpose ▾]  [⚙️ 高级选项]                   │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 输入消息...                                             │ │
│ │                                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [📎 附件] [🎤 语音]                      [发送 ➤]       │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Agent 选择下拉菜单

```
┌─────────────────────────────────────┐
│ 🔍 搜索 Agent...                    │
├─────────────────────────────────────┤
│ ─── 内置 Agent ───                  │
│ ○ 🔄 general-purpose                │
│   通用任务 · inherit                │
│                                     │
│ ○ 🔍 Explore                        │
│   快速探索代码库 · haiku            │
│                                     │
│ ○ 📋 Plan                           │
│   任务规划 · inherit                │
│                                     │
│ ○ ⚙️ statusline-setup               │
│   状态栏配置 · sonnet               │
│                                     │
│ ─── 插件 Agent ───                  │
│ ○ 🔎 superpowers:code-reviewer      │
│   代码审查 · inherit                │
│                                     │
│ ─── 自定义 Agent ───                │
│ ○ ➕ 创建新 Agent...                │
└─────────────────────────────────────┘
```

### 3.3 Agent 详情面板

```
┌─────────────────────────────────────────────────────────────┐
│ Agent 详情                                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 🔍 Explore                                                  │
│                                                             │
│ 描述:                                                       │
│ 快速代理，专门用于探索代码库。在需要快速查找文件模式      │
│ （如 "src/components/**/*.tsx"）、搜索关键词（如         │
│ "API endpoints"）或回答代码库问题（如 "API 端点如何       │
│ 工作？"）时使用。                                          │
│                                                             │
│ 模型: Haiku (快速、低成本)                                 │
│ 来源: Built-in                                              │
│                                                             │
│ 适用场景:                                                   │
│ • 文件模式搜索                                              │
│ • 代码关键词搜索                                            │
│ • 代码库问题解答                                            │
│                                                             │
│ 使用建议:                                                   │
│ 当需要快速探索但不需深入了解时，使用此 Agent 可以         │
│ 获得更快的响应和更低的成本。                              │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │                    [选择此 Agent]                       │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 3.4 创建自定义 Agent 弹窗

```
┌─────────────────────────────────────────────┐
│ ➕ 创建自定义 Agent                         │
├─────────────────────────────────────────────┤
│                                             │
│ Agent ID *                                  │
│ ┌─────────────────────────────────────────┐ │
│ │ my-custom-agent                         │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 显示名称 *                                   │
│ ┌─────────────────────────────────────────┐ │
│ │ 我的自定义 Agent                        │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 描述                                        │
│ ┌─────────────────────────────────────────┐ │
│ │ 这是一个专门用于...的 Agent             │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ 模型                                        │
│ ◉ 继承父会话 (inherit)                      │
│ ○ Haiku (快速)                              │
│ ○ Sonnet (平衡)                             │
│ ○ Opus (高质量)                             │
│                                             │
│ 系统提示词                                  │
│ ┌─────────────────────────────────────────┐ │
│ │ You are a specialized agent that...     │ │
│ │                                         │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │        [取消]         [创建]            │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 3.5 组件拆分

| 组件 | 功能 | Props |
|------|------|-------|
| `AgentSelector` | Agent 选择器 | `selectedAgent`, `onSelect` |
| `AgentDropdown` | 下拉菜单 | `agents`, `selectedId`, `onSelect` |
| `AgentOption` | Agent 选项 | `agent`, `selected`, `onSelect` |
| `AgentDetailPanel` | 详情面板 | `agent`, `onSelect` |
| `AgentCreateModal` | 创建弹窗 | `onCreate`, `onCancel` |

---

## 四、数据模型

### 4.1 TypeScript 类型

```typescript
// src/types/agent.ts

export type AgentModel = 'inherit' | 'haiku' | 'sonnet' | 'opus';

export type AgentSource = 'builtin' | 'plugin' | 'custom';

export interface Agent {
  id: string;
  name: string;
  description?: string;
  model: AgentModel;
  source: AgentSource;
  prompt?: string; // 自定义 Agent 的系统提示词
}

export interface AgentListResult {
  builtin: Agent[];
  plugin: Agent[];
  custom: Agent[];
}

export interface CustomAgentConfig {
  id: string;
  name: string;
  description?: string;
  model: AgentModel;
  prompt: string;
}
```

### 4.2 配置存储

自定义 Agent 存储在 Polaris 配置中：

```typescript
// src/stores/configStore.ts

interface Config {
  // ...
  customAgents?: CustomAgentConfig[];
  defaultAgent?: string;
}
```

---

## 五、后端实现

### 5.1 Tauri Commands

```rust
// src-tauri/src/commands/agent.rs

#[tauri::command]
pub async fn agent_list() -> Result<AgentListResult, String> {
    // 调用 claude agents --setting-sources user
    // 解析输出获取内置和插件 Agent
    // 合并自定义 Agent
}

#[tauri::command]
pub async fn agent_get(id: String) -> Result<Option<Agent>, String> {
    // 获取指定 Agent 详情
}

#[tauri::command]
pub async fn agent_create(config: CustomAgentConfig) -> Result<Agent, String> {
    // 验证配置
    // 保存到 Polaris 配置
}

#[tauri::command]
pub async fn agent_delete(id: String) -> Result<(), String> {
    // 删除自定义 Agent
}

#[tauri::command]
pub async fn agent_update(config: CustomAgentConfig) -> Result<Agent, String> {
    // 更新自定义 Agent
}
```

### 5.2 CLI 输出解析

```rust
// 解析 claude agents 输出
// 格式示例：
// 5 active agents
//
// Plugin agents:
//   superpowers:code-reviewer · inherit
//
// Built-in agents:
//   Explore · haiku
//   general-purpose · inherit

fn parse_agents_output(output: &str) -> AgentListResult {
    let mut builtin = Vec::new();
    let mut plugin = Vec::new();
    let mut current_section = None;

    for line in output.lines() {
        if line.contains("Plugin agents:") {
            current_section = Some("plugin");
        } else if line.contains("Built-in agents:") {
            current_section = Some("builtin");
        } else if let Some(section) = current_section {
            if let Some(agent) = parse_agent_line(line) {
                if section == "plugin" {
                    plugin.push(agent);
                } else {
                    builtin.push(agent);
                }
            }
        }
    }

    AgentListResult { builtin, plugin, custom: vec![] }
}

fn parse_agent_line(line: &str) -> Option<Agent> {
    // 格式: "  AgentName · model"
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let parts: Vec<&str> = line.split("·").collect();
    if parts.len() != 2 {
        return None;
    }

    Some(Agent {
        id: parts[0].trim().to_string(),
        name: parts[0].trim().to_string(),
        model: parse_model(parts[1].trim()),
        source: AgentSource::Builtin,
        ..Default::default()
    })
}
```

### 5.3 传递 Agent 参数

修改 `start_chat` 命令，支持 Agent 参数：

```rust
// src-tauri/src/commands/chat.rs

#[derive(Debug, Deserialize)]
pub struct ChatRequestOptions {
    // ... 现有字段
    pub agent: Option<String>, // 新增
}

pub async fn start_chat(/* ... */) -> Result<()> {
    // ...

    // 添加 Agent 参数
    if let Some(agent) = &options.agent {
        cmd.arg("--agent").arg(agent);
    }

    // 如果是自定义 Agent，添加 --agents 参数
    if let Some(custom_agent_config) = get_custom_agent_config(&options.agent) {
        let agents_json = serde_json::to_string(&custom_agent_config)?;
        cmd.arg("--agents").arg(agents_json);
    }

    // ...
}
```

---

## 六、前端实现

### 6.1 Store 设计

```typescript
// src/stores/agentStore.ts

import { create } from 'zustand';

interface AgentState {
  agents: AgentListResult;
  selectedAgent: string | null;
  loading: boolean;
  error: string | null;

  // Actions
  fetchAgents: () => Promise<void>;
  selectAgent: (id: string | null) => void;
  createCustomAgent: (config: CustomAgentConfig) => Promise<void>;
  updateCustomAgent: (config: CustomAgentConfig) => Promise<void>;
  deleteCustomAgent: (id: string) => Promise<void>;
}
```

### 6.2 服务层

```typescript
// src/services/agentService.ts

import { invoke } from '@tauri-apps/api/core';

export const agentService = {
  async listAgents(): Promise<AgentListResult> {
    return invoke('agent_list');
  },

  async getAgent(id: string): Promise<Agent | null> {
    return invoke('agent_get', { id });
  },

  async createAgent(config: CustomAgentConfig): Promise<Agent> {
    return invoke('agent_create', { config });
  },

  async updateAgent(config: CustomAgentConfig): Promise<Agent> {
    return invoke('agent_update', { config });
  },

  async deleteAgent(id: string): Promise<void> {
    return invoke('agent_delete', { id });
  },
};
```

### 6.3 与对话集成

修改 `sendMessage` 流程，传递选中的 Agent：

```typescript
// src/stores/conversationStore/actions/sendMessage.ts

async function sendMessage(content: string) {
  const agentId = useAgentStore.getState().selectedAgent;

  await invoke('start_chat', {
    message: content,
    sessionId,
    options: {
      // ... 其他选项
      agent: agentId,
    },
  });
}
```

---

## 七、实现计划

### Phase 1: 后端基础（1天）

1. 创建 Agent 数据模型
2. 实现 `agent_list` 命令（解析 CLI 输出）
3. 实现自定义 Agent CRUD
4. 修改 `start_chat` 支持 Agent 参数

### Phase 2: 前端选择器（1天）

1. 创建 `AgentSelector` 组件
2. 创建 `AgentDropdown` 组件
3. 创建 `AgentOption` 组件
4. 集成到对话输入区域

### Phase 3: 详情与管理（1天）

1. 创建 `AgentDetailPanel` 组件
2. 创建 `AgentCreateModal` 弹窗
3. 实现 Agent 管理功能

### Phase 4: 集成优化（1天）

1. 与对话系统集成
2. 添加持久化存储
3. 国际化支持
4. 单元测试

---

## 八、用户场景

### 场景 1：快速代码探索

```
用户：我需要了解这个项目的 API 端点是如何实现的

1. 选择 "Explore" Agent
2. 发送问题
3. 获得快速、低成本的响应
```

### 场景 2：代码审查

```
用户：请审查我刚写的这段代码

1. 选择 "superpowers:code-reviewer" Agent
2. 发送代码
3. 获得专业的代码审查结果
```

### 场景 3：自定义专业 Agent

```
用户创建一个专门用于写测试的 Agent

1. 点击 "创建新 Agent"
2. 填写：
   - ID: test-writer
   - 名称: 测试编写专家
   - 提示词: You are an expert at writing comprehensive tests...
   - 模型: Sonnet
3. 之后可以直接选择此 Agent 编写测试
```

---

## 九、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| CLI 输出格式变化 | 解析失败 | 正则灵活性 + 版本检测 |
| Agent 不可用 | 执行失败 | 可用性检查 + 错误提示 |
| 自定义 Agent 验证 | 无效配置 | 表单验证 + 预览功能 |

---

## 十、后续扩展

1. **Agent 推荐**：根据任务内容推荐合适的 Agent
2. **Agent 市场**：分享和下载社区 Agent
3. **Agent 执行统计**：各 Agent 使用频率和效果统计
4. **Agent 组合**：支持多 Agent 协作

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
