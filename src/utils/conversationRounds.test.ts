import { describe, expect, it } from 'vitest';
import type { AssistantChatMessage, ChatMessage, SystemChatMessage, ToolChatMessage, UserChatMessage } from '../types';
import {
  findCurrentRoundIndexForRange,
  getRoundBounds,
  getRoundScrollTargetIndex,
  groupConversationRounds,
} from './conversationRounds';

function user(id: string, content: string): UserChatMessage {
  return {
    id,
    type: 'user',
    content,
    timestamp: '2026-05-16T00:00:00.000Z',
  };
}

function assistant(id: string, content: string): AssistantChatMessage {
  return {
    id,
    type: 'assistant',
    blocks: [{ type: 'text', content }],
    timestamp: '2026-05-16T00:00:01.000Z',
  };
}

function system(id: string, content: string): SystemChatMessage {
  return {
    id,
    type: 'system',
    content,
    timestamp: '2026-05-16T00:00:02.000Z',
  };
}

function tool(id: string): ToolChatMessage {
  return {
    id,
    type: 'tool',
    timestamp: '2026-05-16T00:00:03.000Z',
    toolId: id,
    toolName: 'Read',
    status: 'completed',
    summary: 'read file',
    startedAt: '2026-05-16T00:00:03.000Z',
  };
}

describe('conversationRounds navigation helpers', () => {
  it('keeps system messages inside the current round bounds', () => {
    const messages: ChatMessage[] = [
      user('u1', 'first question'),
      system('s1', 'system note'),
      assistant('a1', 'first answer'),
      user('u2', 'second question'),
      assistant('a2', 'second answer'),
    ];

    const rounds = groupConversationRounds(messages);

    expect(rounds).toHaveLength(2);
    expect(rounds[0].messageIndices).toEqual([0, 1, 2]);
    expect(rounds[1].messageIndices).toEqual([3, 4]);
    expect(getRoundBounds(rounds[0])).toEqual({ startIndex: 0, endIndex: 2 });
  });

  it('scrolls a round to its user message instead of the assistant reply', () => {
    const rounds = groupConversationRounds([
      user('u1', 'question'),
      assistant('a1', 'answer'),
    ]);

    expect(getRoundScrollTargetIndex(rounds[0])).toBe(0);
  });

  it('highlights the round containing the viewport center', () => {
    const rounds = groupConversationRounds([
      user('u1', 'first question'),
      system('s1', 'system note'),
      assistant('a1', 'first answer'),
      user('u2', 'second question'),
      assistant('a2', 'second answer'),
    ]);

    expect(findCurrentRoundIndexForRange(rounds, 2, 4)).toBe(1);
  });

  it('falls back to the first overlapping round when center is between rounds', () => {
    const rounds = groupConversationRounds([
      user('u1', 'first question'),
      assistant('a1', 'first answer'),
      tool('t1'),
      user('u2', 'second question'),
      assistant('a2', 'second answer'),
    ]);

    expect(findCurrentRoundIndexForRange(rounds, 1, 3)).toBe(0);
  });
});
