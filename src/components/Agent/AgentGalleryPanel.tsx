/**
 * Agent Gallery 面板(P1-3 + P3 体验优化)
 *
 * 页签:
 * - 专家:自定义专家(项目级 .polaris/agents,可新建/编辑/删除)+ corpus 267 位;
 *   动作「引入对话」(写 sessionConfig.agent,当前会话 persona)与「派发」(写入输入框
 *   `/dispatch <slug> ` 草稿,用户补充任务后回车派发)
 * - 专家团:roster 场景卡(成员/时序可见),填目标一键组队(nexus_start_roster 波次派发)
 */

import { useEffect, useMemo, useState } from 'react';
import { VirtuosoGrid } from 'react-virtuoso';
import { Pencil, Plus, Rocket, Search, Send, Trash2, UserCheck } from 'lucide-react';
import { useAgentStore } from '@/stores/agentStore';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useToastStore } from '@/stores/toastStore';
import { sessionStoreManager } from '@/stores/conversationStore';
import { deleteUserRoster, dispatchLaterGroup, listPipelines, readCorpusAgent, resolveEscalation, saveUserRoster, startRoster, type CustomAgent, type RosterDef, type RosterPipeline } from '@/services/tauri/agentCorpusService';
import { listen } from '@/services/transport';
import { useDispatchStore } from '@/stores/dispatchStore';
import { openDispatchSession } from '@/services/dispatchTaskService';
import type { AgentCatalogEntry } from '@/types/agent';

/** 把 `/dispatch <slug> ` 写入当前会话输入框草稿(替代复制到剪贴板) */
function draftDispatchCommand(slug: string): boolean {
  const manager = sessionStoreManager.getState();
  const activeId = manager.activeSessionId;
  const store = activeId ? manager.stores.get(activeId) : null;
  if (!store) return false;
  const state = store.getState();
  state.updateInputDraft({
    text: `/dispatch ${slug} `,
    attachments: state.inputDraft.attachments,
  });
  return true;
}

// ============================================================================
// 专家卡片
// ============================================================================

interface GalleryAgent {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  division: string;
  custom?: CustomAgent;
}

