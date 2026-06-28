import { useEffect, useMemo } from 'react';
import { Rocket, Play, Bug, Square, RotateCcw, Trash2 } from 'lucide-react';
import { useSpringBootStore } from '@/stores/springBootStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { DebugView } from './DebugView';
import { useSpringBootDebugStore } from '@/stores/springBootDebugStore';
import { createLogger } from '@/utils/logger';
import type { SpringBootPhase } from '@/plugins/spring-boot/logParser';

const log = createLogger('SpringBootRunnerPanel');

function phaseLabel(phase: SpringBootPhase): string {
  switch (phase) {
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'failed':
      return '失败';
    case 'stopped':
      return '已停止';
    default:
      return '未运行';
  }
}

function phaseColor(phase: SpringBootPhase): string {
  switch (phase) {
    case 'running':
      return 'bg-green-500';
    case 'starting':
      return 'bg-yellow-500 animate-pulse';
    case 'failed':
      return 'bg-red-500';
    case 'stopped':
      return 'bg-gray-500';
    default:
      return 'bg-gray-600';
  }
}

const BTN_BASE =
  'h-7 px-2.5 flex items-center gap-1 text-xs rounded border disabled:opacity-40 disabled:cursor-not-allowed';

export function SpringBootRunnerPanel() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspacePath = useMemo(
    () => workspaces.find((w) => w.id === currentWorkspaceId)?.path ?? null,
    [workspaces, currentWorkspaceId],
  );

  const detection = useSpringBootStore((s) => s.detection);
  const detecting = useSpringBootStore((s) => s.detecting);
  const run = useSpringBootStore((s) => s.run);
  const mode = useSpringBootStore((s) => s.mode);
  const sessionId = useSpringBootStore((s) => s.sessionId);
  const jdwpPort = useSpringBootStore((s) => s.jdwpPort);
  const logTail = useSpringBootStore((s) => s.logTail);
  const error = useSpringBootStore((s) => s.error);
  const detect = useSpringBootStore((s) => s.detect);
  const start = useSpringBootStore((s) => s.start);
  const stop = useSpringBootStore((s) => s.stop);
  const restart = useSpringBootStore((s) => s.restart);
  const clearLog = useSpringBootStore((s) => s.clearLog);
  const clearError = useSpringBootStore((s) => s.clearError);
  const initListeners = useSpringBootStore((s) => s.initListeners);
  const startDebug = useSpringBootDebugStore((s) => s.startDebug);
  const stopDebug = useSpringBootDebugStore((s) => s.stopDebug);
  const debugPhase = useSpringBootDebugStore((s) => s.phase);
  const initDebugListeners = useSpringBootDebugStore((s) => s.initListeners);

  // 安装 PTY 输出/退出监听
  useEffect(() => initListeners(), [initListeners]);
  // 安装调试代理事件监听
  useEffect(() => initDebugListeners(), [initDebugListeners]);

  // 工作区变化时重新检测
  useEffect(() => {
    detect(workspacePath).catch((e) => log.error('检测失败', e instanceof Error ? e : new Error(String(e))));
  }, [detect, workspacePath]);

  const isRunning = !!sessionId;
  const phase = run.phase;
  const debugActive = debugPhase !== 'idle' && debugPhase !== 'stopped';

  const handle = (fn: () => Promise<void>, label: string) => () =>
    fn().catch((e) => log.error(`${label}失败`, e instanceof Error ? e : new Error(String(e))));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部 + 状态徽标 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Rocket size={15} className="text-text-tertiary" />
        <span className="text-sm font-medium text-text-primary">Spring Boot</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${phaseColor(phase)}`} />
          <span className="text-xs text-text-secondary">{phaseLabel(phase)}</span>
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* 项目检测卡 */}
        <div className="p-3 border-b border-border">
          {detecting ? (
            <div className="text-xs text-text-tertiary">检测中…</div>
          ) : !workspacePath ? (
            <div className="text-xs text-text-tertiary">请先打开一个工作区</div>
          ) : !detection.available ? (
            <div className="text-xs text-text-tertiary">
              当前工作区未检测到 Spring Boot（Maven）项目。
              <div className="mt-1 text-text-muted">需包含 pom.xml 且含 spring-boot 依赖或插件。</div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-text-tertiary w-10 shrink-0">项目</span>
                <span className="text-green-400">已识别 Spring Boot</span>
              </div>
              {run.appName && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-tertiary w-10 shrink-0">应用</span>
                  <span className="text-text-secondary truncate">{run.appName}</span>
                </div>
              )}
              {run.port && phase === 'running' && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-tertiary w-10 shrink-0">端口</span>
                  <a
                    href={`http://localhost:${run.port}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    localhost:{run.port}
                  </a>
                </div>
              )}
              {mode === 'debug' && jdwpPort && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-tertiary w-10 shrink-0">调试</span>
                  <span className="text-orange-400">JDWP :{jdwpPort}（远程调试器可 attach）</span>
                </div>
              )}
              {run.startedInSeconds != null && phase === 'running' && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-tertiary w-10 shrink-0">启动</span>
                  <span className="text-text-secondary">{run.startedInSeconds.toFixed(2)}s</span>
                </div>
              )}
              <div
                className="text-[11px] text-text-muted font-mono truncate pt-0.5"
                title={detection.runCommand ?? ''}
              >
                {detection.runCommand}
              </div>
            </div>
          )}
        </div>

        {/* 运行控制 */}
        {detection.available && (
          <div className="p-3 border-b border-border flex flex-wrap gap-2">
            <button
              onClick={handle(() => start('run'), '运行')}
              disabled={isRunning}
              className={`${BTN_BASE} bg-green-600/15 text-green-300 hover:bg-green-600/25 border-green-700/40`}
            >
              <Play size={13} /> 运行
            </button>
            <button
              onClick={handle(startDebug, '调试')}
              disabled={isRunning || debugActive}
              className={`${BTN_BASE} bg-orange-600/15 text-orange-300 hover:bg-orange-600/25 border-orange-700/40`}
              title="内置断点调试：在 Java 源码行号设断点，命中后查看调用栈/变量、单步执行"
            >
              <Bug size={13} /> 调试
            </button>
            <button
              onClick={handle(debugActive ? stopDebug : stop, '停止')}
              disabled={!isRunning && !debugActive}
              className={`${BTN_BASE} bg-[#2d2d2d] text-text-secondary hover:bg-[#3c3c3c] border-[#3c3c3c]`}
            >
              <Square size={13} /> 停止
            </button>
            <button
              onClick={handle(restart, '重启')}
              disabled={!isRunning}
              className={`${BTN_BASE} bg-[#2d2d2d] text-text-secondary hover:bg-[#3c3c3c] border-[#3c3c3c]`}
            >
              <RotateCcw size={13} /> 重启
            </button>
          </div>
        )}

        {/* 内置断点调试 */}
        <DebugView />

        {/* 日志 */}
        <div className="p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-text-tertiary uppercase tracking-wider">日志</span>
            <button
              onClick={clearLog}
              className="text-text-muted hover:text-text-secondary"
              title="清空日志"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <pre className="text-[11px] leading-relaxed text-text-secondary font-mono whitespace-pre-wrap break-all bg-[#151515] border border-[#3c3c3c] rounded p-2 min-h-[80px] max-h-[45vh] overflow-y-auto">
            {logTail || '（运行后在此显示启动日志…完整终端见 Terminal 面板）'}
          </pre>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 border-t border-red-900/40 bg-red-950/30 flex items-center justify-between gap-2 text-xs text-red-200 shrink-0">
          <span className="truncate">{error}</span>
          <button className="px-2 hover:bg-red-900/40 rounded shrink-0" onClick={clearError}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}

export default SpringBootRunnerPanel;
