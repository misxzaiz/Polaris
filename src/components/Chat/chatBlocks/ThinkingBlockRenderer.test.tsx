import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { ThinkingBlockRenderer } from '@/components/Chat/chatBlocks/ThinkingBlockRenderer';
import type { ThinkingBlock } from '@/types';

function makeThinking(content: string, collapsed?: boolean): ThinkingBlock {
  return { type: 'thinking', content, ...(collapsed !== undefined ? { collapsed } : {}) };
}

describe('ThinkingBlockRenderer auto-collapse', () => {
  it('expands while streaming', () => {
    const { container } = render(<ThinkingBlockRenderer block={makeThinking('思考中内容很长啊很长')} isStreaming />);
    // 流式：应展开显示完整内容（可见完整文本，非截断预览）
    expect(container.textContent).toContain('思考中内容很长');
    const body = container.querySelector('div[class*="max-h-"]');
    expect(body).toBeTruthy();
  });

  it('collapses when block.collapsed=true even while streaming', () => {
    const { container } = render(
      <ThinkingBlockRenderer block={makeThinking('思考内容特别长'.repeat(20), true)} isStreaming />
    );
    // collapsed=true 时应折叠：仅显示 60 字预览，不显示完整正文容器
    expect(container.querySelector('div[class*="max-h-"]')).toBeFalsy();
  });
});
