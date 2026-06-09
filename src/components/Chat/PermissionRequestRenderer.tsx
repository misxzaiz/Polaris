/**
 * 权限请求块渲染器组件
 *
 * 工具调用被拒绝时的权限确认界面：
 * - 按工具类型展示完整 tool_input（文件 / 命令 / 路径等）
 * - 单卡内多工具「逐项」独立批准/拒绝 + 「批量」全部批准/拒绝
 * - 授权范围：仅本次 / 本会话 / 全局
 * - 渲染由 block.status 驱动（pending/approved/denied/expired），刷新 / 虚拟滚动 / 历史重载保持一致
 * - 完全兼容 plan 审批复用（空 denials）的原有整卡批准/拒绝行为（含键盘 Enter / Shift+Enter、自动聚焦）
 */

import { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import {
  Shield, ShieldCheck, ShieldX, AlertTriangle, Clock,
  Terminal, FileText, Eye, Search, Wrench, Boxes,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager';
import { Button } from '../Common/Button';
import type { PermissionRequestBlock, PermissionDenialBlock, PermissionScope } from '@/types';
import { addClaudePermissionRules } from '@/services/claudeSettingsService';

const log = createLogger('PermissionRequest');

export interface PermissionRequestRendererProps {
  block: PermissionRequestBlock;
}

/** 逐项本地决策（提交前暂存） */
type ItemDecision = 'approved' | 'denied';

/** 工具图标映射 */
function getToolIcon(toolName: string) {
  const n = toolName.toLowerCase();
  if (n === 'write' || n === 'edit' || n === 'multiedit') return FileText;
  if (n === 'bash' || n === 'shell') return Terminal;
  if (n === 'read') return Eye;
  if (n === 'glob' || n === 'grep') return Search;
  if (n.startsWith('mcp__')) return Boxes;
  return Wrench;
}

/** 是否写入/执行类高风险工具 */
function isRiskyTool(toolName: string) {
  const n = toolName.toLowerCase();
  return n === 'write' || n === 'edit' || n === 'multiedit'
    || n === 'bash' || n === 'shell'
    || n.includes('delete') || n.includes('remove');
}

/** 从 toolInput 中按候选键取首个非空字符串（兼容 snake/camel） */
function pickStr(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!input) return undefined;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** 一句话摘要（按工具类型提取最关键的入参） */
function getSummary(denial: PermissionDenialBlock): string {
  const n = denial.toolName.toLowerCase();
  const input = denial.toolInput;
  if (n === 'write' || n === 'edit' || n === 'multiedit' || n === 'read') {
    return pickStr(input, 'file_path', 'filePath', 'path') ?? denial.reason;
  }
  if (n === 'bash' || n === 'shell') {
    return pickStr(input, 'command', 'cmd') ?? denial.reason;
  }
  if (n === 'glob' || n === 'grep') {
    return pickStr(input, 'pattern', 'path', 'file_path') ?? denial.reason;
  }
  return denial.reason;
}

/** 为批准的工具生成全局授权规则（收敛范围，避免过度授权） */
function buildGlobalRule(denial: PermissionDenialBlock): string {
  const name = denial.toolName;
  const n = name.toLowerCase();
  const input = denial.toolInput;
  if (n === 'bash' || n === 'shell') {
    const cmd = pickStr(input, 'command', 'cmd');
    const head = cmd ? cmd.trim().split(' ')[0] : '';
    return head ? 'Bash(' + head + ':*)' : 'Bash';
  }
  if (n === 'write' || n === 'edit' || n === 'multiedit' || n === 'read') {
    const fp = pickStr(input, 'file_path', 'filePath', 'path');
    if (fp) {
      const norm = fp.split(String.fromCharCode(92)).join('/');
      const idx = norm.lastIndexOf('/');
      const dir = idx > 0 ? norm.slice(0, idx) : '';
      if (dir) return name + '(' + dir + '/**)';
    }
    return name;
  }
  return name;
}

/** 工具入参详情（按类型差异化展示） */
const ToolInputDetail = memo(function ToolInputDetail({ denial }: { denial: PermissionDenialBlock }) {
  const { t } = useTranslation('chat');
  const n = denial.toolName.toLowerCase();
  const input = denial.toolInput;

  const labelCls = 'text-[11px] uppercase tracking-wide text-text-muted mb-1';
  const preCls = 'text-xs font-mono text-text-secondary bg-background-base/60 border border-border rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all';

  if (input && (n === 'write' || n === 'edit' || n === 'multiedit')) {
    const filePath = pickStr(input, 'file_path', 'filePath');
    const content = pickStr(input, 'content', 'new_string', 'new_str');
    const oldStr = pickStr(input, 'old_string', 'old_str');
    return (
      <>
        {filePath && (
          <div className="mt-2">
            <div className={labelCls}>{t('permissionRequest.file', '目标文件')}</div>
            <div className="text-xs font-mono text-warning break-all">{filePath}</div>
          </div>
        )}
        {oldStr && (
          <div className="mt-2">
            <div className={labelCls}>{t('permissionRequest.oldContent', '原内容')}</div>
            <pre className={preCls}>{oldStr}</pre>
          </div>
        )}
        {content && (
          <div className="mt-2">
            <div className={labelCls}>{t('permissionRequest.content', '写入内容')}</div>
            <pre className={preCls}>{content}</pre>
          </div>
        )}
      </>
    );
  }

  if (input && (n === 'bash' || n === 'shell')) {
    const command = pickStr(input, 'command', 'cmd');
    const description = pickStr(input, 'description', 'desc');
    return (
      <>
        {command && (
          <div className="mt-2">
            <div className={labelCls}>{t('permissionRequest.command', '执行命令')}</div>
            <pre className={preCls}>{command}</pre>
          </div>
        )}
        {description && (
          <div className="mt-2">
            <div className={labelCls}>{t('permissionRequest.description', '说明')}</div>
            <div className="text-xs text-text-secondary break-all">{description}</div>
          </div>
        )}
      </>
    );
  }

  if (input && (n === 'read' || n === 'glob' || n === 'grep')) {
    const target = pickStr(input, 'file_path', 'filePath', 'path', 'pattern');
    return target ? (
      <div className="mt-2">
        <div className={labelCls}>{t('permissionRequest.target', '目标')}</div>
        <div className="text-xs font-mono text-text-secondary break-all">{target}</div>
      </div>
    ) : null;
  }

  // 其他 / MCP 工具：完整参数 JSON
  if (input && Object.keys(input).length > 0) {
    return (
      <div className="mt-2">
        <div className={labelCls}>{t('permissionRequest.parameters', '参数')}</div>
        <pre className={preCls}>{JSON.stringify(input, null, 2)}</pre>
      </div>
    );
  }

  return null;
});

export const PermissionRequestRenderer = memo(function PermissionRequestRenderer({ block }: PermissionRequestRendererProps) {
  const { t } = useTranslation('chat');
  const [isProcessing, setIsProcessing] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [decisions, setDecisions] = useState<Record<number, ItemDecision>>({});
  const [scope, setScope] = useState<PermissionScope>('once');
  // plan 审批（空 denials）复用此块——保留原有「整卡 + 本地态即时反馈」逻辑
  const [planLocalStatus, setPlanLocalStatus] = useState<'pending' | 'approved' | 'denied'>('pending');
  // 工具路径提交后的乐观状态：立即反馈，block.status 落库后作为持久真相源
  const [submittedStatus, setSubmittedStatus] = useState<'approved' | 'denied' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isPlanApproval = block.denials.length === 0;

  // 通过 block.sessionId（后端 conversationId）反查前端 store
  const findStore = useCallback(() => {
    const stores = sessionStoreManager.getState().stores;
    for (const [, store] of stores) {
      const state = store.getState();
      if (state.conversationId === block.sessionId) return state;
    }
    return null;
  }, [block.sessionId]);

  const setItemDecision = useCallback((index: number, dec: ItemDecision | undefined) => {
    setDecisions(prev => {
      const next = { ...prev };
      if (dec === undefined) delete next[index];
      else next[index] = dec;
      return next;
    });
  }, []);

  const setAllDecisions = useCallback((dec: ItemDecision) => {
    const next: Record<number, ItemDecision> = {};
    block.denials.forEach((_, i) => { next[i] = dec; });
    setDecisions(next);
  }, [block.denials]);

  const counts = useMemo(() => {
    let approved = 0, denied = 0;
    block.denials.forEach((_, i) => {
      if (decisions[i] === 'approved') approved++;
      else if (decisions[i] === 'denied') denied++;
    });
    return { approved, denied, decided: approved + denied, pending: block.denials.length - approved - denied };
  }, [block.denials, decisions]);

  // 全局授权时预览将写入的规则（供用户二次确认）
  const globalRulePreview = useMemo(() => {
    if (scope !== 'global') return [] as string[];
    return [...new Set(block.denials.filter((_, i) => decisions[i] === 'approved').map(buildGlobalRule))];
  }, [scope, block.denials, decisions]);

  // plan 审批：保留原有整卡批准/拒绝行为（含空 denials 时的 prompt 表现）
  const handlePlanDecision = useCallback(async (approved: boolean) => {
    if (planLocalStatus !== 'pending' || isProcessing) return;
    setIsProcessing(true);
    setPlanLocalStatus(approved ? 'approved' : 'denied');
    try {
      const store = findStore();
      if (store) {
        const toolNames = [...new Set(block.denials.map(d => d.toolName))];
        if (approved) {
          await store.continueChat(`[已授权] ${toolNames.join(', ')}`, toolNames.length > 0 ? toolNames : undefined);
        } else {
          const suffix = toolNames.length > 0 ? `\n工具: ${toolNames.join(', ')}` : '';
          await store.continueChat(`[权限确认] 用户拒绝了操作${suffix}`);
        }
      }
    } catch (error) {
      log.error('权限决策失败:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsProcessing(false);
    }
  }, [planLocalStatus, isProcessing, block.denials, findStore]);

  // 工具权限：逐项决策落库 + 合并为一次 continueChat（allowedTools = 被批准项）
  const handleSubmit = useCallback(async () => {
    if (isProcessing || counts.decided === 0) return;
    setIsProcessing(true);
    try {
      // 未决项保守按拒绝处理（未授权）
      const perItem = block.denials.map((_, i) => {
        const dec: ItemDecision = decisions[i] ?? 'denied';
        return { status: dec, scope: dec === 'approved' ? scope : undefined };
      });
      const approvedTools = [...new Set(
        block.denials.filter((_, i) => decisions[i] === 'approved').map(d => d.toolName)
      )];

      const store = findStore();
      if (store) {
        store.resolvePermissionRequest(block.id, perItem);
        // 立即乐观反馈（不等 store→props 传播），卡片即时切换为结果态
        setSubmittedStatus(approvedTools.length > 0 ? 'approved' : 'denied');
        // 全局范围：将批准项生成规则写入 ~/.claude/settings.json 的 permissions.allow
        if (scope === 'global') {
          const approvedDenials = block.denials.filter((_, i) => decisions[i] === 'approved');
          if (approvedDenials.length > 0) {
            try {
              const rules = [...new Set(approvedDenials.map(buildGlobalRule))];
              await addClaudePermissionRules(rules, 'allow');
            } catch (e) {
              log.error('写入全局权限规则失败:', e instanceof Error ? e : new Error(String(e)));
            }
          }
        }
        if (approvedTools.length > 0) {
          await store.continueChat(`[已授权] ${approvedTools.join(', ')}`, approvedTools);
        } else {
          await store.continueChat(`[权限确认] 用户拒绝了操作\n工具: ${block.denials.map(d => d.toolName).join(', ')}`);
        }
      }
    } catch (error) {
      log.error('提交权限决策失败:', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, counts.decided, block.denials, block.id, decisions, scope, findStore]);

  // 键盘：Enter=批准/提交，Shift+Enter=拒绝/全部拒绝（保留 plan 原交互）
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isProcessing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        if (isPlanApproval) handlePlanDecision(false);
        else setAllDecisions('denied');
      } else {
        if (isPlanApproval) handlePlanDecision(true);
        else if (counts.decided > 0) handleSubmit();
      }
    }
  }, [isProcessing, isPlanApproval, counts.decided, handlePlanDecision, handleSubmit, setAllDecisions]);

  // 自动聚焦（仅 pending 完整面板）
  useEffect(() => {
    if (block.status === 'pending' && planLocalStatus === 'pending' && containerRef.current) {
      containerRef.current.focus();
    }
  }, [block.status, planLocalStatus]);

  // 有效状态：block.status 为持久真相源；pending 时回退本地乐观态 submittedStatus（提交瞬间即时生效，刷新/虚拟滚动/重载不回退）
  const effectiveStatus = block.status !== 'pending' ? block.status : submittedStatus;

  // ===== 结果态 / 失效态：紧凑一行 =====
  if (effectiveStatus === 'approved' || (isPlanApproval && planLocalStatus === 'approved')) {
    const tools = [...new Set(block.denials.filter(d => d.status !== 'denied').map(d => d.toolName))].join(', ');
    return (
      <div className="my-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-success-faint border border-success/30 text-sm">
        <ShieldCheck className="w-4 h-4 text-success shrink-0" />
        <span className="text-success font-medium">{t('permissionRequest.approved', '已授权')}</span>
        {tools && <span className="font-mono text-xs text-text-tertiary truncate">{tools}</span>}
      </div>
    );
  }

  if (effectiveStatus === 'denied' || (isPlanApproval && planLocalStatus === 'denied')) {
    const tools = [...new Set(block.denials.filter(d => d.status === 'denied').map(d => d.toolName))].join(', ');
    return (
      <div className="my-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-danger-faint border border-danger/30 text-sm">
        <ShieldX className="w-4 h-4 text-danger shrink-0" />
        <span className="text-danger font-medium">{t('permissionRequest.denied', '已拒绝')}</span>
        {tools && <span className="font-mono text-xs text-text-tertiary truncate">{tools}</span>}
      </div>
    );
  }

  if (effectiveStatus === 'expired') {
    return (
      <div className="my-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-background-secondary border border-border text-sm opacity-80">
        <Clock className="w-4 h-4 text-text-muted shrink-0" />
        <span className="text-text-muted">{t('permissionRequest.expired', '权限请求已失效')}</span>
        {block.denials.length > 0 && (
          <span className="text-xs text-text-muted ml-auto">{block.denials.length} {t('permissionRequest.items', '项')}</span>
        )}
      </div>
    );
  }

  // ===== plan 审批复用（空 denials）：保留原有整卡批准 / 拒绝面板 =====
  if (isPlanApproval) {
    return (
      <div
        ref={containerRef}
        className="my-2 rounded-lg border p-4 bg-warning-faint border-warning/30 focus:ring-2 focus:ring-warning/40 focus:outline-none transition-all"
        role="region"
        aria-label={t('permissionRequest.ariaLabel', '权限请求')}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-5 h-5 text-warning" />
          <span className="font-medium text-sm text-text-primary">{t('permissionRequest.title', '权限请求')}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => handlePlanDecision(true)} disabled={isProcessing} className="flex-1">
            {isProcessing ? t('permissionRequest.processing', '处理中...') : t('permissionRequest.approve', '批准')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => handlePlanDecision(false)} disabled={isProcessing} className="flex-1">
            {t('permissionRequest.deny', '拒绝')}
          </Button>
        </div>
      </div>
    );
  }

  // ===== pending 工具权限：逐项 + 批量 + 授权范围 + 提交 =====
  const summaryParts: string[] = [];
  if (counts.approved > 0) summaryParts.push(`${t('permissionRequest.allow', '允许')} ${counts.approved}`);
  if (counts.denied > 0) summaryParts.push(`${t('permissionRequest.refuse', '拒绝')} ${counts.denied}`);
  if (counts.pending > 0) summaryParts.push(`${counts.pending} ${t('permissionRequest.pendingItems', '项未决')}`);

  const SCOPES: Array<{ value: PermissionScope; label: string }> = [
    { value: 'once', label: t('permissionRequest.scopeOnce', '仅本次') },
    { value: 'session', label: t('permissionRequest.scopeSession', '本会话') },
    { value: 'global', label: t('permissionRequest.scopeGlobal', '全局') },
  ];

  return (
    <div
      ref={containerRef}
      className="my-2 rounded-lg border p-3 bg-warning-faint border-warning/30 focus:ring-2 focus:ring-warning/40 focus:outline-none transition-all"
      role="region"
      aria-label={t('permissionRequest.ariaLabel', '权限请求')}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* 标题栏 */}
      <div className="flex items-center gap-2 mb-3">
        <Shield className="w-4.5 h-4.5 text-warning" />
        <span className="font-medium text-sm text-text-primary">{t('permissionRequest.title', '权限请求')}</span>
        {block.denials.some(d => isRiskyTool(d.toolName)) && (
          <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-danger-faint text-danger border border-danger/30">
            <AlertTriangle className="w-3 h-3" />
            {t('permissionRequest.riskWrite', '写入 / 执行')}
          </span>
        )}
        <span className="text-xs text-text-tertiary ml-auto">{block.denials.length} {t('permissionRequest.items', '项')}</span>
      </div>

      {/* 逐项列表 */}
      <div className="space-y-2 max-h-[260px] overflow-y-auto">
        {block.denials.map((denial, index) => {
          const dec = decisions[index];
          const Icon = getToolIcon(denial.toolName);
          const expanded = expandedIdx === index;
          return (
            <div
              key={index}
              className={clsx(
                'rounded-md border bg-background-surface transition-colors',
                dec === 'approved' ? 'border-success/40' : dec === 'denied' ? 'border-danger/40' : 'border-border'
              )}
            >
              <div className="flex items-center gap-2 p-2">
                <button
                  type="button"
                  className="flex items-center gap-2 flex-1 min-w-0 text-left focus:outline-none"
                  onClick={() => setExpandedIdx(prev => (prev === index ? null : index))}
                  aria-expanded={expanded}
                >
                  {expanded
                    ? <ChevronDown className="w-4 h-4 text-text-muted shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-text-muted shrink-0" />}
                  <span className="w-6 h-6 rounded flex items-center justify-center bg-background-tertiary shrink-0">
                    <Icon className="w-3.5 h-3.5 text-text-secondary" />
                  </span>
                  <span className="min-w-0">
                    <span className="font-mono text-xs font-semibold text-text-primary flex items-center gap-1.5">
                      {denial.toolName}
                      {isRiskyTool(denial.toolName) && <AlertTriangle className="w-3 h-3 text-warning shrink-0" />}
                    </span>
                    <span className="block font-mono text-[11px] text-text-tertiary truncate">{getSummary(denial)}</span>
                  </span>
                </button>

                {/* 逐项操作 */}
                {dec ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={clsx(
                      'text-[11px] px-2 py-0.5 rounded-full border',
                      dec === 'approved'
                        ? 'text-success bg-success-faint border-success/30'
                        : 'text-danger bg-danger-faint border-danger/30'
                    )}>
                      {dec === 'approved' ? t('permissionRequest.approved', '已授权') : t('permissionRequest.denied', '已拒绝')}
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-text-tertiary hover:text-text-primary transition-colors"
                      onClick={() => setItemDecision(index, undefined)}
                    >
                      {t('permissionRequest.undo', '撤销')}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      className="px-2 py-1 rounded text-xs font-medium bg-success/15 text-success hover:bg-success/25 transition-colors"
                      onClick={() => setItemDecision(index, 'approved')}
                    >
                      {t('permissionRequest.approve', '批准')}
                    </button>
                    <button
                      type="button"
                      className="px-2 py-1 rounded text-xs font-medium bg-background-tertiary text-text-secondary hover:text-danger transition-colors"
                      onClick={() => setItemDecision(index, 'denied')}
                    >
                      {t('permissionRequest.deny', '拒绝')}
                    </button>
                  </div>
                )}
              </div>

              {/* 详情展开 */}
              {expanded && (
                <div className="px-2 pb-2 border-t border-border">
                  <ToolInputDetail denial={denial} />
                  <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-danger">
                    <ShieldX className="w-3 h-3 shrink-0" />
                    <span>{denial.reason}</span>
                    {denial.toolUseId && <span className="text-text-muted ml-1 font-mono">· {denial.toolUseId}</span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部：授权范围 + 批量 + 提交 */}
      <div className="mt-3 pt-3 border-t border-border space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-text-tertiary">{t('permissionRequest.scope', '授权范围')}</span>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {SCOPES.map(s => (
              <button
                key={s.value}
                type="button"
                onClick={() => setScope(s.value)}
                className={clsx(
                  'px-2.5 py-1 text-[11px] transition-colors border-r border-border last:border-r-0',
                  scope === s.value ? 'bg-primary/15 text-primary' : 'text-text-tertiary hover:text-text-secondary'
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          {scope === 'global' && (
            <span className="text-[11px] text-warning truncate">
              {globalRulePreview.length > 0
                ? t('permissionRequest.willWriteRules', '将写入全局规则') + ': ' + globalRulePreview.join('  ')
                : t('permissionRequest.globalHint', '将写入全局配置')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-xs text-success hover:underline"
            onClick={() => setAllDecisions('approved')}
          >
            {t('permissionRequest.approveAll', '全部批准')}
          </button>
          <button
            type="button"
            className="text-xs text-text-tertiary hover:text-danger hover:underline"
            onClick={() => setAllDecisions('denied')}
          >
            {t('permissionRequest.denyAll', '全部拒绝')}
          </button>
          {summaryParts.length > 0 && (
            <span className="text-[11px] text-text-muted truncate">{summaryParts.join(' · ')}</span>
          )}
          <Button
            variant="primary"
            size="sm"
            className="ml-auto shrink-0"
            onClick={handleSubmit}
            disabled={isProcessing || counts.decided === 0}
          >
            {isProcessing ? t('permissionRequest.processing', '处理中...') : t('permissionRequest.submit', '提交')}
          </Button>
        </div>
      </div>
    </div>
  );
});

/**
 * 简化版权限请求渲染器（归档/失效态紧凑展示）
 */
export const SimplifiedPermissionRequestRenderer = memo(function SimplifiedPermissionRequestRenderer({ block }: PermissionRequestRendererProps) {
  const { t } = useTranslation('chat');

  const approved = block.status === 'approved';
  const expired = block.status === 'expired';
  const Icon = approved ? ShieldCheck : expired ? Clock : ShieldX;
  const iconClass = approved ? 'text-success' : expired ? 'text-text-muted' : 'text-danger';

  return (
    <div
      className="my-1 flex items-center gap-2 px-3 py-2 rounded bg-background-secondary text-sm"
      role="region"
      aria-label={t('permissionRequest.permissionRequest', '权限请求')}
      aria-hidden="true"
    >
      <Icon className={clsx('w-4 h-4 shrink-0', iconClass)} />
      <span className="text-text-tertiary">{t('permissionRequest.permissionRequest', '权限请求')}</span>
      <span className="text-xs text-text-muted ml-auto">{block.denials.length} {t('permissionRequest.items', '项')}</span>
    </div>
  );
});

export default PermissionRequestRenderer;
