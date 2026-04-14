# 模型配置功能规划文档

> 版本：1.0.0
> 日期：2026-04-14
> 状态：规划中

---

## 一、功能概述

为 Polaris 添加模型配置可视化界面，让用户可以灵活选择模型和调整努力级别，以平衡响应质量和成本。

### 目标用户

- 需要根据任务复杂度选择合适模型的用户
- 希望控制 API 成本的用户
- 需要快速响应或高质量输出的用户

### 核心价值

1. **成本控制**：简单任务使用轻量模型
2. **质量保证**：复杂任务使用高级模型
3. **响应速度**：快速任务选择快速模型
4. **灵活切换**：随时调整模型配置

---

## 二、模型配置分析

### 2.1 Claude CLI 模型参数

```bash
# 指定模型
claude --model <model>

# 努力级别
claude --effort <level>

# 回退模型（过载时）
claude --fallback-model <model>
```

### 2.2 模型类型

| 模型 | 特点 | 适用场景 |
|------|------|---------|
| `haiku` | 快速、低成本 | 简单查询、快速探索 |
| `sonnet` | 平衡、通用 | 大多数任务 |
| `opus` | 高质量、复杂 | 复杂推理、高级任务 |
| `inherit` | 继承父会话 | Agent 继承 |

### 2.3 努力级别

| 级别 | 特点 | 适用场景 |
|------|------|---------|
| `low` | 快速响应、低消耗 | 简单任务 |
| `medium` | 平衡 | 一般任务 |
| `high` | 深度思考 | 复杂任务 |
| `max` | 最大努力 | 最复杂任务 |

### 2.4 环境变量配置

```json
// ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_MODEL": "GLM-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "GLM-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "GLM-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "GLM-5",
    "ANTHROPIC_REASONING_MODEL": "GLM-5"
  },
  "model": "glm-5"
}
```

### 2.5 Polaris 现有配置

```typescript
// src/stores/configStore.ts

interface ClaudeCodeConfig {
  cliPath?: string;
  // 无模型配置
}
```

当前不支持模型配置。

---

## 三、UI 设计

### 3.1 入口位置

**方案 A**：对话输入区域上方

```
┌─────────────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [🤖 Sonnet ▾] [⚡ Medium ▾]              [⚙️ 更多]     │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 输入消息...                                             │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**方案 B**：设置模态框 "模型" Tab

```
┌─────────────────────────────────────────────────────────────┐
│ 设置 > 模型配置                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 默认模型                                                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ◉ Sonnet (平衡)                                         │ │
│ │ ○ Haiku (快速)                                          │ │
│ │ ○ Opus (高质量)                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ 默认努力级别                                                 │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ○ Low      ◉ Medium      ○ High      ○ Max             │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ 回退模型（可选）                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [无 ▾]                                                  │ │
│ └─────────────────────────────────────────────────────────┘ │
│ 当默认模型过载时自动切换到回退模型。                        │
│                                                             │
│ ─────────── 高级 ───────────                                │
│                                                             │
│ 自定义模型名称                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │                                                         │ │
│ └─────────────────────────────────────────────────────────┘ │
│ 使用自定义模型名称覆盖默认别名（如 claude-sonnet-4-6）。   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**推荐方案 A+B**：对话区快速切换 + 设置页面详细配置

### 3.2 模型选择下拉菜单

```
┌─────────────────────────────────────┐
│ 🤖 选择模型                         │
├─────────────────────────────────────┤
│ ◉ ⚖️ Sonnet                         │
│   平衡的选择，适合大多数任务        │
│                                     │
│ ○ ⚡ Haiku                          │
│   快速响应，低成本                  │
│                                     │
│ ○ 🧠 Opus                           │
│   最高质量，复杂推理                │
│                                     │
│ ─── 自定义 ───                      │
│ ○ ✏️ 自定义模型名称...              │
└─────────────────────────────────────┘
```

### 3.3 努力级别选择

```
┌─────────────────────────────────────┐
│ ⚡ 努力级别                         │
├─────────────────────────────────────┤
│ ○ Low                               │
│   快速响应，简单任务                │
│                                     │
│ ◉ Medium                            │
│   平衡的选择，一般任务              │
│                                     │
│ ○ High                              │
│   深度思考，复杂任务                │
│                                     │
│ ○ Max                               │
│   最大努力，最复杂任务              │
└─────────────────────────────────────┘
```

### 3.4 组件拆分

| 组件 | 功能 | Props |
|------|------|-------|
| `ModelSelector` | 模型选择器 | `value`, `onChange` |
| `ModelDropdown` | 模型下拉菜单 | `selected`, `onSelect` |
| `EffortSelector` | 努力级别选择器 | `value`, `onChange` |
| `EffortDropdown` | 努力级别下拉菜单 | `selected`, `onSelect` |
| `ModelSettingsTab` | 设置页面模型 Tab | - |
| `CustomModelInput` | 自定义模型输入 | `value`, `onChange` |

---

## 四、数据模型

### 4.1 TypeScript 类型

```typescript
// src/types/model.ts

export type ModelType = 'haiku' | 'sonnet' | 'opus' | 'custom';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface ModelConfig {
  /** 默认模型 */
  defaultModel: ModelType;
  /** 自定义模型名称（当 defaultModel 为 custom 时使用） */
  customModelName?: string;
  /** 默认努力级别 */
  defaultEffort: EffortLevel;
  /** 回退模型 */
  fallbackModel?: ModelType;
  /** 回退自定义模型名称 */
  fallbackCustomModelName?: string;
}

export interface ModelOption {
  type: ModelType;
  name: string;
  displayName: string;
  description: string;
  icon: string;
}
```

