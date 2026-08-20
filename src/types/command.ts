/**
 * 命令类型定义
 */

export type CommandType = 'builtin' | 'custom';

export interface CommandParam {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface Command {
  name: string;
  type: CommandType;
  description: string;
  params?: CommandParam[];
  content?: string;
  filePath?: string;
}

export interface ParsedCommand {
  raw: string;
  name: string;
  args: string[];
  fileRefs: string[];
  fullCommand?: string;
}

export interface CommandResult {
  type: 'command' | 'message';
  command?: ParsedCommand;
  message?: string;
  error?: string;
}

/**
 * 内置命令定义（用于命令建议显示）
 */
export const builtinCommands: Command[] = [
  // 会话管理
  {
    name: 'stats',
    type: 'builtin',
    description: '显示会话统计信息',
  },
  {
    name: 'map',
    type: 'builtin',
    description: '显示工作区文件结构',
  },
  {
    name: 'token',
    type: 'builtin',
    description: '显示 token 使用统计',
  },

  // Git 操作
  {
    name: 'commit',
    type: 'builtin',
    description: '创建 git commit',
  },
  {
    name: 'diff',
    type: 'builtin',
    description: '显示 git diff',
  },
  {
    name: 'push',
    type: 'builtin',
    description: '推送到远程仓库',
  },
  {
    name: 'pull',
    type: 'builtin',
    description: '拉取远程更新',
  },
  {
    name: 'status',
    type: 'builtin',
    description: '显示 git 状态',
  },
  {
    name: 'log',
    type: 'builtin',
    description: '显示 git 日志',
  },
  {
    name: 'branch',
    type: 'builtin',
    description: '切换或创建分支',
  },

  // 代码质量
  {
    name: 'format',
    type: 'builtin',
    description: '格式化代码',
  },
  {
    name: 'lint',
    type: 'builtin',
    description: '代码检查',
  },
  {
    name: 'test',
    type: 'builtin',
    description: '运行测试',
  },
  {
    name: 'build',
    type: 'builtin',
    description: '构建项目',
  },
  {
    name: 'run',
    type: 'builtin',
    description: '运行脚本',
  },

  // 文件操作
  {
    name: 'edit',
    type: 'builtin',
    description: '编辑文件',
  },
  {
    name: 'search',
    type: 'builtin',
    description: '搜索代码',
  },
  {
    name: 'explain',
    type: 'builtin',
    description: '解释代码',
  },
  {
    name: 'review',
    type: 'builtin',
    description: '代码审查',
  },
  {
    name: 'refactor',
    type: 'builtin',
    description: '重构代码',
  },
  {
    name: 'document',
    type: 'builtin',
    description: '生成文档',
  },

  // 配置和依赖
  {
    name: 'config',
    type: 'builtin',
    description: '查看配置',
  },
  {
    name: 'install',
    type: 'builtin',
    description: '安装依赖',
  },
  {
    name: 'env',
    type: 'builtin',
    description: '显示环境信息',
  },

  // 帮助
  {
    name: 'commands',
    type: 'builtin',
    description: '列出所有可用命令',
  },
  {
    name: 'help',
    type: 'builtin',
    description: '显示帮助信息',
  },
  {
    name: 'guide',
    type: 'builtin',
    description: '使用指导',
  },

  // 设计相关
  {
    name: 'frontend-design-skill',
    type: 'builtin',
    description: 'Frontend-design Skill',
  },
];
