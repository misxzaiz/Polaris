/**
 * commandService 单元测试
 *
 * 测试命令服务的核心功能：
 * - 命令解析 (parseCommandInput)
 * - 参数替换 (replaceCommandArguments)
 * - 命令转提示词 (convertCommandToPrompt)
 * - 帮助信息生成
 */

import { describe, it, expect } from 'vitest'
import {
  parseCommandInput,
  convertCommandToPrompt,
  replaceCommandArguments,
  generateCommandsListMessage,
  generateHelpMessage,
} from './commandService'
import type { Command, ParsedCommand } from '../types/command'
import { builtinCommands } from '../types/command'

// ============================================================
// parseCommandInput 测试
// ============================================================
describe('parseCommandInput', () => {
  const availableCommands: Command[] = [
    ...builtinCommands,
    {
      name: 'custom-cmd',
      type: 'custom',
      description: '自定义命令测试',
      content: '执行自定义操作: $ARGUMENTS',
    },
  ]

  describe('非命令输入', () => {
    it('普通文本应返回 message 类型', () => {
      const result = parseCommandInput('Hello world', availableCommands)

      expect(result.type).toBe('message')
      expect(result.message).toBe('Hello world')
    })

    it('空字符串应返回空消息', () => {
      const result = parseCommandInput('', availableCommands)

      expect(result.type).toBe('message')
      expect(result.message).toBe('')
    })

    it('带空格的文本应保留原样', () => {
      const result = parseCommandInput('  前导空格和尾部空格  ', availableCommands)

      expect(result.type).toBe('message')
      expect(result.message).toBe('前导空格和尾部空格')
    })
  })

  describe('简单命令解析', () => {
    it('应正确解析 /help 命令', () => {
      const result = parseCommandInput('/help', availableCommands)

      expect(result.type).toBe('command')
      expect(result.command?.name).toBe('help')
      expect(result.command?.args).toEqual([])
      expect(result.command?.fileRefs).toEqual([])
    })

    it('应正确解析 /status 命令', () => {
      const result = parseCommandInput('/status', availableCommands)

      expect(result.type).toBe('command')
      expect(result.command?.name).toBe('status')
    })

    it('应正确解析 /commit 命令', () => {
      const result = parseCommandInput('/commit', availableCommands)

      expect(result.type).toBe('command')
      expect(result.command?.name).toBe('commit')
    })
  })

  describe('带参数命令解析', () => {
    it('应正确提取参数', () => {
      const result = parseCommandInput('/commit fix: 修复登录bug', availableCommands)

      expect(result.type).toBe('command')
      expect(result.command?.name).toBe('commit')
      expect(result.command?.args).toEqual(['fix:', '修复登录bug'])
    })

    it('应正确处理多个参数', () => {
      const result = parseCommandInput('/branch feature new-feature', availableCommands)

      expect(result.command?.name).toBe('branch')
      expect(result.command?.args).toEqual(['feature', 'new-feature'])
    })

    it('应正确解析 /test 带参数', () => {
      const result = parseCommandInput('/test src/utils', availableCommands)

      expect(result.command?.name).toBe('test')
      expect(result.command?.args).toEqual(['src/utils'])
    })
  })

  describe('文件引用解析', () => {
    it('应正确提取单个文件引用', () => {
      const result = parseCommandInput('/edit @src/main.ts', availableCommands)

      expect(result.command?.name).toBe('edit')
      expect(result.command?.fileRefs).toEqual(['src/main.ts'])
      expect(result.command?.args).toEqual([])
    })

    it('应正确提取多个文件引用', () => {
      const result = parseCommandInput('/review @src/a.ts @src/b.ts', availableCommands)

      expect(result.command?.fileRefs).toEqual(['src/a.ts', 'src/b.ts'])
    })

    it('应正确分离参数和文件引用', () => {
      const result = parseCommandInput('/explain --detail @src/app.tsx @src/types.ts', availableCommands)

      expect(result.command?.args).toEqual(['--detail'])
      expect(result.command?.fileRefs).toEqual(['src/app.tsx', 'src/types.ts'])
    })

    it('应正确处理只有文件引用的情况', () => {
      const result = parseCommandInput('/document @README.md', availableCommands)

      expect(result.command?.fileRefs).toEqual(['README.md'])
      expect(result.command?.args).toEqual([])
    })
  })

  describe('未知命令处理', () => {
    it('未知命令应转换为提示词让 AI 执行', () => {
      const result = parseCommandInput('/unknown-command', availableCommands)

      expect(result.type).toBe('command')
      expect(result.command?.name).toBe('unknown-command')
      expect(result.command?.fullCommand).toContain('请帮我执行')
    })

    it('未知命令带参数应包含在提示词中', () => {
      const result = parseCommandInput('/custom arg1 arg2', availableCommands)

      expect(result.command?.fullCommand).toContain('arg1 arg2')
    })
  })

  describe('自定义命令处理', () => {
    it('自定义命令应替换参数', () => {
      const result = parseCommandInput('/custom-cmd test-arg', availableCommands)

      expect(result.type).toBe('command')
      expect(result.command?.name).toBe('custom-cmd')
      expect(result.command?.fullCommand).toContain('test-arg')
    })
  })

  describe('raw 字段', () => {
    it('应保留原始输入', () => {
      const result = parseCommandInput('/commit fix: bug @file.ts', availableCommands)

      expect(result.command?.raw).toBe('/commit fix: bug @file.ts')
    })
  })
})