### 4.2 配置存储

```typescript
// src/stores/configStore.ts

interface Config {
  // ... 现有字段
  modelConfig?: ModelConfig;
}
```

---

## 五、后端实现

### 5.1 修改 start_chat 命令

```rust
// src-tauri/src/commands/chat.rs

#[derive(Debug, Deserialize)]
pub struct ChatRequestOptions {
    // ... 现有字段
    pub model: Option<String>,      // 新增
    pub effort: Option<String>,     // 新增
    pub fallback_model: Option<String>, // 新增
}

pub async fn start_chat(/* ... */) -> Result<()> {
    // ...

    // 添加模型参数
    if let Some(model) = &options.model {
        cmd.arg("--model").arg(model);
    }

    // 添加努力级别参数
    if let Some(effort) = &options.effort {
        cmd.arg("--effort").arg(effort);
    }

    // 添加回退模型参数
    if let Some(fallback) = &options.fallback_model {
        cmd.arg("--fallback-model").arg(fallback);
    }

    // ...
}
```

### 5.2 配置读写

```rust
// src-tauri/src/commands/config.rs

#[tauri::command]
pub async fn get_model_config() -> Result<ModelConfig, String> {
    // 从 settings.json 读取模型配置
}

#[tauri::command]
pub async fn set_model_config(config: ModelConfig) -> Result<(), String> {
    // 写入 settings.json
    // 可能需要写入 env 字段
}
```

---

## 六、前端实现

### 6.1 Store 设计

```typescript
// src/stores/modelStore.ts

import { create } from 'zustand';

interface ModelState {
  config: ModelConfig;
  sessionModel: ModelType | null; // 当前会话临时选择
  sessionEffort: EffortLevel | null;

  // Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: Partial<ModelConfig>) => Promise<void>;
  setSessionModel: (model: ModelType | null) => void;
  setSessionEffort: (effort: EffortLevel | null) => void;
}

// 默认配置
const defaultConfig: ModelConfig = {
  defaultModel: 'sonnet',
  defaultEffort: 'medium',
};
```

### 6.2 服务层

```typescript
// src/services/modelService.ts

import { invoke } from '@tauri-apps/api/core';

export const modelService = {
  async getConfig(): Promise<ModelConfig> {
    return invoke('get_model_config');
  },

  async setConfig(config: ModelConfig): Promise<void> {
    return invoke('set_model_config', { config });
  },
};
```

### 6.3 与对话集成

```typescript
// 发送消息时传递模型参数
async function sendMessage(content: string) {
  const modelStore = useModelStore.getState();
  const configStore = useConfigStore.getState();

  const model = modelStore.sessionModel || configStore.modelConfig?.defaultModel;
  const effort = modelStore.sessionEffort || configStore.modelConfig?.defaultEffort;

  await invoke('start_chat', {
    message: content,
    sessionId,
    options: {
      // ... 其他选项
      model: model === 'custom' ? configStore.modelConfig?.customModelName : model,
      effort,
      fallback_model: configStore.modelConfig?.fallbackModel,
    },
  });
}
```

---

## 七、实现计划

### Phase 1: 后端支持（0.5天）

1. 修改 `start_chat` 支持模型参数
2. 实现配置读写命令

### Phase 2: 前端组件（1天）

1. 创建 `ModelSelector` 组件
2. 创建 `EffortSelector` 组件
3. 集成到对话输入区域

### Phase 3: 设置页面（0.5天）

1. 创建 `ModelSettingsTab` 组件
2. 实现完整配置界面

### Phase 4: 优化完善（0.5天）

1. 添加持久化存储
2. 添加会话级临时选择
3. 国际化支持

---

## 八、用户场景

### 场景 1：快速查询

```
用户：这个项目的目录结构是什么？

1. 选择 Haiku 模型
2. 选择 Low 努力级别
3. 发送问题
4. 获得快速、低成本的响应
```

### 场景 2：复杂推理

```
用户：请分析这个系统的性能瓶颈并提出优化方案

1. 选择 Opus 模型
2. 选择 High 或 Max 努力级别
3. 发送问题
4. 获得深度分析和详细方案
```

### 场景 3：日常开发

```
用户：帮我写一个 React 组件

1. 使用默认 Sonnet 模型
2. 使用默认 Medium 努力级别
3. 发送请求
4. 获得平衡的响应
```

---

## 九、模型对比说明

### 9.1 成本对比（示例）

| 模型 | 相对成本 | 响应速度 | 适用场景 |
|------|---------|---------|---------|
| Haiku | 1x | 最快 | 简单查询、快速探索 |
| Sonnet | 3x | 较快 | 大多数任务 |
| Opus | 15x | 较慢 | 复杂推理、高级任务 |

### 9.2 努力级别影响

- **Low**：快速响应，适合简单任务
- **Medium**：平衡思考深度和速度
- **High**：深度分析，复杂推理
- **Max**：最大努力，最全面的分析

---

## 十、风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 模型不可用 | 执行失败 | 可用性检查 + 错误提示 |
| 自定义模型名称错误 | API 错误 | 格式验证 |
| 成本误解 | 超预算 | 清晰的成本提示 |

---

## 十一、后续扩展

1. **模型推荐**：根据任务内容推荐模型
2. **成本估算**：发送前预估成本
3. **模型对比**：同问题多模型响应对比
4. **使用统计**：各模型使用频率和成本统计

---

*文档版本：1.0.0*
*最后更新：2026-04-14*
