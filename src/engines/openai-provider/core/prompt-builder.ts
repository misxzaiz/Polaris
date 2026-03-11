/**
 * Prompt Builder - 简化版
 *
 * 为 OpenAI Provider 提供基础的系统提示词
 *
 * @author Polaris Team
 * @since 2025-03-11
 */

import { invoke } from '@tauri-apps/api/core'
import { type Intent } from './intent-detector'

/**
 * Prompt Builder 配置
 */
export interface PromptBuilderConfig {
  /** 工作区目录 */
  workspaceDir?: string
  /** 是否启用详细日志 */
  verbose?: boolean
}

/**
 * Prompt Builder - 简化版
 */
export class PromptBuilder {
  private config: PromptBuilderConfig

  constructor(config?: PromptBuilderConfig) {
    this.config = config || {}
  }

  /**
   * 构建基础提示词
   */
  buildBasePrompt(): string {
    return `你是 Polaris 编程助手，一个专业的 AI 编程助手。

核心原则：
1. 简单问题直接回答，不要过度分析
2. 只在必要时使用工具
3. 保持简洁明了
4. 优先考虑代码质量和可维护性
5. 执行 shell 命令时不要使用 \`cd /d\` 或 \`cd ... &&\`，工作目录已设置为工作区目录
`.trim()
  }

  /**
   * 构建完整的提示词（包含工作区规则）
   */
  async buildFullPrompt(_userMessage: string, _intent?: Intent): Promise<string> {
    const basePrompt = this.buildBasePrompt()

    try {
      const { workspaceDir } = this.config
      if (!workspaceDir) {
        return basePrompt
      }

      // 尝试读取 CLAUDE.md
      const claudeMdPath = `${workspaceDir}/CLAUDE.md`
      const claudeMd = await invoke<string>('read_file', { path: claudeMdPath })

      return `${basePrompt}\n\n项目规则：\n${claudeMd}`
    } catch {
      // CLAUDE.md 不存在，返回基础提示词
      return basePrompt
    }
  }
}
