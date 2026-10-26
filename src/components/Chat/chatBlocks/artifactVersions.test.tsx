import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  ArtifactVersionGate,
  ArtifactVersionsProvider,
  buildArtifactBlockFromData,
  buildArtifactVersionsMap,
  normalizeArtifactLikeBlock,
} from '@/components/Chat/chatBlocks/artifactVersions';
import type { ArtifactPreviewBlock, ChatMessage, ContentBlock, PluginCardBlock } from '@/types';

function artifactBlock(overrides: Partial<ArtifactPreviewBlock>): ArtifactPreviewBlock {
  return {
    type: 'artifact_preview',
    previewId: overrides.previewId ?? `pid-${Math.random().toString(36).slice(2)}`,
    title: '原型',
    contentType: 'html',
    html: '<html><body>page</body></html>',
    ...overrides,
  } as ArtifactPreviewBlock;
}

function assistantMsg(blocks: ContentBlock[], id: string): ChatMessage {
  return { id, type: 'assistant', timestamp: '2026-10-26T10:00:00Z', blocks } as ChatMessage;
}

function pluginCard(data: Record<string, unknown>, id: string): PluginCardBlock {
  return {
    type: 'plugin_card',
    id,
    pluginId: 'polaris-prd-preview',
    cardId: 'prd-preview',
    toolName: 'mcp__polaris-prd-preview__preview_html',
    mode: 'result',
    data,
  } as unknown as PluginCardBlock;
}

describe('buildArtifactBlockFromData / normalizeArtifactLikeBlock', () => {
  it('完整 artifact data（html+previewId）→ 映射为 ArtifactPreviewBlock', () => {
    const block = buildArtifactBlockFromData({
      previewId: 'pid-1',
      title: '  ',
      html: '<html></html>',
      version: 2,
      versionLabel: 'v2',
      requirementId: 'REQ-1',
    });
    expect(block).not.toBeNull();
    expect(block!.title).toBe('PRD Prototype'); // 空白标题回落默认
    expect(block!.version).toBe(2);
    expect(block!.requirementId).toBe('REQ-1');
  });

  it('缺 html 或 previewId 的投影 data → null', () => {
    expect(buildArtifactBlockFromData({ previewId: 'pid-1' })).toBeNull();
    expect(buildArtifactBlockFromData({ html: '<html></html>' })).toBeNull();
    expect(buildArtifactBlockFromData(null)).toBeNull();
  });

  it('normalize：artifact_preview 直通；plugin_card 经 data 归一化；其余 null', () => {
    const direct = artifactBlock({ previewId: 'pid-d' });
    expect(normalizeArtifactLikeBlock(direct)).toBe(direct);

    const card = pluginCard({ previewId: 'pid-c', html: '<html></html>', requirementId: 'REQ-9' }, 'c1');
    const normalized = normalizeArtifactLikeBlock(card);
    expect(normalized?.previewId).toBe('pid-c');
    expect(normalized?.requirementId).toBe('REQ-9');

    expect(normalizeArtifactLikeBlock({ type: 'text', content: 'hi' } as ContentBlock)).toBeNull();
    // 投影形态（缺 html）的 plugin_card 不参与分组
    expect(normalizeArtifactLikeBlock(pluginCard({ previewId: 'pid-p' }, 'p1'))).toBeNull();
  });
});

describe('buildArtifactVersionsMap', () => {
  it('按 requirementId 跨消息归集并按版本升序', () => {
    const messages: ChatMessage[] = [
      assistantMsg([artifactBlock({ previewId: 'a2', version: 2, requirementId: 'REQ-A' })], 'm1'),
      assistantMsg([
        artifactBlock({ previewId: 'a1', version: 1, requirementId: 'REQ-A' }),
        artifactBlock({ previewId: 'b1', version: 1, requirementId: 'REQ-B' }),
      ], 'm2'),
    ];
    const map = buildArtifactVersionsMap(messages);
    expect(map.get('REQ-A')!.map((b) => b.previewId)).toEqual(['a1', 'a2']);
    expect(map.get('REQ-B')!.map((b) => b.previewId)).toEqual(['b1']);
  });

  it('缺 requirementId 的块与 user 消息不参与分组', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', type: 'user', timestamp: 't', content: 'hi' } as ChatMessage,
      assistantMsg([
        artifactBlock({ previewId: 'x1' }), // 无 requirementId
        pluginCard({ previewId: 'x2', html: '<html></html>' }, 'p1'), // 无 requirementId
      ], 'm1'),
    ];
    const map = buildArtifactVersionsMap(messages);
    expect(map.size).toBe(0);
  });
});

describe('ArtifactVersionGate 折叠行为', () => {
  const v1 = artifactBlock({ previewId: 'v1', version: 1, versionLabel: 'v1', requirementId: 'REQ-A', title: '旧版' });
  const v2 = artifactBlock({ previewId: 'v2', version: 2, versionLabel: 'v2', requirementId: 'REQ-A', title: '新版' });

  it('历史版本 → 折叠摘要行，不渲染 children', () => {
    const map = new Map([[ 'REQ-A', [v1, v2] ]]);
    render(
      <ArtifactVersionsProvider value={map}>
        <ArtifactVersionGate block={v1}>
          <div data-testid="real-card">整张卡</div>
        </ArtifactVersionGate>
      </ArtifactVersionsProvider>
    );
    expect(screen.queryByTestId('real-card')).toBeNull();
    expect(screen.getByText('旧版')).toBeTruthy();
    expect(screen.getByText(/已并入 v2/)).toBeTruthy();
  });

  it('最新版本 → 原样渲染 children', () => {
    const map = new Map([[ 'REQ-A', [v1, v2] ]]);
    render(
      <ArtifactVersionsProvider value={map}>
        <ArtifactVersionGate block={v2}>
          <div data-testid="real-card">整张卡</div>
        </ArtifactVersionGate>
      </ArtifactVersionsProvider>
    );
    expect(screen.getByTestId('real-card')).toBeTruthy();
  });

  it('无 Provider（旁路渲染）→ 永远透传，行为退化为原版', () => {
    render(
      <ArtifactVersionGate block={v1}>
        <div data-testid="real-card">整张卡</div>
      </ArtifactVersionGate>
    );
    expect(screen.getByTestId('real-card')).toBeTruthy();
  });

  it('单版本组 → 不折叠', () => {
    const map = new Map([[ 'REQ-A', [v2] ]]);
    render(
      <ArtifactVersionsProvider value={map}>
        <ArtifactVersionGate block={v2}>
          <div data-testid="real-card">整张卡</div>
        </ArtifactVersionGate>
      </ArtifactVersionsProvider>
    );
    expect(screen.getByTestId('real-card')).toBeTruthy();
  });
});
