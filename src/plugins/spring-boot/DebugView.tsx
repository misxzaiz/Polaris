/**
 * Spring Boot 调试视图：状态、断点管理、调试控制条、调用栈与变量树。
 */
import { useMemo, useState } from 'react';
import { Play, CornerDownRight, ArrowDownToLine, ArrowUpFromLine, Square, Bug, Plus, X } from 'lucide-react';
import { useSpringBootDebugStore, type Breakpoint } from '@/stores/springBootDebugStore';
import { useSpringBootStore } from '@/stores/springBootStore';
import type { DebugVariable } from '@/plugins/spring-boot/debugProtocol';

function valueClass(value: string): string {
  if (value.startsWith('"')) return 'text-[#a5d6ff]';
  if (/^(-?\d|true$|false$|null$)/.test(value)) return 'text-[#79c0ff]';
  return 'text-text-secondary';
}

function simpleClass(fqcn: string): string {
  const parts = fqcn.split('.');
  return parts[parts.length - 1] || fqcn;
}

function fileName(path?: string): string {
  if (!path) return '手动断点';
  return path.split(/[\\/]/).pop() || path;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'launching': return '应用启动中';
    case 'attaching': return 'JDI 连接中';
    case 'running': return '等待命中断点';
    case 'suspended': return '已暂停';
    case 'error': return '调试错误';
    default: return '未开始';
  }
}

function bpStatus(bp: Breakpoint): { text: string; cls: string } {
  if (bp.verified) return { text: 'verified', cls: 'text-green-400' };
  if (bp.message) return { text: 'failed', cls: 'text-red-300' };
  return { text: 'pending', cls: 'text-yellow-300' };
}

function VarRow({ v, depth }: { v: DebugVariable; depth: number }) {
  const expanded = useSpringBootDebugStore((s) => s.expanded);
  const children = useSpringBootDebugStore((s) => s.children);
  const toggleExpand = useSpringBootDebugStore((s) => s.toggleExpand);
  const isOpen = v.objectId > 0 && expanded.includes(v.objectId);
  const kids = children[v.objectId];

  return (
    <>
      <div
        className="flex items-baseline gap-1.5 py-0.5 px-2 hover:bg-white/5 font-mono text-[11px] whitespace-nowrap"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <span
          className="w-3 shrink-0 text-text-tertiary cursor-pointer text-center select-none"
          onClick={() => v.hasChildren && toggleExpand(v.objectId)}
        >
          {v.hasChildren ? (isOpen ? '▾' : '▸') : ''}
        </span>
        <span className="text-[#9cdcfe]">{v.name}</span>
        <span className="text-text-tertiary">=</span>
        <span className={valueClass(v.value)}>{v.value}</span>
        {v.type && <span className="ml-auto pl-3 text-text-tertiary">{v.type}</span>}
      </div>
      {isOpen && kids && kids.map((k, i) => <VarRow key={k.name + i} v={k} depth={depth + 1} />)}
      {isOpen && !kids && (
        <div className="text-[11px] text-text-tertiary py-0.5" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          加载中…
        </div>
      )}
    </>
  );
}

