/**
 * 动态岛 v2 展开态面板 —— 按紧急度分层
 *
 *   需要你（urgent） → 运行中 / 失败 → 已完成（折叠） → 底部水位条
 *
 * 定位能力已移除（v2 用户反馈）：展开即详情，不跳转消息流。
 * urgent 卡直接内联审批（批准 / 拒绝 / 跳过），无需回到消息流操作。
 * 全部图标使用 lucide-react 组件，无 emoji。
 */

import { useState } from 'react';
import { clsx } from 'clsx';
import {
  ListTodo,
  Bot,
  Workflow,
  LoaderCircle,
  CircleAlert,
  CircleCheck,
  ShieldAlert,
  CircleHelp,
  ClipboardList,
  ChevronRight,
  X,
  Check,
  Circle,
} from 'lucide-react';
import { formatDuration, formatTokens, type ContextWater, type RuntimeCard, type TaskRow, type UrgentCard } from './useRuntimeSummary';

interface DynamicIslandExpandedProps {
  urgent: UrgentCard[];
  runningCards: RuntimeCard[];
  failedCards: RuntimeCard[];
  doneCards: RuntimeCard[];
  doneGroupOpen: boolean;
  onToggleDoneGroup: () => void;
  onClose: () => void;
  elapsedMs: number;
  water: ContextWater | null;
  onUrgentDecision: (card: UrgentCard, approved: boolean) => void;
}

