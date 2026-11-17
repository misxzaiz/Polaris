/**
 * 专家类型定义（W4-7：AgentCatalogEntry 随 agentStore 出仓 chat-desk，
 * 宿主保留类型单源供协议/文档引用）
 */

export interface AgentCatalogEntry {
  slug: string
  name: string
  description: string
  emoji: string
  color: string
  division: string
}
