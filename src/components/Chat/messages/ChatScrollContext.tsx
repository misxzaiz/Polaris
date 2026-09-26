/**
 * ChatScrollContext - 将消息列表的滚动控制下发给气泡/卡片内部交互。
 *
 * 场景：补充卡片（SessionSummaryCard）展开/折叠、chips 筛选会改变列表项高度，
 * 触发 useMessageAutoScroll 的 followOutput / ResizeObserver 补偿，导致
 * 「点 chips 后 AI 消息位置闪动」。卡片在交互瞬间调用 suspendFollow(ms) 开启
 * 豁免窗口，窗口内滚动跟随被抑制，用户视角位置保持不动。
 */

import { createContext, useContext } from 'react';

export interface ChatScrollActions {
  /** 开启交互豁免窗口：列表高度将因卡片内部交互变化时调用 */
  suspendFollow: (ms?: number) => void;
}

const ChatScrollContext = createContext<ChatScrollActions | null>(null);

/** 读取滚动控制（无 Provider 时返回空操作，保证卡片可独立使用） */
export function useChatScrollActions(): ChatScrollActions {
  const ctx = useContext(ChatScrollContext);
  if (!ctx) {
    return { suspendFollow: () => {} };
  }
  return ctx;
}

export { ChatScrollContext };