function AgentCard({
  agent,
  onEdit,
  onDelete,
  onForkCorpus,
}: {
  agent: GalleryAgent;
  onEdit: (a: CustomAgent) => void;
  onDelete: (a: CustomAgent) => void;
  onForkCorpus: (a: GalleryAgent) => void;
}) {
  const setAgent = useSessionConfig((s) => s.setAgent);
  const currentAgent = useSessionConfig((s) => s.config.agent);
  const divisions = useAgentStore((s) => s.divisions);
  const isCurrent = currentAgent === agent.slug;
  const divisionLabel = agent.custom ? '自定义' : divisions[agent.division]?.label ?? agent.division;

  const handleDispatch = () => {
    if (draftDispatchCommand(agent.slug)) {
      useToastStore.getState().info('已填入输入框', `补充任务内容后回车即派发给「${agent.name}」`);
    } else {
      void navigator.clipboard?.writeText(`/dispatch ${agent.slug} `);
      useToastStore.getState().info('已复制派发命令', `/dispatch ${agent.slug}`);
    }
  };

  return (
    <div
      className={`group flex h-full flex-col rounded-md border p-3 transition-colors ${
        isCurrent ? 'border-primary/40 bg-primary/[0.03]' : 'border-border-subtle hover:border-border'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate text-text-primary" title={agent.name}>
          {agent.name}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-text-muted">{divisionLabel}</span>
      </div>
      <p className="mt-1 line-clamp-2 flex-1 text-xs leading-relaxed text-text-tertiary" title={agent.description}>
        {agent.description}
      </p>
      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            const next = isCurrent ? '' : agent.slug;
            setAgent(next);
            const sid = sessionStoreManager.getState().activeSessionId;
            if (sid) {
              sessionStoreManager.getState().updateSessionAgent(sid, next || null);
            }
          }}
          title={isCurrent ? '退出当前会话' : '以该专家身份参与当前会话'}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
            isCurrent
              ? 'border-primary/40 text-primary border'
              : 'border border-border-subtle text-text-secondary hover:border-border hover:text-text-primary'
          }`}
        >
          <UserCheck size={12} />
          {isCurrent ? '退出对话' : '引入对话'}
        </button>
        <button
          type="button"
          onClick={handleDispatch}
          title="派发后台任务(填入 /dispatch 命令)"
          className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-border hover:text-text-secondary"
        >
          <Send size={11} />
          派发
        </button>
        {!agent.custom && (
          <button
            type="button"
            onClick={() => onForkCorpus(agent)}
            title="复制为自定义专家(可改编 prompt)"
            className="ml-auto rounded p-1 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-secondary"
          >
            <Pencil size={12} />
          </button>
        )}
        {agent.custom && (
          <span className="ml-auto flex gap-0.5">
            <button
              type="button"
              onClick={() => onEdit(agent.custom!)}
              title="编辑"
              className="rounded p-1 text-text-muted hover:text-text-secondary"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(agent.custom!)}
              title="删除"
              className="rounded p-1 text-text-muted hover:text-error"
            >
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 自定义专家编辑弹层
// ============================================================================

interface EditorState {
  slug: string;
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  isNew: boolean;
}

function CustomAgentEditor({
  initial,
  onClose,
}: {
  initial: EditorState;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const workspacePath = useWorkspaceStore((s) => s.getCurrentWorkspace()?.path);
  const saveCustom = useAgentStore((s) => s.saveCustom);
  const slugValid = /^[a-z0-9-]{1,64}$/.test(form.slug);

  const submit = async () => {
    if (!workspacePath) {
      useToastStore.getState().error('无法保存', '当前会话未关联工作区');
      return;
    }
    setSaving(true);
    try {
      await saveCustom({
        workDir: workspacePath,
        slug: form.slug,
        name: form.name,
        description: form.description,
        emoji: form.emoji,
        systemPrompt: form.systemPrompt,
      });
      useToastStore.getState().info('已保存', `专家「${form.name}」已写入 .polaris/agents/${form.slug}.md`);
      onClose();
    } catch (e) {
      useToastStore.getState().error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full rounded border border-border-subtle bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-text-muted focus:border-primary/50';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[480px] max-w-[92vw] rounded-lg border border-border bg-background-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-medium">{form.isNew ? '新建专家' : `编辑专家 · ${initial.name}`}</div>
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <div className="w-16">
              <label className="mb-1 block text-[11px] text-text-muted">emoji</label>
              <input className={field} value={form.emoji} placeholder="🧩"
                onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-text-muted">名称 *</label>
              <input className={field} value={form.name} placeholder="如:接口联调专家"
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">
              slug *(小写字母/数字/连字符;/agent 与 /dispatch 用它引用)
            </label>
            <input
              className={`${field} font-mono ${form.slug && !slugValid ? 'border-error' : ''}`}
              value={form.slug}
              placeholder="my-expert"
              disabled={!form.isNew}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">职责描述(用于列表与语义匹配)</label>
            <input className={field} value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">系统提示词(人格/使命/规则)*</label>
            <textarea
              className={`${field} h-40 resize-y font-mono leading-relaxed`}
              value={form.systemPrompt}
              placeholder={'你是……\n\n## 核心使命\n- …\n\n## 关键规则\n- …'}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border-subtle px-3 py-1.5 text-xs" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            disabled={saving || !slugValid || !form.name.trim() || !form.systemPrompt.trim()}
            className="rounded bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50"
            onClick={() => void submit()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 专家团页签
// ============================================================================

const ACTIVATION_LABEL: Record<string, string> = {
  always: '核心团队',
  'week 3+': '成长阶段',
  'as needed': '按需支援',
  'post-fix': '修复复验',
};

const ACTIVATION_HINT: Record<string, string> = {
  always: '立即出场',
  'week 3+': '首波完成后按需',
  'as needed': '按需支援',
  'post-fix': '修复后复验',
};

function RosterCard({ roster }: { roster: RosterDef }) {
  const catalog = useAgentStore((s) => s.catalog);
  const [goal, setGoal] = useState('');
  const [launching, setLaunching] = useState(false);
  const bySlug = useMemo(() => new Map(catalog.map((c) => [c.slug, c])), [catalog]);
  const workspacePath = useWorkspaceStore((s) => s.getCurrentWorkspace()?.path);

  const launch = async () => {
    if (!goal.trim()) {
      useToastStore.getState().info('请先填写团队目标', '各成员会话只能看到这段目标与自己的专家人格');
      return;
    }
    setLaunching(true);
    try {
      const res = await startRoster({
        scenario: roster.slug,
        goal: goal.trim(),
        sourceSessionId: sessionStoreManager.getState().activeSessionId ?? undefined,
        workDir: workspacePath ?? undefined,
      });
      useToastStore.getState().info(
        '专家团已出发',
        `${roster.title}:${res.waves.length} 波共 ${res.waves.flat().length} 人,首波已派发 ${res.dispatchedNow.length} 人;后续波次完成后自动接力`,
      );
      setGoal('');
    } catch (e) {
      useToastStore.getState().error('组队失败', e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  const coreGroup = roster.groups.find((g) => g.activation === 'always');
  const coreCount = coreGroup?.members.length ?? 0;
  const totalMembers = roster.groups.reduce((n, g) => n + g.members.length, 0);

  return (
    <div className="rounded-md border border-border-subtle p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary">{roster.title}</span>
        {roster.custom && <span className="rounded border border-border-subtle px-1 text-[10px] text-text-muted">自建</span>}
        <span className="ml-auto text-[10px] text-text-muted">{roster.mode} · {roster.duration} · {totalMembers} 人</span>
        {roster.custom && (
          <button
            type="button"
            title="删除自建专家团"
            onClick={() => {
              if (!window.confirm(`删除自建专家团「${roster.title}」?`)) return;
              void deleteUserRoster(roster.slug).then(() => {
                useToastStore.getState().info('已删除', roster.title);
                void useAgentStore.getState().loadRosters();
              });
            }}
            className="rounded p-0.5 text-text-muted hover:text-error"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-tertiary">{roster.summary}</p>

      {roster.groups.map((g) => (
        <div key={g.group} className="mt-2">
          <div className="text-[10px] text-text-muted">
            {ACTIVATION_LABEL[g.activation] ?? g.activation} · {ACTIVATION_HINT[g.activation] ?? ''} ({g.members.length} 人)
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {g.members.map((slug) => {
              const a = bySlug.get(slug);
              return (
                <span
                  key={slug}
                  title={a ? `${a.name} — ${a.description}` : slug}
                  className="rounded border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                >
                  {a?.name ?? slug}
                </span>
              );
            })}
          </div>
        </div>
      ))}

      <div className="mt-3 flex gap-2">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void launch()}
          placeholder="团队目标,如:做一个记账 App 的 MVP…"
          className="min-w-0 flex-1 rounded border border-border-subtle bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-text-muted focus:border-primary/50"
        />
        <button
          type="button"
          disabled={launching}
          onClick={() => void launch()}
          className="flex shrink-0 items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          <Rocket size={12} />
          {launching ? '组队中…' : `启动 · ${coreCount} 人首发`}
        </button>
      </div>
      <div className="mt-1 text-[10px] text-text-muted">
        仅派发「核心团队」组;每波 ≤3 并行,前波全部结束后自动派发下一波,进度见后台会话列表
      </div>
    </div>
  );
}

// ============================================================================
// 进行中(NEXUS pipeline 进度,U1-1)
// ============================================================================

const MEMBER_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '排队', cls: 'text-text-muted border-border-subtle' },
  running: { label: '运行中', cls: 'text-primary border-primary/50' },
  completed: { label: '完成', cls: 'text-success border-success/50' },
  failed: { label: '失败', cls: 'text-error border-error/50' },
};

function PipelineCard({ pipeline }: { pipeline: RosterPipeline }) {
  const catalog = useAgentStore((s) => s.catalog);
  const bySlug = useMemo(() => new Map(catalog.map((c) => [c.slug, c])), [catalog]);
  const total = pipeline.waves.flat().length;
  const doneCount = Object.values(pipeline.members).filter(
    (m) => m.status === 'completed' || m.status === 'failed',
  ).length;

  const openMember = (slug: string) => {
    const dispatchId = pipeline.members[slug]?.dispatchId;
    const task = dispatchId ? useDispatchStore.getState().getTask(dispatchId) : undefined;
    if (task?.sessionId) {
      openDispatchSession(task.sessionId);
    } else {
      useToastStore.getState().info('会话不可用', '该成员会话可能已被清理或来自历史运行');
    }
  };

  const pendingEscalations = (pipeline.escalations ?? []).filter((e) => e.resolution === 'pending');
  const undispatchedGroups = (pipeline.laterGroups ?? []).filter(
    (g) => !(pipeline.dispatchedGroups ?? []).includes(g.activation),
  );

  const handleEscalation = (qaSlug: string, action: 'accept' | 'fail') => {
    void resolveEscalation(pipeline.id, qaSlug, action)
      .then(() => useToastStore.getState().info('已处置', action === 'accept' ? '按通过继续推进' : '已标记失败'))
      .catch((e) => useToastStore.getState().error('处置失败', String(e)));
  };

  const handleLaterGroup = (activation: string) => {
    void dispatchLaterGroup(pipeline.id, activation)
      .then((d) => useToastStore.getState().info('已追派', `「${activation}」组 ${d.length} 人已出发`))
      .catch((e) => useToastStore.getState().error('追派失败', String(e)));
  };

  const isCompleted = pipeline.status === 'completed';

  return (
    <div className="rounded-md border border-border-subtle p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-text-primary" title={pipeline.goal}>
          {pipeline.scenario}
        </span>
        {isCompleted && <span className="rounded border border-success/40 px-1 text-[10px] text-success">已完成</span>}
        <span className="ml-auto text-[10px] text-text-muted">
          {isCompleted ? `${doneCount}/${total} 完成` : `波 ${pipeline.currentWave + 1}/${pipeline.waves.length} · ${doneCount}/${total}`}
        </span>
      </div>
      <div className="mt-1 text-[10px] text-text-muted truncate">{pipeline.goal.slice(0, 50)}</div>
      <div className="mt-2 h-1 overflow-hidden rounded bg-background-secondary">
        <div
          className="h-full rounded bg-primary transition-all"
          style={{ width: `${total ? Math.round((doneCount / total) * 100) : 0}%` }}
        />
      </div>
      {pipeline.waves.map((wave, i) => {
        const waveDone = wave.filter((slug) => {
          const st = pipeline.members[slug]?.status;
          return st === 'completed' || st === 'failed';
        }).length;
        const waveActive = i === pipeline.currentWave && !isCompleted;
        const waveWaiting = i > pipeline.currentWave && !isCompleted;
        return (
          <div key={i} className="mt-2">
            <div className="text-[10px] text-text-muted">
              波 {i + 1}
              {waveActive ? ' · 进行中' : waveWaiting ? ' · 等待前波' : ' · 已回流'}
              <span className="ml-1">{waveDone}/{wave.length}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {wave.map((slug) => {
                const a = bySlug.get(slug);
                const st = pipeline.members[slug]?.status ?? 'pending';
                const meta = MEMBER_STATUS_META[st] ?? MEMBER_STATUS_META.pending;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => openMember(slug)}
                    title={`${a?.name ?? slug} · ${meta.label}${pipeline.memberSummaries[slug] ? '\n' + pipeline.memberSummaries[slug].slice(0, 120) : ''}`}
                    className={`rounded border px-2 py-0.5 text-[11px] transition-colors hover:bg-background-hover ${meta.cls}`}
                  >
                    {a?.name ?? slug} · {meta.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {pipeline.loopState && (
        <div className="mt-2 rounded border border-warning/40 bg-warning/[0.06] px-2 py-1.5 text-[11px] text-warning">
          Dev↔QA 修复循环: {pipeline.loopState.devSlug}
          {pipeline.loopState.phase === 'fixing' ? ' 修复中' : ' 复验中'}
          (第 {(pipeline.fixAttempts?.[pipeline.loopState.devSlug] ?? 1)} 轮 / 上限 3)
        </div>
      )}

      {pendingEscalations.map((esc) => (
        <div key={esc.qaSlug} className="mt-2 rounded border border-error/40 bg-error-faint/40 px-2 py-1.5 text-[11px]">
          <div className="text-error">
            修复重试已达上限({esc.attempts} 轮): {esc.devSlug} 的实现仍未通过 {esc.qaSlug} 复验,需你决策
          </div>
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              onClick={() => handleEscalation(esc.qaSlug, 'accept')}
              className="rounded border border-border-subtle px-2 py-0.5 text-text-secondary hover:text-text-primary"
            >
              带风险接受,继续推进
            </button>
            <button
              type="button"
              onClick={() => handleEscalation(esc.qaSlug, 'fail')}
              className="rounded border border-error/50 px-2 py-0.5 text-error"
            >
              标记失败,继续推进
            </button>
          </div>
        </div>
      ))}

      {isCompleted && undispatchedGroups.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {undispatchedGroups.map((g) => (
            <button
              key={g.activation}
              type="button"
              onClick={() => handleLaterGroup(g.activation)}
              className="rounded border border-primary/50 px-2 py-1 text-[11px] text-primary hover:bg-primary/5"
              title={g.members.join(', ')}
            >
              追派「{ACTIVATION_LABEL[g.activation] ?? g.activation}」组({g.members.length} 人)
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 自建专家团编辑器(U1-5)
// ============================================================================

function RosterBuilder({ onClose }: { onClose: () => void }) {
  const catalog = useAgentStore((s) => s.catalog);
  const customAgents = useAgentStore((s) => s.customAgents);
  const loadRosters = useAgentStore((s) => s.loadRosters);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const pool = useMemo(
    () => [
      ...customAgents.map((c) => ({ slug: c.slug, name: c.name, emoji: c.emoji ?? '🧩', description: c.description, division: 'custom' })),
      ...catalog.map((c) => ({ slug: c.slug, name: c.name, emoji: c.emoji, description: c.description, division: c.division })),
    ],
    [catalog, customAgents],
  );
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return pool
      .filter((a) => !members.includes(a.slug) && (a.slug.includes(q) || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [pool, query, members]);
  const bySlug = useMemo(() => new Map(pool.map((a) => [a.slug, a])), [pool]);

  const submit = async () => {
    const slug = `user-${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'roster'}`.slice(0, 64);
    setSaving(true);
    try {
      await saveUserRoster({ slug, title: title.trim(), summary: summary.trim(), members });
      await loadRosters();
      useToastStore.getState().info('已保存', `自建专家团「${title.trim()}」(${members.length} 人)`);
      onClose();
    } catch (e) {
      useToastStore.getState().error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full rounded border border-border-subtle bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-text-muted focus:border-primary/50';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[520px] max-w-[92vw] rounded-lg border border-border bg-background-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 text-sm font-medium">自建专家团</div>
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">名称 *</label>
            <input className={field} value={title} placeholder="如:全栈小分队" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">说明</label>
            <input className={field} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-text-muted">
              成员 *({members.length} 人;波次将按角色自动编排,每波 ≤3)
            </label>
            <div className="mb-1.5 flex flex-wrap gap-1">
              {members.map((slug) => {
                const a = bySlug.get(slug);
                return (
                  <button
                    key={slug}
                    type="button"
                    title="点击移除"
                    onClick={() => setMembers(members.filter((m) => m !== slug))}
                    className="rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                  >
                    {a?.name ?? slug} ✕
                  </button>
                );
              })}
            </div>
            <input className={field} value={query} placeholder="搜索专家添加(名称/slug/职责)…" onChange={(e) => setQuery(e.target.value)} />
            {matches.length > 0 && (
              <div className="mt-1 max-h-40 overflow-auto rounded border border-border-subtle">
                {matches.map((a) => (
                  <button
                    key={a.slug}
                    type="button"
                    onClick={() => {
                      setMembers([...members, a.slug]);
                      setQuery('');
                    }}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-background-hover"
                  >
                    <span className="shrink-0 font-medium">{a.name}</span>
                    <span className="truncate text-[10px] text-text-muted">{a.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-border-subtle px-3 py-1.5 text-xs" onClick={onClose}>取消</button>
          <button
            type="button"
            disabled={saving || !title.trim() || members.length === 0}
            className="rounded bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50"
            onClick={() => void submit()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 面板主体
// ============================================================================

export default function AgentGalleryPanel() {
  const {
    loaded, loading, error, load, loadRosters, loadCustomAgents,
    search, setSearch, division, setDivision, divisions, catalog, rosters, customAgents, deleteCustom,
  } = useAgentStore();
  const [tab, setTab] = useState<'agents' | 'rosters' | 'runs'>('agents');
  const [pipelines, setPipelines] = useState<RosterPipeline[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [rosterBuilderOpen, setRosterBuilderOpen] = useState(false);
  const workspacePath = useWorkspaceStore((s) => s.getCurrentWorkspace()?.path);

  useEffect(() => {
    if (!loaded) void load();
    void loadRosters();
  }, [loaded, load, loadRosters]);
  useEffect(() => {
    if (workspacePath) void loadCustomAgents(workspacePath);
  }, [workspacePath, loadCustomAgents]);

  // 进行中页签:打开时拉取 + 订阅推进事件(后端每成员终态整体推送,低频)
  useEffect(() => {
    if (tab !== 'runs') return;
    void listPipelines().then(setPipelines).catch(() => setPipelines([]));
    const unlisten = listen<RosterPipeline>('nexus-pipeline-update', (p) => {
      setPipelines((prev) => {
        const idx = prev.findIndex((x) => x.id === p.id);
        if (idx < 0) return [p, ...prev];
        const next = [...prev];
        next[idx] = p;
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [tab]);

  // 自定义在前 + corpus;项目级同名覆盖 corpus
  const galleryList = useMemo<GalleryAgent[]>(() => {
    const customSlugs = new Set(customAgents.map((c) => c.slug));
    const customItems: GalleryAgent[] = customAgents.map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      emoji: c.emoji ?? '🧩',
      division: 'custom',
      custom: c,
    }));
    const corpusItems: GalleryAgent[] = catalog
      .filter((a: AgentCatalogEntry) => !customSlugs.has(a.slug))
      .map((a) => ({ slug: a.slug, name: a.name, description: a.description, emoji: a.emoji, division: a.division }));
    return [...customItems, ...corpusItems];
  }, [customAgents, catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return galleryList.filter(
      (a) =>
        (!division || a.division === division) &&
        (!q ||
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)),
    );
  }, [galleryList, search, division]);

  const divisionEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of galleryList) counts.set(a.division, (counts.get(a.division) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (a[0] === 'custom' ? -1 : b[0] === 'custom' ? 1 : b[1] - a[1]));
  }, [galleryList]);

  const handleDelete = (c: CustomAgent) => {
    if (!workspacePath) return;
    if (!window.confirm(`删除自定义专家「${c.name}」(${c.slug})?文件将从 .polaris/agents/ 移除。`)) return;
    void deleteCustom(workspacePath, c.slug).then(() =>
      useToastStore.getState().info('已删除', c.slug),
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* 页签 */}
      <div className="flex shrink-0 border-b border-border-subtle">
        {([['agents', `专家 ${galleryList.length || ''}`], ['rosters', `专家团 ${rosters.length || ''}`], ['runs', '进行中']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-xs transition-colors ${
              tab === key ? 'border-b-2 border-primary text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'agents' && (
        <>
          <div className="shrink-0 space-y-2 border-b border-border-subtle p-3">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border-subtle px-2 py-1.5">
                <Search size={13} className="shrink-0 text-text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`搜索 ${galleryList.length} 位专家…`}
                  className="w-full bg-transparent text-xs outline-none placeholder:text-text-muted"
                />
              </div>
              <button
                type="button"
                onClick={() => setEditor({ slug: '', name: '', emoji: '', description: '', systemPrompt: '', isNew: true })}
                className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary"
                title="在当前工作区 .polaris/agents/ 新建专家"
              >
                <Plus size={13} />
                新建专家
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setDivision(null)}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  division === null ? 'border-primary/60 text-primary' : 'border-border-subtle text-text-muted'
                }`}
              >
                全部 {galleryList.length}
              </button>
              {divisionEntries.map(([key, count]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDivision(division === key ? null : key)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    division === key ? 'border-primary/60 text-primary' : 'border-border-subtle text-text-muted'
                  }`}
                >
                  {key === 'custom' ? '🧩 自定义' : divisions[key]?.label ?? key} {count}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="px-3 py-2 text-xs text-warning">catalog 加载失败:{error}</div>}
          {loading && !loaded && <div className="px-3 py-2 text-xs text-text-muted">加载中…</div>}

          <div className="flex-1 overflow-hidden">
            <VirtuosoGrid
              totalCount={filtered.length}
              listClassName="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2"
              itemContent={(index) => (
                <AgentCard
                  agent={filtered[index]}
                  onForkCorpus={(a) => {
                    void readCorpusAgent(a.slug)
                      .then((content) => {
                        const body = content.replace(/^---[\s\S]*?---\n*/, '');
                        setEditor({
                          slug: `${a.slug}-custom`.slice(0, 64),
                          name: a.name,
                          emoji: a.emoji,
                          description: a.description,
                          systemPrompt: body.trim(),
                          isNew: true,
                        });
                      })
                      .catch((e) => useToastStore.getState().error('读取专家定义失败', String(e)));
                  }}
                  onEdit={(c) =>
                    setEditor({
                      slug: c.slug, name: c.name, emoji: c.emoji ?? '',
                      description: c.description, systemPrompt: c.systemPrompt, isNew: false,
                    })
                  }
                  onDelete={handleDelete}
                />
              )}
            />
          </div>
        </>
      )}

      {tab === 'rosters' && (
        <div className="flex-1 space-y-3 overflow-auto p-3">
          <button
            type="button"
            onClick={() => setRosterBuilderOpen(true)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border-subtle py-2 text-xs text-text-muted hover:border-border hover:text-text-secondary"
          >
            <Plus size={13} /> 自建专家团(从 {galleryList.length} 位专家中选人组队)
          </button>
          {rosters.length === 0 && (
            <div className="text-xs text-text-muted">专家团数据未就绪(需先完成 corpus 安装)。</div>
          )}
          {rosters.map((r) => (
            <RosterCard key={r.slug} roster={r} />
          ))}
        </div>
      )}

      {tab === 'runs' && (
        <div className="flex-1 space-y-3 overflow-auto p-3">
          {pipelines.length === 0 && (
            <div className="text-xs text-text-muted">暂无专家团运行记录;在「专家团」页签启动一个场景后,这里会显示波次进度。</div>
          )}
          {pipelines.map((p) => (
            <PipelineCard key={p.id} pipeline={p} />
          ))}
        </div>
      )}

      {rosterBuilderOpen && <RosterBuilder onClose={() => setRosterBuilderOpen(false)} />}
      {editor && <CustomAgentEditor initial={editor} onClose={() => setEditor(null)} />}
    </div>
  );
}
