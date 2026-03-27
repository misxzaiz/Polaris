# CLAUDE.md — Polaris 项目配置

## 项目结构

- `src/` - 源代码
- `src/engines/` - AI 引擎实现
- `src/stores/` - 状态管理
- `src/components/` - React 组件

### `.polaris/` 工作区数据

- `.polaris/requirements/requirements.json` - 需求队列数据
- `.polaris/requirements/prototypes/{id}.html` - 需求原型文件
- `.polaris/todos.json` - 待办事项
- `.polaris/protocols/{task-id}/` - 协议任务目录

## 需求队列系统

需求队列用于管理和追踪项目需求，支持 AI 自动生成和用户手动创建。

### 数据文件

文件路径：`.polaris/requirements/requirements.json`

```json
{
  "version": "1.0.0",
  "updatedAt": "<ISO 8601>",
  "requirements": [
    {
      "id": "<UUID>",
      "title": "<需求标题>",
      "description": "<详细描述>",
      "status": "pending",
      "priority": "<low|normal|high|urgent>",
      "tags": ["<标签>"],
      "hasPrototype": false,
      "prototypePath": ".polaris/requirements/prototypes/<id>.html",
      "generatedBy": "<ai|manual>",
      "generatedAt": <Unix毫秒时间戳>,
      "createdAt": <Unix毫秒时间戳>,
      "updatedAt": <Unix毫秒时间戳>
    }
  ]
}
```

### 状态流转

`draft` → `pending` → `approved` / `rejected`
`approved` → `executing` → `completed` / `failed`

### AI 操作规范

- **添加需求**：读取现有 JSON，追加到 `requirements` 数组，更新 `updatedAt`，写回文件
- **执行需求**：读取 JSON，筛选 `status === "approved"`，按优先级选取，分析后将结果写入 `executeLog` 字段，状态改为 `executing`
- **生成原型**：仅涉及 UI 变更时生成，写入 `.polaris/requirements/prototypes/{id}.html`（单文件 HTML + 内联 CSS）
- 新增需求状态固定为 `"pending"`，由用户在面板中审核
- 每次操作前检查已有需求，避免重复
- JSON 缩进 2 空格，保持格式化

### 自动化协议模板

- `req-generate`：定时分析项目并生成需求到队列
- `req-execute`：定时从队列获取已批准需求进行深入分析（仅分析不实现）

## 技术栈

- **前端**: React + TypeScript + Vite
- **桌面**: Tauri
- **样式**: Tailwind CSS
- **状态**: Zustand

## 编码规范

- 使用 TypeScript 严格模式
- 组件使用函数式组件
- 使用 React Hooks
- 遵循现有代码风格

## 常用命令

```bash
npm run dev      # 启动开发服务器
npm run build    # 构建生产版本
npm run tauri    # 启动 Tauri 应用
```

## Git 工作流

- 使用 Conventional Commits
- 每个功能一个分支
- PR 需要代码审查
