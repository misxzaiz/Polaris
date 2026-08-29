/**
 * 动态岛展开态面板
 *
 * 运行中卡片在上（失败置顶），已完成卡片折叠到底部 ▾ 已完成 (N) 分组。
 * 每张卡有 [定位 →] 按钮跳转到消息流对应块。
 */

import { clsx } from 'clsx';
import { formatDuration, type RuntimeCard } from './useRuntimeSummary';

interface DynamicIslandExpandedProps {
  runningCards: RuntimeCard[];
  failedCards: RuntimeCard[];
  doneCards: RuntimeCard[];
  doneGroupOpen: boolean;
  onToggleDoneGroup: () => void;
  onLocate: (blockIndex: number) => void;
  onClose: () => void;
  elapsedMs: number;
}

export function DynamicIslandExpanded({
  runningCards,
  failedCards,
  doneCards,
  doneGroupOpen,
  onToggleDoneGroup,
  onLocate,
  onClose,
  elapsedMs,
}: DynamicIslandExpandedProps) {
  return (
    <div className="island-panel">
      <div className="island-panel-inner">
        {/* 面板头 */}
        <div className="island-panel-head">
          <span className="island-panel-title">当前运行</span>
          <span className="island-panel-time">{formatDuration(elapsedMs)}</span>
          <button className="island-close" onClick={onClose} aria-label="收起">✕</button>
        </div>

        {/* 失败卡片置顶 */}
        {failedCards.map(card => (
          <RuntimeCardItem
            key={`f-${card.blockId}`}
            card={card}
            onLocate={onLocate}
            failed
          />
        ))}

        {/* 运行中卡片 */}
        {runningCards.map(card => (
          <RuntimeCardItem
            key={`r-${card.blockId}`}
            card={card}
            onLocate={onLocate}
          />
        ))}

        {/* 无运行中 + 无失败的兜底 */}
        {runningCards.length === 0 && failedCards.length === 0 && doneCards.length === 0 && (
          <div className="island-empty">当前无运行态</div>
        )}

        {/* 已完成分组（折叠到底部） */}
        {doneCards.length > 0 && (
          <div className="island-done-group">
            <button className="island-done-head" onClick={onToggleDoneGroup}>
              <span className={clsx('island-done-chev', doneGroupOpen && 'island-done-chev-open')}>▸</span>
              <span>已完成 ({doneCards.length})</span>
            </button>
            {doneGroupOpen && (
              <div className="island-done-list">
                {doneCards.map(card => (
                  <RuntimeCardItem
                    key={`d-${card.blockId}`}
                    card={card}
                    onLocate={onLocate}
                    done
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 单张运行态卡 */
function RuntimeCardItem({
  card,
  onLocate,
  failed = false,
  done = false,
}: {
  card: RuntimeCard;
  onLocate: (blockIndex: number) => void;
  failed?: boolean;
  done?: boolean;
}) {
  const iconCls = failed ? 'island-rcard-icon-fail'
    : done ? 'island-rcard-icon-done'
    : card.kind === 'task' ? 'island-rcard-icon-task'
    : card.kind === 'agent' ? 'island-rcard-icon-agent'
    : card.kind === 'workflow' ? 'island-rcard-icon-workflow'
    : 'island-rcard-icon-progress';

  const icon = failed ? '!'
    : done ? '✓'
    : card.kind === 'task' ? '📋'
    : card.kind === 'agent' ? '◈'
    : card.kind === 'workflow' ? '⚙'
    : '•';

  const canLocate = card.blockIndex >= 0;

  return (
    <div
      className={clsx('island-rcard', done && 'island-rcard-done')}
      onClick={() => canLocate && onLocate(card.blockIndex)}
    >
      <div className="island-rcard-top">
        <span className={clsx('island-rcard-icon', iconCls)}>{icon}</span>
        <span className="island-rcard-title">{card.summary}</span>
        {canLocate && <span className="island-locate">定位 →</span>}
      </div>
      {card.percent != null && (
        <div className="island-rcard-bar">
          <i
            className={clsx(done && 'island-rcard-bar-done')}
            style={{ width: `${card.percent}%` }}
          />
        </div>
      )}
      <div className={clsx('island-rcard-detail', failed && 'island-rcard-detail-fail', done && 'island-rcard-detail-done')}>
        {card.detail}
      </div>
    </div>
  );
}
