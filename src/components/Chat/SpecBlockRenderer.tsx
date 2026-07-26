/**
 * 规格驱动开发渲染器（/spec 命令输出）
 *
 * 检测文本内容中的 spec 协议标记（Step X/4），在文本块外层包裹
 * spec 视觉容器：头部规格标识 + 四步进度条 + 步骤标题强调。
 * 内部 Markdown 仍走 ProgressiveStreamingMarkdown，保证流式兼容。
 *
 * 降级：不匹配任何 spec 标记时直接走普通 TextBlockRenderer。
 */

import { memo, useMemo } from 'react';
import { clsx } from 'clsx';
import type { TextBlock } from '@/types';
import { ProgressiveStreamingMarkdown } from '@/utils/lightweightMarkdown';
import { Ruler, Wrench, Code2, SquareCheck } from 'lucide-react';

// ---------- 检测 ----------

/** spec 协议各步骤的模式信息 */
interface SpecStepInfo {
  num: 1 | 2 | 3 | 4;
  label: string;
  emoji: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>;
}
const SPEC_STEPS: readonly SpecStepInfo[] = [
  { num: 1, label: '读规格', emoji: '📐', icon: Ruler },
  { num: 2, label: '实施计划', emoji: '🔨', icon: Wrench },
  { num: 3, label: '编码实施', emoji: '✅', icon: Code2 },
  { num: 4, label: '验证矩阵', emoji: '🎯', icon: SquareCheck },
] as const;

/** 当前步骤号（1-4）；未匹配返回 null */
function parseSpecStep(content: string): number | null {
  const m = content.match(/(?:\d+\/4)\s*[:：]\s*读规格/);
  if (m) return 1;
  const m2 = content.match(/(?:\d+\/4)\s*[:：]\s*(?:实施|生成)\s*计划/);
  if (m2) return 2;
  const m3 = content.match(/(?:\d+\/4)\s*[:：]\s*编码实施/);
  if (m3) return 3;
  const m4 = content.match(/(?:\d+\/4)\s*[:：]\s*验证/);
  if (m4) return 4;
  // 兼容纯 emoji 行：📐 Step X/4
  if (content.includes('📐')) return 1;
  if (content.includes('🔨')) return 2;
  if (content.includes('✅')) return 3;
  if (content.includes('🎯')) return 4;
  return null;
}

/** 从标题行提取规格编号（S00X）和名称 */
function parseSpecTitle(content: string): { id: string; name: string } | null {
  const m = content.match(/^##?\s*规格[：:]\s*(S\d{3})\s*(.*)/m);
  if (m) return { id: m[1], name: m[2].replace(/[（(].*$/, '').trim() };
  // 回退：在正文中找 S 编号
  const m2 = content.match(/\b(S\d{3})\b/);
  if (m2) return { id: m2[1], name: '' };
  return null;
}

/** 是否命中 spec 协议输出 */
export function isSpecProtocolOutput(content?: string): boolean {
  if (!content) return false;
  return parseSpecStep(content) !== null || !!parseSpecTitle(content);
}

// ---------- 渲染 ----------

const STEP_CSS: Record<number, { label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { size?: number }>; color: string }> = {
  1: { label: SPEC_STEPS[0].label, icon: SPEC_STEPS[0].icon, color: 'text-primary' },
  2: { label: SPEC_STEPS[1].label, icon: SPEC_STEPS[1].icon, color: 'text-warning' },
  3: { label: SPEC_STEPS[2].label, icon: SPEC_STEPS[2].icon, color: 'text-success' },
  4: { label: SPEC_STEPS[3].label, icon: SPEC_STEPS[3].icon, color: 'text-accent-ai' },
};

export const SpecBlockRenderer = memo(function SpecBlockRenderer({
  block,
  isStreaming = false,
}: {
  block: TextBlock;
  isStreaming?: boolean;
}) {
  const step = useMemo(() => parseSpecStep(block.content), [block.content]);
  const title = useMemo(() => parseSpecTitle(block.content), [block.content]);

  // 未命中 spec 标记：不渲染容器，直接返回 null 让调用方降级
  if (step === null) return null;

  const stepInfo = STEP_CSS[step] ?? STEP_CSS[1];
  const StepIcon = stepInfo.icon;

  return (
    <div className="my-2 rounded-lg border overflow-hidden shadow-soft" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle/30">
        <StepIcon size={16} className={stepInfo.color} />
        <span className="font-medium text-sm">规格驱动开发</span>
        {title && (
          <span className="ml-1 text-xs font-mono text-text-tertiary">
            {title.id}{title.name ? ` · ${title.name}` : ''}
          </span>
        )}
        <span className="ml-auto text-xs text-text-muted tabular-nums">
          Step {step}/4
        </span>
      </div>

      {/* 四步进度条 */}
      <div className="flex items-center gap-0 px-3 py-1.5 border-b border-border-subtle/20 bg-surface/20">
        {SPEC_STEPS.map((s, i) => {
          const isCurrent = s.num === step;
          const isDone = s.num < step;
          const dot = isCurrent
            ? 'bg-primary text-primary ring-2 ring-primary/30'
            : isDone
              ? 'bg-success/20 text-success'
              : 'bg-background-base text-text-tertiary';
          const label = isCurrent
            ? 'text-primary font-medium'
            : isDone
              ? 'text-success'
              : 'text-text-tertiary';
          return (
            <div key={s.num} className="flex-1 flex items-center gap-1.5 min-w-0">
              <span className={clsx(
                'inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium shrink-0 transition-all',
                dot,
              )}>
                {isDone ? '✓' : s.num}
              </span>
              <span className={clsx('text-[11px] truncate', label)} title={s.label}>
                {s.label}
              </span>
              {i < SPEC_STEPS.length - 1 && (
                <span className="flex-1 h-px bg-border-subtle/30 mx-1" />
              )}
            </div>
          );
        })}
      </div>

      {/* 内容：流式/非流式统一走 ProgressiveStreamingMarkdown */}
      <div className="px-3 py-2 chat-prose prose prose-invert max-w-none">
        <ProgressiveStreamingMarkdown content={block.content} completed={!isStreaming} />
      </div>
    </div>
  );
});
