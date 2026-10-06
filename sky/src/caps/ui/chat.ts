/**
 * cap.ui.chat — 聊天渲染配置(AI/用户热调整消息布局)
 *
 * 动作: get/patch/reset
 * 操作 UIState.chat (ChatConfig)
 *
 * 用户可经设置页或 AI 经此 cap 调整:
 * - 消息宽度 (userMaxWidth / assistantMaxWidth)
 * - 工具块折叠状态 (toolCollapsed) + 摘要长度 (toolSummaryLen)
 * - Markdown 渲染开关 (markdownEnabled)
 * - 消息间距 (messageGap) + 字号 (fontSize)
 * - 工具块样式 (toolStyle: inline/card/sidebar)
 * - 工具参数显示完整度 (toolShowFullArgs)
 */

import type { Capability, Value } from '../../contracts.ts';
import { getUiState, setUiState, DEFAULT_CHAT_CONFIG, type ChatConfig } from './state.ts';

export const uiChatCap: Capability = {
  id: 'cap.ui.chat',
  description: 'Chat render config. Actions: get/patch/reset. Configurable: message widths, tool block collapse, markdown toggle, font size, tool style.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'patch', 'reset'] },
      config: { type: 'object', description: 'For patch: partial ChatConfig (any subset of fields)' },
    },
    required: ['action'],
  },
  async invoke(params: Value) {
    const p = params as { action: 'get' | 'patch' | 'reset'; config?: Partial<ChatConfig> };
    const state = getUiState();
    switch (p.action) {
      case 'get':
        return { ok: true, config: state.chat };
      case 'patch': {
        if (!p.config) throw new Error('config required for patch');
        const merged: ChatConfig = { ...state.chat, ...p.config };
        // 校正 toolStyle 枚举
        if (!['inline', 'card', 'sidebar'].includes(merged.toolStyle)) {
          merged.toolStyle = state.chat.toolStyle;
        }
        setUiState({ ...state, chat: merged });
        return { ok: true, applied: true, config: merged };
      }
      case 'reset':
        setUiState({ ...state, chat: { ...DEFAULT_CHAT_CONFIG } });
        return { ok: true, reset: true };
      default:
        throw new Error(`unknown action: ${(p as { action: string }).action}`);
    }
  },
};
