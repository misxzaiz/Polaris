/* ============================================================
   reply-summary 原型示例数据
   模拟一条 AI 回复的真实内容块：
   - thinking（理解分析）
   - tool_call → 变更文件（apply_patch / edit / write）
   - artifact_preview（PRD 原型预览）
   - plugin_card / artifact_preview（MCP 产物）
   ============================================================ */

window.DEMO_DATA = {
  // 理解分析（thinking 块，1~2 条）
  thinking: [
    '用户希望给每条 AI 回复后追加一张补充卡片，收纳理解分析、变更文件与产物预览。考虑到消息内已有"运行过程已折叠"卡片，补充卡片形态应与其同族：一行汇总 + 点击展开。宽度必须与正文一致，避免独立的 ml 缩进导致错位。思考块数量较多时以"思考 N · 已折叠"单行呈现，展开后逐条展示完整推理。',
  ],

  // 变更文件（来自 apply_patch / edit / write 工具调用）
  files: [
    { name: 'SessionSummaryCard.tsx', dir: 'src/components/Chat/chatBubbles/', changeType: 'created', content: 'export const SessionSummaryCard = memo(...)' },
    { name: 'AssistantBubble.tsx', dir: 'src/components/Chat/chatBubbles/', changeType: 'modified', diff: '+      <SessionSummaryCard blocks={message.blocks} />\n-      <SessionSummaryCard messageId={message.id} />' },
    { name: 'blockGrouping.tsx', dir: 'src/components/Chat/tool-calls/', changeType: 'modified', diff: '+export function extractFileChanges(blocks: ContentBlock[]): FileChange[] {\n-  function extractFileChanges(blocks: ContentBlock[]): FileChange[] {' },
    { name: 'chat.json', dir: 'src/locales/zh-CN/', changeType: 'modified', diff: '+  "summaryCard": { "collapsedLabel": "理解分析已折叠" }' },
  ],

  // PRD 原型预览（artifact_preview 块）
  prd: {
    title: 'PRD Prototype v2 · 需求看板首页',
    description: '用户中心 · 需求列表 · 新建流程一站式预览',
    version: 'v2',
    createdAt: '2024-06-02 14:20',
    size: '18.4 KB',
    requirementId: 'REQ-2024-001',
    html: `<div style="font-family:system-ui;padding:24px;background:#fff;color:#111;height:100%">
      <h2 style="margin-top:0">PRD Prototype v2</h2>
      <p style="color:#555">需求：用户中心 · 需求列表 · 新建流程</p>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px">
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px"><b>需求列表</b><div style="color:#888;font-size:12px;margin-top:4px">支持筛选 / 排序 / 分页</div></div>
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px"><b>新建流程</b><div style="color:#888;font-size:12px;margin-top:4px">分步表单 + 草稿保存</div></div>
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px"><b>详情页</b><div style="color:#888;font-size:12px;margin-top:4px">评论 / 状态流转 / 附件</div></div>
      </div>
      <div style="margin-top:16px;border:1px solid #e2e8f0;border-radius:8px;padding:12px;color:#888;font-size:12px">（示例 HTML 占位 · 真实 iframe 沙箱渲染同源内容）</div>
    </div>`,
  },

  // MCP 产物（plugin_card → PRD 预览 / 其它工具产物）
  mcp: [
    { name: 'code-review-report', title: '代码审查报告', summary: '3 个严重问题 · 5 个建议', color: 'green' },
    { name: 'mermaid-flow', title: '时序图 · 会话补充卡片交互', summary: 'mermaid 渲染', color: 'cyan' },
  ],

  // 助手回复正文（原型里作为上文展示，供对照宽度）
  assistantText: `好的，已按你的要求整理了方案。补充卡片会放在每条 AI 回复之后，形态与"运行过程已折叠"保持一致。具体内容分区见下方卡片，点击可展开查看细节。`,
}