export function DynamicIslandExpanded({
  urgent,
  runningCards,
  failedCards,
  doneCards,
  doneGroupOpen,
  onToggleDoneGroup,
  onClose,
  elapsedMs,
  water,
  onUrgentDecision,
}: DynamicIslandExpandedProps) {
  return (
    <div className="island-panel">
      <div className="island-panel-inner">
        {/* 面板头 */}
        <div className="island-panel-head">
          <span className="island-panel-title">运行进度</span>
          <span className="island-panel-time">{formatDuration(elapsedMs)}</span>
          <button className="island-close" onClick={onClose} aria-label="收起">
            <X />
          </button>
        </div>

        {/* 需要你：最优先 */}
        {urgent.length > 0 && (
          <div className="island-urgent-sec">
            <div className="island-sec-head">
              <span className="island-sec-head-ico"><CircleAlert /></span>
              <span>需要你</span>
              {urgent.length > 1 && <span className="island-sec-head-count">{urgent.length}</span>}
            </div>
            {urgent.map(card => (
              <UrgentCardItem key={card.id} card={card} onDecision={onUrgentDecision} />
            ))}
          </div>
        )}

        {/* 失败置顶 */}
        {failedCards.map((card, i) => (
          <RuntimeCardItem key={`fail-${card.summary}-${i}`} card={card} failed />
        ))}

        {/* 运行中 */}
        {runningCards.map((card, i) => (
          <RuntimeCardItem key={`run-${card.summary}-${i}`} card={card} />
        ))}

        {/* 空态 */}
        {urgent.length === 0 &&
          failedCards.length === 0 &&
          runningCards.length === 0 &&
          doneCards.length === 0 && (
            <div className="island-empty">当前无运行态</div>
          )}

        {/* 已完成：折叠分组 */}
        {doneCards.length > 0 && (
          <div className="island-done-group">
            <button className="island-done-head" onClick={onToggleDoneGroup}>
              <span className={clsx('island-done-chev', doneGroupOpen && 'island-done-chev-open')}>
                <ChevronRight />
              </span>
              <span>已完成</span>
              <span className="island-done-head-count">{doneCards.length}</span>
            </button>
            {doneGroupOpen && (
              <div className="island-done-list">
                {doneCards.map((card, i) => (
                  <DoneRow key={`done-${card.summary}-${i}`} card={card} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* 底部水位条 */}
        {water && <WaterBar water={water} />}
      </div>
    </div>
  );
}

/** 需要你：权限 / 问题 / 计划审批卡 */
function UrgentCardItem({
  card,
  onDecision,
}: {
  card: UrgentCard;
  onDecision: (card: UrgentCard, approved: boolean) => void;
}) {
  const Icon =
    card.kind === 'permission'
      ? ShieldAlert
      : card.kind === 'question'
        ? CircleHelp
        : ClipboardList;

  return (
    <div className="island-card island-urgent">
      <div className="u-top">
        <span className="u-ico"><Icon /></span>
        <span className="u-title">{card.summary}</span>
        {card.count != null && card.count > 1 && <span className="u-count">{card.count} 项</span>}
      </div>
      {card.detail && <div className="u-desc">{card.detail}</div>}
      <div className="u-actions">
        {card.kind === 'question' ? (
          <button
            className="island-btn island-btn-primary"
            onClick={() => onDecision(card, false)}
            title="跳过问题，稍后在消息流中回答"
          >
            <Check /> 跳过
          </button>
        ) : (
          <>
            <button className="island-btn island-btn-primary" onClick={() => onDecision(card, true)}>
              <Check /> 批准
            </button>
            <button className="island-btn island-btn-danger" onClick={() => onDecision(card, false)}>
              <X /> 拒绝
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 运行态卡片（任务 / agent / workflow / progress） */
function RuntimeCardItem({ card, failed = false }: { card: RuntimeCard; failed?: boolean }) {
  const Icon =
    card.kind === 'task'
      ? ListTodo
      : card.kind === 'agent'
        ? Bot
        : card.kind === 'workflow'
          ? Workflow
          : LoaderCircle;

  const iconCls =
    card.kind === 'agent'
      ? 'r-ico-agent'
      : card.kind === 'task'
        ? 'r-ico-task'
        : card.kind === 'workflow'
          ? 'r-ico-workflow'
          : 'r-ico-progress';

  return (
    <div className={clsx('island-card', failed && 'island-fail')}>
      <div className="r-top">
        <span className={clsx('r-ico', iconCls)}>
          <Icon className={card.kind === 'progress' && !failed ? 'island-spin' : undefined} />
        </span>
        <span className="r-title">{card.summary}</span>
        {card.meta && <span className="r-meta">{card.meta}</span>}
      </div>
      {card.percent != null && (
        <div className="r-bar">
          <i style={{ width: `${Math.max(0, Math.min(100, card.percent))}%` }} />
        </div>
      )}
      {card.detail && <div className="r-detail">{card.detail}</div>}
      {card.items && card.items.length > 0 && (
        <div className="island-task-list">
          {card.items.map(item => (
            <TaskRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 任务清单单行 */
function TaskRow({ item }: { item: TaskRow }) {
  const Icon =
    item.status === 'done'
      ? CircleCheck
      : item.status === 'active'
        ? LoaderCircle
        : item.status === 'blocked'
          ? CircleAlert
          : Circle;

  return (
    <div className="island-task-row">
      <span className={clsx('t-dot', `t-dot-${item.status}`)}>
        <Icon className={item.status === 'active' ? 'island-spin' : undefined} />
      </span>
      <span className={clsx('t-txt', `t-txt-${item.status}`)}>{item.label}</span>
      <span className="t-num">{item.id}</span>
    </div>
  );
}

/** 已完成单行（折叠列表内，可展开看 detail/output） */
function DoneRow({ card }: { card: RuntimeCard }) {
  const [open, setOpen] = useState(false);
  const Icon =
    card.kind === 'task'
      ? ListTodo
      : card.kind === 'agent'
        ? Bot
        : card.kind === 'workflow'
          ? Workflow
          : LoaderCircle;
  // 有无展开内容：detail 或 output 任一存在且非空
  const hasExpand = !!(card.detail || card.output);

  return (
    <div className="island-done-row-wrap">
      <button
        className={clsx('island-done-row', hasExpand && 'island-done-row-click')}
        onClick={() => hasExpand && setOpen(v => !v)}
        type="button"
      >
        <span className="d-ico"><Icon /></span>
        <span className="d-title">{card.summary}</span>
        {card.count != null && card.count > 1 && (
          <span className="island-agg-count">×{card.count}</span>
        )}
        {card.meta && <span className="d-meta">{card.meta}</span>}
        {hasExpand && (
          <span className={clsx('island-done-chev', open && 'island-done-chev-open')}>
            <ChevronRight />
          </span>
        )}
      </button>
      {open && hasExpand && (
        <div className="island-done-detail">
          {card.detail && <div className="island-done-detail-text">{card.detail}</div>}
          {card.output && (
            <pre className="island-done-detail-output">{card.output}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** 底部上下文水位条 */
function WaterBar({ water }: { water: ContextWater }) {
  const pct = water.percent != null ? Math.max(0, Math.min(100, water.percent)) : 0;
  const warn = pct >= 70;
  return (
    <div className="island-foot">
      <span className="island-foot-label">上下文</span>
      <div className={clsx('island-water', warn && 'island-water-warn')}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className="island-water-num">
        {formatTokens(water.used)} / {formatTokens(water.window)}
      </span>
    </div>
  );
}
