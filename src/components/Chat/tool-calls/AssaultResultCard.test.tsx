/**
 * AssaultResultCard 组件测试
 *
 * 测试范围:
 * - 解析:多种 tool_result output 格式(标准/嵌套/直接 result/失败降级)
 * - 渲染:solved/open/needsHumanReview 三态、方法族注册表、时间线、survivor
 * - 降级:解析失败走 ToolCallBlockRenderer
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssaultResultCard, isAssaultWorkflowOutput } from './AssaultResultCard';
import type { ToolCallBlock } from '@/types';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mock ToolCallBlockRenderer(降级路径)
vi.mock('./chatBlocks/ToolCallBlockRenderer', () => ({
  ToolCallBlockRenderer: ({ block }: { block: ToolCallBlock }) => (
    <div data-testid="fallback-renderer">fallback:{block.id}</div>
  ),
}));

function makeBlock(output?: string, status: ToolCallBlock['status'] = 'completed'): ToolCallBlock {
  return {
    type: 'tool_call',
    id: 'call_test',
    name: 'workflow',
    input: {},
    status,
    startedAt: '2026-07-25T00:00:00Z',
    output,
  };
}

const STANDARD_OUTPUT = JSON.stringify({
  summary: 'CDC assault',
  agentCount: 9,
  totalTokens: 217218,
  totalToolCalls: 19,
  logs: [
    'A.profile=root-cause problem.len=80',
    'Round 1 active: race,cache,state-machine',
    'family cache blocked: theorem-strength gap',
    'SURVIVOR: race 2/2',
    'STATE_SNAPSHOT [{"key":"race","blocked":false,"attempts":1,"lastNewMechanism":null},{"key":"cache","blocked":true,"attempts":1,"lastNewMechanism":null},{"key":"state-machine","blocked":false,"attempts":1,"lastNewMechanism":null}]',
    'Round 1 done, not converged',
  ],
  result: {
    status: 'solved',
    needsHumanReview: false,
    family: 'race',
    artifacts: ['parseInt(string, radix) 签名错位'],
    acceptanceArtifact: 'node -e "console.log([1,2,3].map(parseInt))"',
    rounds: 1,
  },
  workflowProgress: [],
});

describe('AssaultResultCard', () => {
  it('解析标准 workflow output 并渲染 solved 态', () => {
    const block = makeBlock(STANDARD_OUTPUT);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText('硬问题攻坚')).toBeTruthy();
    expect(screen.getByText('已收敛')).toBeTruthy();
    expect(screen.getByText(/survivor 方法族/)).toBeTruthy();
    expect(screen.getAllByText('race').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/9 agents/)).toBeTruthy();
    expect(screen.getByText(/217k tokens/)).toBeTruthy();
    expect(screen.getByText(/1 survivor/)).toBeTruthy();
    expect(screen.getByText(/1 blocked/)).toBeTruthy();
  });

  it('渲染方法族注册表含 blocked 标记', () => {
    const block = makeBlock(STANDARD_OUTPUT);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText('cache')).toBeTruthy();
    expect(screen.getByText('state-machine')).toBeTruthy();
  });

  it('渲染 needsHumanReview 高风险提示', () => {
    const output = JSON.stringify({
      ...JSON.parse(STANDARD_OUTPUT),
      result: { ...JSON.parse(STANDARD_OUTPUT).result, needsHumanReview: true },
    });
    const block = makeBlock(output);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText(/需人工复核/)).toBeTruthy();
    expect(screen.getByText(/高风险结论/)).toBeTruthy();
  });

  it('渲染 open 态(未收敛)展示最强已证', () => {
    const output = JSON.stringify({
      summary: 'assault',
      logs: ['Round 1 active: race', 'Round 1 done, not converged'],
      result: { status: 'open', rounds: 2, strongest: '依赖图环检测成立', gap: '兼容性矩阵构造' },
    });
    const block = makeBlock(output);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText('未收敛')).toBeTruthy();
    expect(screen.getByText(/依赖图环检测成立/)).toBeTruthy();
  });

  it('兼容嵌套 text 字段格式', () => {
    const nested = JSON.stringify({ text: STANDARD_OUTPUT });
    const block = makeBlock(nested);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText('已收敛')).toBeTruthy();
  });

  it('兼容 result 直接作为顶层对象', () => {
    const direct = JSON.stringify({
      status: 'solved',
      family: 'race',
      artifacts: ['x'],
      acceptanceArtifact: 'node -e "1"',
      rounds: 1,
    });
    const block = makeBlock(direct);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText('已收敛')).toBeTruthy();
  });

  it('解析失败降级为 ToolCallBlockRenderer', () => {
    const block = makeBlock('not valid json {{{');
    render(<AssaultResultCard block={block} />);
    expect(screen.getByTestId('fallback-renderer')).toBeTruthy();
  });

  it('空 output 降级', () => {
    const block = makeBlock(undefined);
    render(<AssaultResultCard block={block} />);
    expect(screen.getByTestId('fallback-renderer')).toBeTruthy();
  });

  it('运行中态展示 spinner 文案', () => {
    const block = makeBlock(STANDARD_OUTPUT, 'running');
    render(<AssaultResultCard block={block} />);
    expect(screen.getByText('运行中')).toBeTruthy();
  });

  describe('isAssaultWorkflowOutput 路由判断', () => {
    it('攻坚 workflow output 返回 true', () => {
      expect(isAssaultWorkflowOutput(STANDARD_OUTPUT)).toBe(true);
    });

    it('deep-research / code-review 等非攻坚 workflow 返回 false', () => {
      const deepResearchOutput = JSON.stringify({
        summary: 'deep research report',
        logs: ['searching...', 'synthesizing...'],
        result: { findings: ['x', 'y'], topic: 'AI search' },  // 无 status, 非攻坚格式
      });
      expect(isAssaultWorkflowOutput(deepResearchOutput)).toBe(false);
    });

    it('纯文本 output 返回 false', () => {
      expect(isAssaultWorkflowOutput('workflow completed')).toBe(false);
    });

    it('无 logs 无 result 的 workflow 返回 false', () => {
      expect(isAssaultWorkflowOutput(JSON.stringify({ summary: 'empty' }))).toBe(false);
    });
  });
});
