/**
 * PolarisSystemPromptBridge — 桥接 DSH ctx.systemPrompt 到 Polaris 提示词构建
 *
 * DSH 插件的 ctx.systemPrompt.section() 注册 → Polaris 的 prompt 构建系统。
 * 当前为最小实现，只支持 section 注册。
 */

export class PolarisSystemPromptBridge {
  private sections: Array<{ key: string; content: string; order: number }> = []

  section(key: string, content: string, options?: { order?: number }): void {
    this.sections.push({ key, content, order: options?.order ?? 100 })
    this.sections.sort((a, b) => a.order - b.order)
  }

  remove(key: string): void {
    this.sections = this.sections.filter((s) => s.key !== key)
  }

  getSections(): string[] {
    return this.sections.map((s) => s.content)
  }
}