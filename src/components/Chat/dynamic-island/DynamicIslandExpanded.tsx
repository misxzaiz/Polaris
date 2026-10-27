/**
 * 动态岛 v3 展开态面板 —— urgent 常驻 + 明细三分节 tab
 *
 *   需要你（urgent，常驻顶部） → [运行 | 变更汇总 | 后台任务] tab → 底部水位条
 *
 * v3 变更（常驻变更汇总，plans/dynamic-island-change-summary-plan.md）：
 * - 明细区改为三分节 tab：运行（原 v2 卡片内容）/ 变更汇总（会话文件操作流水，可展开
 *   行内 diff、在编辑器打开）/ 后台任务（cap.bash 任务只读列表，生命周期事件待 P3）
 * - tab 默认值按内容懒选：有运行/失败/完成卡 → 运行，否则变更汇总
 *
 * v2 既有设计不变：urgent 卡内联审批；展开即详情不跳转消息流；lucide-react 图标。
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { diffLines } from 'diff';
import {
  ListTodo,
  Bot,
  Workflow,
  Wrench,
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
  Activity,
  FileDiff,
  FilePen,
  FilePlus,
  FileMinus,
  FileText,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useViewStore } from '@/stores/viewStore';
import { useToastStore } from '@/stores/toastStore';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { resolveWorkspacePath } from '@/utils/path';
import { formatTokens, type ContextWater, type RuntimeCard, type TaskRow, type UrgentCard } from './useRuntimeSummary';
import {
  MAX_DIFF_CHARS,
  type FileOpKind,
  type SessionBgTask,
  type SessionChangeSummary,
  type SessionFileChange,
  type SessionFileDiffPreview,
} from './changeSummary';

type IslandTab = 'run' | 'changes' | 'tasks';

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
  /** 会话变更汇总（变更汇总 / 后台任务 tab 数据源） */
  changeSummary: SessionChangeSummary;
}

export function DynamicIslandExpanded({
  urgent,
  runningCards,
  failedCards,
  doneCards,
  doneGroupOpen,
  onToggleDoneGroup,
  water,
  onUrgentDecision,
  changeSummary,
}: DynamicIslandExpandedProps) {
  // tab 懒选默认：展开瞬间有运行态内容 → 运行 tab；空闲展开 → 变更汇总 tab
  const [tab, setTab] = useState<IslandTab>(() =>
    runningCards.length + failedCards.length + doneCards.length > 0 ? 'run' : 'changes',
  );

  return (
    <div className="island-panel">
      <div className="island-panel-inner">

        {/* 需要你：最优先，常驻于所有 tab 之上 */}
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

        {/* 明细三分节 tab */}
        <div className="island-tabs" role="tablist" aria-label="悬浮岛明细分节">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'run'}
            className={clsx('island-tab', tab === 'run' && 'island-tab-on')}
            onClick={() => setTab('run')}
          >
            <Activity /> 运行
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            className={clsx('island-tab', tab === 'changes' && 'island-tab-on')}
            onClick={() => setTab('changes')}
          >
            <FileDiff /> 变更汇总
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tasks'}
            className={clsx('island-tab', tab === 'tasks' && 'island-tab-on')}
            onClick={() => setTab('tasks')}
          >
            <Terminal /> 后台任务
            {changeSummary.runningBgCount > 0 && (
              <span className="island-tab-count">{changeSummary.runningBgCount}</span>
            )}
          </button>
        </div>

        {tab === 'run' && (
          <>
            {/* 失败置顶 */}
            {failedCards.map((card, i) => (
              <RuntimeCardItem key={`fail-${card.summary}-${i}`} card={card} failed />
            ))}

            {/* 运行中 */}
            {runningCards.map((card, i) => (
              <RuntimeCardItem key={`run-${card.summary}-${i}`} card={card} />
            ))}

            {/* 空态 */}
            {failedCards.length === 0 &&
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
          </>
        )}

        {tab === 'changes' && <ChangeList summary={changeSummary} />}
        {tab === 'tasks' && <TaskList summary={changeSummary} />}

        {/* 底部水位条 */}
        {water && <WaterBar water={water} />}
      </div>
    </div>
  );
}

// ============================================================================
// 变更汇总 tab
// ============================================================================