export function DebugView() {
  const phase = useSpringBootDebugStore((s) => s.phase);
  const breakpoints = useSpringBootDebugStore((s) => s.breakpoints);
  const frames = useSpringBootDebugStore((s) => s.frames);
  const variables = useSpringBootDebugStore((s) => s.variables);
  const stop = useSpringBootDebugStore((s) => s.stop);
  const error = useSpringBootDebugStore((s) => s.error);
  const agentReady = useSpringBootDebugStore((s) => s.agentReady);
  const addManualBreakpoint = useSpringBootDebugStore((s) => s.addManualBreakpoint);
  const removeBreakpoint = useSpringBootDebugStore((s) => s.removeBreakpoint);
  const resume = useSpringBootDebugStore((s) => s.resume);
  const stepOver = useSpringBootDebugStore((s) => s.stepOver);
  const stepInto = useSpringBootDebugStore((s) => s.stepInto);
  const stepOut = useSpringBootDebugStore((s) => s.stepOut);
  const stopDebug = useSpringBootDebugStore((s) => s.stopDebug);
  const jdwpPort = useSpringBootStore((s) => s.jdwpPort);

  const [manualInput, setManualInput] = useState('');

  const active = phase !== 'idle' && phase !== 'stopped';
  const suspended = phase === 'suspended';
  const verifiedCount = useMemo(() => breakpoints.filter((bp) => bp.verified).length, [breakpoints]);

  const btn =
    'h-7 px-2 flex items-center gap-1 text-xs rounded disabled:opacity-35 disabled:cursor-not-allowed';

  const addManual = () => {
    const m = manualInput.trim().match(/^([\w.$]+):(\d+)$/);
    if (!m) return;
    addManualBreakpoint(m[1], Number(m[2]));
    setManualInput('');
  };

  return (
    <div className="border-t border-border flex flex-col min-h-0 max-h-[62vh]">
      {/* 控制条 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-[#1d2433] shrink-0">
        <Bug size={13} className="text-orange-400 mr-1" />
        <span className="text-[11px] text-text-secondary mr-2">{phaseLabel(phase)}</span>
        <button className={`${btn} text-green-300 hover:bg-green-600/20`} disabled={!suspended} onClick={resume} title="继续 F9">
          <Play size={13} />继续
        </button>
        <button className={`${btn} text-text-secondary hover:bg-white/10`} disabled={!suspended} onClick={stepOver} title="单步跳过 F8">
          <CornerDownRight size={13} />跳过
        </button>
        <button className={`${btn} text-text-secondary hover:bg-white/10`} disabled={!suspended} onClick={stepInto} title="单步进入 F7">
          <ArrowDownToLine size={13} />进入
        </button>
        <button className={`${btn} text-text-secondary hover:bg-white/10`} disabled={!suspended} onClick={stepOut} title="单步跳出">
          <ArrowUpFromLine size={13} />跳出
        </button>
        {active && (
          <button className={`${btn} text-red-300 hover:bg-red-600/20 ml-auto`} onClick={stopDebug} title="停止调试">
            <Square size={13} />停止
          </button>
        )}
      </div>

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-red-200 bg-red-950/30 border-b border-red-900/40 shrink-0">{error}</div>
      )}

      {/* 状态与断点管理 */}
      <div className="px-3 py-2 border-b border-border bg-[#181818] shrink-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
          <span>JDWP: {jdwpPort ? `:${jdwpPort}` : '等待端口'}</span>
          <span>JDI: {agentReady ? '已连接' : active ? '连接中/等待' : '未连接'}</span>
          <span>断点: {breakpoints.length}</span>
          <span>已验证: {verifiedCount}</span>
          {phase === 'running' && <span className="text-yellow-300">请触发请求以命中断点</span>}
          {phase === 'idle' || phase === 'stopped' ? <span>可先在 Java 行号点击红点，或手动添加类名:行号</span> : null}
        </div>

        <div className="flex gap-1.5">
          <input
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addManual()}
            placeholder="手动断点：com.example.demo.DemoApplication:22"
            className="h-7 flex-1 min-w-0 bg-[#151515] border border-[#3c3c3c] rounded px-2 text-[11px] text-text-primary font-mono"
          />
          <button onClick={addManual} className={`${btn} text-orange-300 hover:bg-orange-600/20 border border-[#3c3c3c]`} title="添加手动断点">
            <Plus size={12} />添加
          </button>
        </div>

        {breakpoints.length > 0 && (
          <div className="max-h-28 overflow-auto border border-[#303030] rounded bg-[#151515]">
            {breakpoints.map((bp) => {
              const status = bpStatus(bp);
              return (
                <div key={bp.id} className="flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-white/5">
                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  <span className="font-mono text-text-secondary truncate" title={`${bp.className}:${bp.line}${bp.message ? ` · ${bp.message}` : ''}`}>
                    {fileName(bp.file)}:{bp.line}
                  </span>
                  <span className="font-mono text-text-tertiary truncate hidden 2xl:inline">{bp.className}</span>
                  <span className={`ml-auto shrink-0 ${status.cls}`}>{status.text}</span>
                  <button onClick={() => removeBreakpoint(bp.id)} className="text-text-tertiary hover:text-red-300" title="删除断点">
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!suspended ? (
        <div className="px-3 py-3 text-xs text-text-tertiary">
          {phase === 'launching' && '应用启动中…'}
          {phase === 'attaching' && 'JDI 调试器连接中…'}
          {phase === 'running' && '运行中 — 等待命中断点。请访问会执行到断点的接口。'}
          {(phase === 'idle' || phase === 'stopped') && '设置断点后点击“调试”，再触发对应请求。'}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wider text-text-tertiary">
            调用栈{stop?.thread ? ` · ${stop.thread}` : ''}
          </div>
          <div className="pb-2">
            {frames.map((f) => (
              <div
                key={f.index}
                className={`px-3 py-1 font-mono text-[11px] flex items-baseline gap-2 border-l-2 ${
                  f.index === 0 ? 'bg-orange-500/10 border-orange-400' : 'border-transparent'
                } ${f.framework ? 'opacity-45' : ''}`}
              >
                <span className="text-text-primary truncate">{simpleClass(f.class)}.{f.method}</span>
                <span className="ml-auto shrink-0 text-text-tertiary">{f.source || '?'}:{f.line}</span>
              </div>
            ))}
          </div>
          <div className="px-3 pt-1 pb-1 text-[11px] uppercase tracking-wider text-text-tertiary border-t border-border">变量</div>
          <div className="pb-3">
            {variables.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-text-tertiary">（无局部变量信息）</div>
            ) : (
              variables.map((v, i) => <VarRow key={v.name + i} v={v} depth={0} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DebugView;
