/**
 * Token Manager - 统一的 Token 追踪和成本管理
 *
 * 提供以下功能：
 * - Token 计数估算
 * - 成本追踪
 * - 使用统计
 * - 多引擎支持
 *
 * @author Polaris Team
 * @since 2025-01-24
 */

/**
 * Token 使用统计
 */
export interface TokenUsage {
  /** 输入 tokens */
  promptTokens: number
  /** 输出 tokens */
  completionTokens: number
  /** 总 tokens */
  totalTokens: number
  /** 预估成本（美元） */
  estimatedCost?: number
}

/**
 * 引擎定价信息
 */
interface EnginePricing {
  /** 输入价格（美元/1M tokens） */
  inputPrice: number
  /** 输出价格（美元/1M tokens） */
  outputPrice: number
  /** 货币 */
  currency: string
}

/**
 * 引擎定价配置
 */
const ENGINE_PRICING: Record<string, EnginePricing> = {
  'gpt-4': {
    inputPrice: 30.0,
    outputPrice: 60.0,
    currency: 'USD',
  },
  'gpt-4o': {
    inputPrice: 5.0,
    outputPrice: 15.0,
    currency: 'USD',
  },
  'claude-3-5-sonnet': {
    inputPrice: 3.0,
    outputPrice: 15.0,
    currency: 'USD',
  },
}

/**
 * Token 追踪器
 */
export class TokenTracker {
  /** 会话级别的使用统计 */
  private sessionStats = new Map<string, TokenUsage>()

  /** 全局累计统计 */
  private globalStats: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }

  /**
   * 记录 token 使用
   *
   * @param sessionId - 会话 ID
   * @param model - 模型名称
   * @param promptTokens - 输入 tokens
   * @param completionTokens - 输出 tokens
   */
  recordUsage(
    sessionId: string,
    model: string,
    promptTokens: number,
    completionTokens: number
  ): void {
    const totalTokens = promptTokens + completionTokens
    const pricing = ENGINE_PRICING[model]

    const cost = pricing
      ? (promptTokens * pricing.inputPrice + completionTokens * pricing.outputPrice) / 1_000_000
      : 0

    // 更新会话统计
    const current = this.sessionStats.get(sessionId) || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }

    this.sessionStats.set(sessionId, {
      promptTokens: current.promptTokens + promptTokens,
      completionTokens: current.completionTokens + completionTokens,
      totalTokens: current.totalTokens + totalTokens,
      estimatedCost: (current.estimatedCost || 0) + cost,
    })

    // 更新全局统计
    this.globalStats.promptTokens += promptTokens
    this.globalStats.completionTokens += completionTokens
    this.globalStats.totalTokens += totalTokens
  }

  /**
   * 获取会话统计
   *
   * @param sessionId - 会话 ID
   * @returns Token 使用统计
   */
  getSessionUsage(sessionId: string): TokenUsage | undefined {
    return this.sessionStats.get(sessionId)
  }

  /**
   * 获取全局统计
   *
   * @returns 全局 Token 使用统计
   */
  getGlobalUsage(): TokenUsage {
    return { ...this.globalStats }
  }

  /**
   * 重置会话统计
   *
   * @param sessionId - 会话 ID
   */
  resetSession(sessionId: string): void {
    this.sessionStats.delete(sessionId)
  }

  /**
   * 重置所有统计
   */
  reset(): void {
    this.sessionStats.clear()
    this.globalStats = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }
  }

  /**
   * 计算成本对比（与 Claude 对比）
   *
   * @returns 成本节省信息
   */
  compareWithClaude(): {
    deepSeekCost: number
    estimatedClaudeCost: number
    savings: number
    savingsPercent: number
  } {
    const deepSeekCost = this.globalStats.totalTokens > 0
      ? (this.globalStats.promptTokens * 0.14 + this.globalStats.completionTokens * 0.28) / 1_000_000
      : 0

    // Claude 约贵 10 倍
    const estimatedClaudeCost = deepSeekCost * 10
    const savings = estimatedClaudeCost - deepSeekCost
    const savingsPercent = estimatedClaudeCost > 0 ? (savings / estimatedClaudeCost) * 100 : 0

    return {
      deepSeekCost,
      estimatedClaudeCost,
      savings,
      savingsPercent,
    }
  }

  /**
   * 估算文本的 token 数
   *
   * 使用简化算法：中文约 2 字符/token，英文约 4 字符/token
   *
   * @param text - 要估算的文本
   * @returns 估算的 token 数
   */
  static estimateTextTokens(text: string): number {
    if (!text) return 0

    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars

    return Math.ceil(chineseChars / 2 + otherChars / 4)
  }
}

/**
 * 全局 Token 追踪器实例
 */
export const tokenTracker = new TokenTracker()