const CHANGE_KIND_META: Record<FileOpKind, { Icon: LucideIcon; label: string }> = {
  edit: { Icon: FilePen, label: '编辑' },
  write: { Icon: FilePlus, label: '写入' },
  delete: { Icon: FileMinus, label: '删除' },
};

/** 变更汇总列表：文件级流水（MRU 排序，数据源 changeSummary.ts）；行可展开 diff、可在编辑器打开 */
function ChangeList({ summary }: { summary: SessionChangeSummary }) {
  if (summary.files.length === 0) {
    return <div className="island-empty">本次会话还没有文件变更</div>;
  }
  return (
    <div className="island-changes">
      {summary.files.map((f: SessionFileChange) => (
        <ChangeRow key={f.filePath} file={f} />
      ))}
      <div className="island-note">按工具操作累加 · bash 内的文件操作不计入 · 点击行查看变更</div>
    </div>
  );
}

/** 单文件变更行：左键展开/收起 diff 预览，右侧按钮在编辑器打开 */
function ChangeRow({ file }: { file: SessionFileChange }) {
  const [open, setOpen] = useState(false);
  const { Icon, label } = CHANGE_KIND_META[file.lastKind];
  // 删除操作无 diff 内容；编辑/写入且有内容才可展开
  const hasDiff = !!file.lastDiff && file.lastKind !== 'delete';
  // 删除的文件已不在盘上，不提供编辑器入口
  const canOpenEditor = file.lastKind !== 'delete';

  const openInEditor = () => {
    try {
      const ws = useWorkspaceStore.getState().getCurrentWorkspace()?.path;
      // AI 传来的多为绝对路径；相对路径按当前工作区解析（与 GitPanel 同一工具）
      const abs = resolveWorkspacePath(ws, file.filePath);
      const name = abs.split(/[\\/]/).pop() || file.filePath;
      void useFileEditorStore.getState().openFile(abs, name).catch((e: unknown) => {
        useToastStore.getState().error('打开文件失败', file.filePath);
        if (e) console.warn('[DynamicIsland] openFile 失败', e);
      });
    } catch (e) {
      useToastStore.getState().error('打开文件失败', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="island-change-wrap" title={file.filePath}>
      <div className="island-change-row">
        <span className={`island-change-ico island-change-${file.lastKind}`}><Icon /></span>
        {hasDiff ? (
          <button
            type="button"
            className="island-change-main"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
          >
            <span className="island-change-path">{file.filePath}</span>
            <span className="island-change-ops">{file.opCount > 1 ? `${file.opCount} 次${label}` : label}</span>
            <span className="island-change-stat">
              <b className="island-change-add">+{file.addedLines}</b>
              <b className="island-change-del">−{file.removedLines}</b>
            </span>
            <span className={clsx('island-change-chev', open && 'island-change-chev-open')}><ChevronRight /></span>
          </button>
        ) : (
          <div className="island-change-main island-change-static">
            <span className="island-change-path">{file.filePath}</span>
            <span className="island-change-ops">{file.opCount > 1 ? `${file.opCount} 次${label}` : label}</span>
            <span className="island-change-stat">
              <b className="island-change-add">+{file.addedLines}</b>
              <b className="island-change-del">−{file.removedLines}</b>
            </span>
          </div>
        )}
        {canOpenEditor && (
          <button
            type="button"
            className="island-change-open"
            title="在编辑器打开"
            aria-label={`在编辑器打开 ${file.filePath}`}
            onClick={openInEditor}
          >
            <FileText />
          </button>
        )}
      </div>
      {open && hasDiff && file.lastDiff && <ChangeDiffView diff={file.lastDiff} />}
    </div>
  );
}

/** 行内 diff 渲染上限行数（超出省略，完整 diff 请在编辑器/消息卡查看） */
const MAX_DIFF_ROWS = 200;

type DiffRowKind = 'add' | 'del' | 'ctx';
interface DiffRow { kind: DiffRowKind; text: string }

/** diff v8 diffLines → 逐行着色行；写入（无旧内容）全按新增行展示 */
function buildDiffRows(diff: SessionFileDiffPreview): { rows: DiffRow[]; cut: boolean } {
  if (diff.oldContent === undefined) {
    const lines = (diff.newContent ?? '').replace(/\n$/, '').split('\n');
    return { rows: lines.map(text => ({ kind: 'add' as const, text })), cut: lines.length > MAX_DIFF_ROWS };
  }
  const parts = diffLines(diff.oldContent, diff.newContent ?? '');
  const rows: DiffRow[] = [];
  for (const p of parts) {
    const kind: DiffRowKind = p.added ? 'add' : p.removed ? 'del' : 'ctx';
    for (const text of p.value.replace(/\n$/, '').split('\n')) {
      rows.push({ kind, text });
    }
  }
  return { rows: rows.slice(0, MAX_DIFF_ROWS), cut: rows.length > MAX_DIFF_ROWS };
}

/** 行内 diff 预览（等宽小字，增绿删红，超高滚动） */
function ChangeDiffView({ diff }: { diff: SessionFileDiffPreview }) {
  const { rows, cut } = useMemo(() => buildDiffRows(diff), [diff]);
  return (
    <div className="island-diff">
      <div className="island-diff-body">
        {rows.map((r, i) => (
          <div
            key={i}
            className={clsx('island-diff-line', r.kind === 'add' && 'island-diff-add', r.kind === 'del' && 'island-diff-del')}
          >
            <span className="island-diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
            <span className="island-diff-text">{r.text || ' '}</span>
          </div>
        ))}
        {cut && <div className="island-diff-more">… 其余行省略（共 {MAX_DIFF_ROWS}+ 行）</div>}
      </div>
      {diff.truncated && (
        <div className="island-diff-more">内容过长，仅显示前 {MAX_DIFF_CHARS} 字符</div>
      )}
    </div>
  );
}

// ============================================================================
// 后台任务 tab
// ============================================================================

/**
 * 后台任务列表（只读）：块聚合展示 cap.bash 后台任务（taskId 由事件层透传）。
 *
 * 口径（诚实标注）：bash 异步任务「工具调用先返回、任务继续跑」，块 completed 只是
 * 启动回执，不代表任务结束——「运行中」表示已启动、生命周期未知；失败仅指启动失败。
 * 真实退出状态需 cap.bash 生命周期事件（P3，含状态对账与停止交互）。
 */
function TaskList({ summary }: { summary: SessionChangeSummary }) {
  const tasks = summary.backgroundTasks;
  if (tasks.length === 0) {
    return <div className="island-empty">没有后台任务</div>;
  }
  return (
    <div className="island-tasks">
      {tasks.map((t: SessionBgTask) => (
        <div key={t.taskId} className="island-task-line">
          <span className="island-task-ico"><Terminal /></span>
          <span className="island-task-cmd" title={t.label}>{t.label}</span>
          <span className={clsx('island-bg-badge', `island-bg-${t.status}`)}>
            {t.status === 'failed' ? '启动失败' : '运行中'}
          </span>
        </div>
      ))}
      <div className="island-note">
        运行中 = 已启动、生命周期未知 ·{' '}
        <button
          type="button"
          className="island-link"
          onClick={() => useViewStore.getState().switchToLeftPanel('aiConsole')}
        >
          在控制台打开
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// v2 既有组件（urgent / 运行卡 / 任务行 / 完成行 / 水位条）
// ============================================================================

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

/** 运行态卡片（任务 / agent / workflow / tool / progress） */
function RuntimeCardItem({ card, failed = false }: { card: RuntimeCard; failed?: boolean }) {
  const Icon =
    card.kind === 'task'
      ? ListTodo
      : card.kind === 'agent'
        ? Bot
        : card.kind === 'workflow'
          ? Workflow
          : card.kind === 'tool'
            ? Wrench
            : card.kind === 'plan'
              ? ListTodo
              : LoaderCircle;

  const iconCls =
    card.kind === 'agent'
      ? 'r-ico-agent'
      : card.kind === 'task'
        ? 'r-ico-task'
        : card.kind === 'workflow'
          ? 'r-ico-workflow'
          : card.kind === 'tool'
            ? 'r-ico-tool'
            : card.kind === 'plan'
              ? 'r-ico-plan'
              : 'r-ico-progress';

  return (
    <div className={clsx('island-card', failed && 'island-fail')}>
      <div className="r-top">
        <span className={clsx('r-ico', iconCls)}>
          <Icon />
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
        <Icon />
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
          : card.kind === 'tool'
            ? Wrench
            : card.kind === 'plan'
              ? ListTodo
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