// ============================================================
// convertCommandToPrompt 测试
// ============================================================
describe('convertCommandToPrompt', () => {
  describe('会话管理命令', () => {
    it('stats 命令应生成统计信息提示词', () => {
      const cmd: ParsedCommand = { raw: '/stats', name: 'stats', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('统计信息')
      expect(prompt).toContain('token')
    })

    it('map 命令应生成文件结构提示词', () => {
      const cmd: ParsedCommand = { raw: '/map', name: 'map', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('文件结构')
      expect(prompt).toContain('树形')
    })

    it('token 命令应生成 token 统计提示词', () => {
      const cmd: ParsedCommand = { raw: '/token', name: 'token', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('token')
      expect(prompt).toContain('统计')
    })
  })

  describe('Git 操作命令', () => {
    it('commit 无参数应生成默认提示词', () => {
      const cmd: ParsedCommand = { raw: '/commit', name: 'commit', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('git commit')
      expect(prompt).toContain('适当的提交信息')
    })

    it('commit 带参数应包含提交信息', () => {
      const cmd: ParsedCommand = { raw: '/commit', name: 'commit', args: ['fix:', '修复bug'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('fix: 修复bug')
    })

    it('diff 无参数应显示所有修改', () => {
      const cmd: ParsedCommand = { raw: '/diff', name: 'diff', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('git diff')
      expect(prompt).toContain('所有未提交的修改')
    })

    it('diff 带参数应指定路径', () => {
      const cmd: ParsedCommand = { raw: '/diff', name: 'diff', args: ['src/', 'lib/'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('src/')
      expect(prompt).toContain('lib/')
    })

    it('push 命令应生推送提示词', () => {
      const cmd: ParsedCommand = { raw: '/push', name: 'push', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('推送')
      expect(prompt).toContain('远程仓库')
    })

    it('push 带分支名应包含分支信息', () => {
      const cmd: ParsedCommand = { raw: '/push', name: 'push', args: ['main'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('main')
    })

    it('branch 无参数应显示所有分支', () => {
      const cmd: ParsedCommand = { raw: '/branch', name: 'branch', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('显示当前所有分支')
    })

    it('branch 带一个参数应切换分支', () => {
      const cmd: ParsedCommand = { raw: '/branch', name: 'branch', args: ['develop'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('切换到分支')
      expect(prompt).toContain('develop')
    })

    it('branch 带多个参数应创建新分支', () => {
      const cmd: ParsedCommand = { raw: '/branch', name: 'branch', args: ['-b', 'feature'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('创建并切换到新分支')
    })

    it('status 命令应显示 git 状态', () => {
      const cmd: ParsedCommand = { raw: '/status', name: 'status', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('git 状态')
      expect(prompt).toContain('当前分支')
    })

    it('log 无参数应显示 git 日志', () => {
      const cmd: ParsedCommand = { raw: '/log', name: 'log', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('git 日志')
    })

    it('log 带参数应包含参数', () => {
      const cmd: ParsedCommand = { raw: '/log', name: 'log', args: ['--oneline', '-5'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('--oneline')
      expect(prompt).toContain('-5')
    })

    it('stash 无参数应暂存修改', () => {
      const cmd: ParsedCommand = { raw: '/stash', name: 'stash', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('暂存')
      expect(prompt).toContain('git stash')
    })

    it('stash 带说明应包含说明', () => {
      const cmd: ParsedCommand = { raw: '/stash', name: 'stash', args: ['WIP:', '功能开发中'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('WIP: 功能开发中')
    })

    it('pop 命令应恢复暂存', () => {
      const cmd: ParsedCommand = { raw: '/pop', name: 'pop', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('恢复最近暂存的修改')
      expect(prompt).toContain('git stash pop')
    })
  })

  describe('代码质量命令', () => {
    it('format 无参数应格式化当前代码', () => {
      const cmd: ParsedCommand = { raw: '/format', name: 'format', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('格式化')
    })

    it('format 带文件引用应格式化指定文件', () => {
      const cmd: ParsedCommand = { raw: '/format', name: 'format', args: [], fileRefs: ['src/a.ts', 'src/b.ts'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('src/a.ts')
      expect(prompt).toContain('src/b.ts')
    })

    it('lint 命令应进行代码检查', () => {
      const cmd: ParsedCommand = { raw: '/lint', name: 'lint', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('代码检查')
      expect(prompt).toContain('lint')
    })

    it('lint 带文件引用应检查指定文件', () => {
      const cmd: ParsedCommand = { raw: '/lint', name: 'lint', args: [], fileRefs: ['src/main.ts'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('src/main.ts')
    })

    it('test 无参数应运行所有测试', () => {
      const cmd: ParsedCommand = { raw: '/test', name: 'test', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('运行项目的测试套件')
    })

    it('test 带参数应运行指定测试', () => {
      const cmd: ParsedCommand = { raw: '/test', name: 'test', args: ['src/utils.test.ts'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('src/utils.test.ts')
    })

    it('build 无参数应构建项目', () => {
      const cmd: ParsedCommand = { raw: '/build', name: 'build', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('构建当前项目')
    })

    it('run 命令应执行脚本', () => {
      const cmd: ParsedCommand = { raw: '/run', name: 'run', args: ['npm', 'start'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('npm start')
    })
  })

  describe('文件操作命令', () => {
    it('edit 无文件引用应提示指定文件', () => {
      const cmd: ParsedCommand = { raw: '/edit', name: 'edit', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('请指定要编辑的文件')
    })

    it('edit 带文件引用应编辑指定文件', () => {
      const cmd: ParsedCommand = { raw: '/edit', name: 'edit', args: ['添加', '注释'], fileRefs: ['src/app.ts'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('src/app.ts')
      expect(prompt).toContain('添加 注释')
    })

    it('search 命令应搜索内容', () => {
      const cmd: ParsedCommand = { raw: '/search', name: 'search', args: ['TODO'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('搜索')
      expect(prompt).toContain('TODO')
    })

    it('find 命令应查找内容', () => {
      const cmd: ParsedCommand = { raw: '/find', name: 'find', args: ['function'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('查找')
      expect(prompt).toContain('function')
    })
  })

  describe('AI 模型控制命令', () => {
    it('model 无参数应显示当前模型', () => {
      const cmd: ParsedCommand = { raw: '/model', name: 'model', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('当前使用的 AI 模型')
    })

    it('model 带参数应切换模型', () => {
      const cmd: ParsedCommand = { raw: '/model', name: 'model', args: ['gpt-4'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('gpt-4')
      expect(prompt).toContain('切换 AI 模型')
    })

    it('compact 命令应使用紧凑模式', () => {
      const cmd: ParsedCommand = { raw: '/compact', name: 'compact', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('紧凑模式')
      expect(prompt).toContain('简洁')
    })

    it('verbose 命令应使用详细模式', () => {
      const cmd: ParsedCommand = { raw: '/verbose', name: 'verbose', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('详细模式')
      expect(prompt).toContain('更多细节')
    })
  })

  describe('上下文管理命令', () => {
    it('context 无参数应显示上下文信息', () => {
      const cmd: ParsedCommand = { raw: '/context', name: 'context', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('上下文信息')
    })

    it('forget 命令应清除信息', () => {
      const cmd: ParsedCommand = { raw: '/forget', name: 'forget', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('清除')
    })

    it('reset 命令应重置会话', () => {
      const cmd: ParsedCommand = { raw: '/reset', name: 'reset', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('重置当前会话状态')
    })
  })

  describe('帮助命令', () => {
    it('help 命令应生成帮助提示词', () => {
      const cmd: ParsedCommand = { raw: '/help', name: 'help', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('使用帮助')
    })

    it('commands 命令应列出命令', () => {
      const cmd: ParsedCommand = { raw: '/commands', name: 'commands', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('斜杠命令')
    })

    it('guide 无参数应提供使用指导', () => {
      const cmd: ParsedCommand = { raw: '/guide', name: 'guide', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('指导')
    })

    it('guide 带参数应提供特定指导', () => {
      const cmd: ParsedCommand = { raw: '/guide', name: 'guide', args: ['git', 'workflow'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('git workflow')
    })
  })

  describe('依赖管理命令', () => {
    it('install 无参数应安装项目依赖', () => {
      const cmd: ParsedCommand = { raw: '/install', name: 'install', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('安装项目的依赖')
    })

    it('install 带参数应安装指定包', () => {
      const cmd: ParsedCommand = { raw: '/install', name: 'install', args: ['lodash', 'axios'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('lodash axios')
    })

    it('update 命令应更新依赖', () => {
      const cmd: ParsedCommand = { raw: '/update', name: 'update', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('更新')
      expect(prompt).toContain('依赖')
    })

    it('upgrade 命令应升级依赖', () => {
      const cmd: ParsedCommand = { raw: '/upgrade', name: 'upgrade', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('升级')
    })
  })

  describe('其他实用命令', () => {
    it('review 命令应进行代码审查', () => {
      const cmd: ParsedCommand = { raw: '/review', name: 'review', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('代码审查')
    })

    it('refactor 无参数应重构代码', () => {
      const cmd: ParsedCommand = { raw: '/refactor', name: 'refactor', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('重构')
    })

    it('refactor 带参数应重构指定内容', () => {
      const cmd: ParsedCommand = { raw: '/refactor', name: 'refactor', args: ['extract', 'method'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('extract method')
    })

    it('explain 无参数应解释项目', () => {
      const cmd: ParsedCommand = { raw: '/explain', name: 'explain', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('解释当前项目')
    })

    it('explain 带文件引用应解释文件', () => {
      const cmd: ParsedCommand = { raw: '/explain', name: 'explain', args: [], fileRefs: ['src/core.ts'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('解释以下文件的代码')
      expect(prompt).toContain('src/core.ts')
    })

    it('document 无参数应为项目生成文档', () => {
      const cmd: ParsedCommand = { raw: '/document', name: 'document', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('生成文档')
      expect(prompt).toContain('README')
    })

    it('document 带文件引用应为文件添加注释', () => {
      const cmd: ParsedCommand = { raw: '/document', name: 'document', args: [], fileRefs: ['src/api.ts'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('为以下文件添加或更新文档注释')
      expect(prompt).toContain('src/api.ts')
    })

    it('clear 命令应确认清除', () => {
      const cmd: ParsedCommand = { raw: '/clear', name: 'clear', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('清除')
    })

    it('history 命令应显示历史', () => {
      const cmd: ParsedCommand = { raw: '/history', name: 'history', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('历史记录')
    })

    it('clean 命令应清理文件', () => {
      const cmd: ParsedCommand = { raw: '/clean', name: 'clean', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('清理')
      expect(prompt).toContain('未跟踪文件')
    })

    it('init 命令应初始化项目', () => {
      const cmd: ParsedCommand = { raw: '/init', name: 'init', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('初始化项目')
    })

    it('env 命令应显示环境信息', () => {
      const cmd: ParsedCommand = { raw: '/env', name: 'env', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('环境配置信息')
    })

    it('config 无参数应显示配置', () => {
      const cmd: ParsedCommand = { raw: '/config', name: 'config', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('配置信息')
    })
  })

  describe('数据库命令', () => {
    it('database 无参数应检查连接', () => {
      const cmd: ParsedCommand = { raw: '/database', name: 'database', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('数据库连接')
    })

    it('database 带参数应执行操作', () => {
      const cmd: ParsedCommand = { raw: '/database', name: 'database', args: ['migrate'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('migrate')
    })

    it('db 无参数应显示 schema', () => {
      const cmd: ParsedCommand = { raw: '/db', name: 'db', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('schema')
    })
  })

  describe('frontend-design-skill 命令', () => {
    it('无参数应触发 Skill', () => {
      const cmd: ParsedCommand = { raw: '/frontend-design-skill', name: 'frontend-design-skill', args: [], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('Frontend-design Skill')
      expect(prompt).toContain('production-grade')
    })

    it('带文件引用应包含目标文件', () => {
      const cmd: ParsedCommand = { raw: '/frontend-design-skill', name: 'frontend-design-skill', args: [], fileRefs: ['src/Button.tsx'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('目标文件')
      expect(prompt).toContain('src/Button.tsx')
    })

    it('带参数应包含具体需求', () => {
      const cmd: ParsedCommand = { raw: '/frontend-design-skill', name: 'frontend-design-skill', args: ['dark', 'mode', 'toggle'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('具体需求')
      expect(prompt).toContain('dark mode toggle')
    })
  })

  describe('未知命令', () => {
    it('未知命令应让 AI 尝试执行', () => {
      const cmd: ParsedCommand = { raw: '/mycommand', name: 'mycommand', args: ['arg1'], fileRefs: [] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('请帮我执行')
      expect(prompt).toContain('/mycommand')
    })

    it('未知命令带文件引用应包含在提示词中', () => {
      const cmd: ParsedCommand = { raw: '/mycommand', name: 'mycommand', args: [], fileRefs: ['file.ts'] }
      const prompt = convertCommandToPrompt(cmd)

      expect(prompt).toContain('@file.ts')
    })
  })
})

// ============================================================
// replaceCommandArguments 测试
// ============================================================
describe('replaceCommandArguments', () => {
  describe('$ARGUMENTS 替换', () => {
    it('应替换所有 $ARGUMENTS 占位符', () => {
      const result = replaceCommandArguments('echo $ARGUMENTS', ['hello', 'world'], [])

      expect(result).toBe('echo hello world')
    })

    it('多个 $ARGUMENTS 应全部替换', () => {
      const result = replaceCommandArguments('$ARGUMENTS and $ARGUMENTS', ['a', 'b'], [])

      expect(result).toBe('a b and a b')
    })

    it('无参数时应替换为空字符串', () => {
      const result = replaceCommandArguments('echo $ARGUMENTS', [], [])

      expect(result).toBe('echo ')
    })
  })

  describe('$@ 替换', () => {
    it('应替换 $@ 为所有参数', () => {
      const result = replaceCommandArguments('files: $@', ['a.ts', 'b.ts'], [])

      expect(result).toBe('files: a.ts b.ts')
    })

    it('无参数时应替换为空字符串', () => {
      const result = replaceCommandArguments('files: $@', [], [])

      expect(result).toBe('files: ')
    })
  })

  describe('位置参数替换', () => {
    it('应替换 $1, $2 等位置参数', () => {
      const result = replaceCommandArguments('$1 says $2', ['Alice', 'hello'], [])

      expect(result).toBe('Alice says hello')
    })

    it('超出范围的位置参数应替换为空字符串', () => {
      const result = replaceCommandArguments('$1 $2 $3', ['only', 'two'], [])

      expect(result).toBe('only two ')
    })

    it('应替换 ${n} 形式的位置参数', () => {
      const result = replaceCommandArguments('${1}-${2}-${3}', ['a', 'b', 'c'], [])

      expect(result).toBe('a-b-c')
    })

    it('${n} 超出范围应替换为空字符串', () => {
      const result = replaceCommandArguments('${1} ${2} ${3}', ['only'], [])

      expect(result).toBe('only  ')
    })
  })

  describe('文件引用前缀', () => {
    it('有文件引用时应添加前缀', () => {
      const result = replaceCommandArguments('read the files', [], ['src/a.ts', 'src/b.ts'])

      expect(result.startsWith('@src/a.ts @src/b.ts')).toBe(true)
    })

    it('无文件引用时不应添加前缀', () => {
      const result = replaceCommandArguments('no files', [], [])

      expect(result).toBe('no files')
    })

    it('文件引用应添加到模板前面', () => {
      const result = replaceCommandArguments('content: $ARGUMENTS', ['test'], ['file.ts'])

      expect(result).toBe('@file.ts content: test')
    })
  })

  describe('组合替换', () => {
    it('应同时处理多种占位符', () => {
      const result = replaceCommandArguments(
        '$1: $ARGUMENTS (files: $@)',
        ['name', 'value'],
        ['a.ts']
      )

      expect(result).toBe('@a.ts name: name value (files: name value)')
    })

    it('应处理复杂的模板', () => {
      const result = replaceCommandArguments(
        'prefix ${1} middle $2 suffix $ARGUMENTS',
        ['first', 'second', 'third'],
        []
      )

      expect(result).toBe('prefix first middle second suffix first second third')
    })
  })
})

// ============================================================
// generateCommandsListMessage 测试
// ============================================================
describe('generateCommandsListMessage', () => {
  it('应生成包含内置命令的列表', () => {
    const commands: Command[] = [
      { name: 'test', type: 'builtin', description: '测试命令' },
    ]

    const message = generateCommandsListMessage(commands)

    expect(message).toContain('## 可用命令')
    expect(message).toContain('### 内置命令')
    expect(message).toContain('/test')
    expect(message).toContain('测试命令')
  })

  it('应生成包含自定义命令的列表', () => {
    const commands: Command[] = [
      { name: 'custom', type: 'custom', description: '自定义命令' },
    ]

    const message = generateCommandsListMessage(commands)

    expect(message).toContain('### 自定义命令')
    expect(message).toContain('/custom')
  })

  it('应显示命令参数', () => {
    const commands: Command[] = [
      {
        name: 'cmd',
        type: 'custom',
        description: '带参数的命令',
        params: [{ name: 'arg1' }, { name: 'arg2' }],
      },
    ]

    const message = generateCommandsListMessage(commands)

    expect(message).toContain('`arg1 arg2`')
  })

  it('应同时显示内置和自定义命令', () => {
    const commands: Command[] = [
      { name: 'builtin', type: 'builtin', description: '内置' },
      { name: 'custom', type: 'custom', description: '自定义' },
    ]

    const message = generateCommandsListMessage(commands)

    expect(message).toContain('### 内置命令')
    expect(message).toContain('### 自定义命令')
  })

  it('应包含使用说明', () => {
    const message = generateCommandsListMessage([])

    expect(message).toContain('使用 `/命令名 参数` 来执行命令')
  })

  it('空命令列表应只显示标题和使用说明', () => {
    const message = generateCommandsListMessage([])

    expect(message).toContain('## 可用命令')
    expect(message).not.toContain('### 内置命令')
    expect(message).not.toContain('### 自定义命令')
  })
})

// ============================================================
// generateHelpMessage 测试
// ============================================================
describe('generateHelpMessage', () => {
  it('应包含帮助标题', () => {
    const message = generateHelpMessage()

    expect(message).toContain('## 帮助')
  })

  it('应包含斜杠命令说明', () => {
    const message = generateHelpMessage()

    expect(message).toContain('斜杠命令')
    expect(message).toContain('`/`')
  })

  it('应包含常用命令示例', () => {
    const message = generateHelpMessage()

    expect(message).toContain('/help')
    expect(message).toContain('/commands')
  })

  it('应包含文件引用说明', () => {
    const message = generateHelpMessage()

    expect(message).toContain('文件引用')
    expect(message).toContain('@文件名')
  })

  it('应包含使用示例', () => {
    const message = generateHelpMessage()

    expect(message).toContain('### 示例')
    expect(message).toContain('@README.md')
  })
})
