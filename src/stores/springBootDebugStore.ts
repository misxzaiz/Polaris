/**
 * Spring Boot 内置断点调试会话。
 *
 * 复用既有能力、不重造：
 *   1. springBootStore.start('debug') 以 JDWP server 模式启动应用（已注入 -agentlib:jdwp ...:0，动态端口）
 *   2. 监听其日志，出现 "Listening for transport dt_socket at address: N" 即 JVM 调试就绪
 *   3. invoke('spring_boot_debug_start') 拉起 JDI 代理（PolarisDebugAgent）attach 该端口
 *   4. 代理 ready 后下发断点；命中 → 结构化 stopped 事件（调用栈 + 变量）
 *
 * 与上一版（jdb 文本解析）相比：底层换为 JDI 代理 + 结构化 JSON，稳健可控；
 * 接口（startDebug/stopDebug/断点/单步/继续）保持不变。
 */

import { create } from 'zustand';
import { invoke, listen } from '@/services/transport';
import { useSpringBootStore, decodeTerminalBase64Text } from './springBootStore';
import { stripAnsi } from '@/plugins/spring-boot/logParser';
import {
  parseDebugEvent,
  DebugCmd,
  deriveClassName,
  type DebugFrame,
  type DebugVariable,
} from '@/plugins/spring-boot/debugProtocol';
import type { TerminalOutputEvent } from '@/types/terminal';
import { createLogger } from '@/utils/logger';
import { generateUUID } from '@/utils/uuid';

const log = createLogger('SpringBootDebug');

/** JVM 调试代理就绪标志（应用日志） */
const JDWP_READY_RE = /Listening for transport dt_socket at address:\s*(\d+)/;

export type DebugPhase =
  | 'idle' | 'launching' | 'attaching' | 'running' | 'suspended' | 'stopped' | 'error';

export interface Breakpoint {
  id: string;
  /** 源文件绝对路径；手动断点可以为空 */
  file?: string;
  line: number;
  /** Java 全限定类名 */
  className: string;
  verified: boolean;
  source: 'editor' | 'manual';
  message?: string | null;
}

export interface DebugStop {
  reason: 'breakpoint' | 'step';
  thread: string;
  /** 命中所在源文件绝对路径（按断点反查；跨类 step 可能为空） */
  file?: string;
  line: number;
  className: string;
}

interface DebugState {
  phase: DebugPhase;
  breakpoints: Breakpoint[];
  stop: DebugStop | null;
  frames: DebugFrame[];
  variables: DebugVariable[];
  /** objectId -> 展开后的子变量 */
  children: Record<number, DebugVariable[]>;
  /** 已展开的 objectId */
  expanded: number[];
  jdwpPort: number | null;
  agentReady: boolean;
  error: string | null;

  startDebug: () => Promise<void>;
  stopDebug: () => Promise<void>;
  toggleBreakpoint: (file: string, line: number, content: string) => void;
  addManualBreakpoint: (className: string, line: number) => void;
  removeBreakpoint: (id: string) => void;
  hasBreakpoint: (file: string, line: number) => boolean;
  resume: () => void;
  stepOver: () => void;
  stepInto: () => void;
  stepOut: () => void;
  toggleExpand: (objectId: number) => void;
  clearError: () => void;
  initListeners: () => () => void;
}

/** 代理是否已 attach（控制断点是否即时下发） */
let attached = false;

function send(cmd: string) {
  void invoke('spring_boot_debug_send', { line: cmd }).catch((e) =>
    log.warn('发送调试命令失败', { cmd, error: String(e) }));
}

/** 命中类名 → 源文件：按已设断点反查（顶层类匹配，忽略内部类 $ 后缀）。 */
function resolveFile(className: string, bps: Breakpoint[]): string | undefined {
  const top = className.split('$')[0];
  return bps.find((b) => b.className === className || b.className === top)?.file;
}

function attachAgent(port: number) {
  const st = useSpringBootDebugStore.getState();
  if (attached || st.phase === 'attaching' || st.agentReady) return;
  useSpringBootDebugStore.setState({ phase: 'attaching', jdwpPort: port });
  void invoke('spring_boot_debug_start', { port }).catch((e) =>
    useSpringBootDebugStore.setState({ phase: 'error', error: `attach 调试代理失败: ${e}` }));
}

const cleared: Partial<DebugState> = {
  stop: null,
  frames: [],
  variables: [],
  children: {},
  expanded: [],
};

export const useSpringBootDebugStore = create<DebugState>((set, get) => ({
  phase: 'idle',
  breakpoints: [],
  stop: null,
  frames: [],
  variables: [],
  children: {},
  expanded: [],
  jdwpPort: null,
  agentReady: false,
  error: null,

  startDebug: async () => {
    attached = false;
    set({ phase: 'launching', agentReady: false, jdwpPort: null, error: null, ...cleared });
    try {
      await useSpringBootStore.getState().start('debug');
      // Race 兜底：JDWP ready 日志可能早于 springBootStore.sessionId 写入，
      // 因此 start('debug') 返回后再读取 springBootStore 里已解析到的动态端口并尝试 attach。
      const port = useSpringBootStore.getState().jdwpPort;
      if (port) attachAgent(port);
    } catch (e) {
      set({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },

  stopDebug: async () => {
    attached = false;
    try { await invoke('spring_boot_debug_stop'); } catch { /* ignore */ }
    await useSpringBootStore.getState().stop().catch(() => {});
    set({ phase: 'stopped', agentReady: false, jdwpPort: null, ...cleared });
  },

  toggleBreakpoint: (file, line, content) => {
    const existing = get().breakpoints.find((b) => b.file === file && b.line === line);
    if (existing) { get().removeBreakpoint(existing.id); return; }
    const className = deriveClassName(file, content);
    const bp: Breakpoint = { id: generateUUID(), file, line, className, verified: false, source: 'editor' };
    set((s) => ({ breakpoints: [...s.breakpoints, bp] }));
    if (attached) send(DebugCmd.setBreakpoint(bp.id, className, line));
  },

  addManualBreakpoint: (className, line) => {
    const normalized = className.trim();
    if (!normalized || !Number.isFinite(line) || line < 1) return;
    const existing = get().breakpoints.find((b) => b.className === normalized && b.line === line && b.source === 'manual');
    if (existing) return;
    const bp: Breakpoint = { id: generateUUID(), className: normalized, line, verified: false, source: 'manual' };
    set((s) => ({ breakpoints: [...s.breakpoints, bp] }));
    if (attached) send(DebugCmd.setBreakpoint(bp.id, normalized, line));
  },

  removeBreakpoint: (id) => {
    const bp = get().breakpoints.find((b) => b.id === id);
    set((s) => ({ breakpoints: s.breakpoints.filter((b) => b.id !== id) }));
    if (bp && attached) send(DebugCmd.removeBreakpoint(id));
  },

  hasBreakpoint: (file, line) => get().breakpoints.some((b) => b.file === file && b.line === line),

  resume: () => { set({ phase: 'running', ...cleared }); send(DebugCmd.continue()); },
  stepOver: () => send(DebugCmd.stepOver()),
  stepInto: () => send(DebugCmd.stepInto()),
  stepOut: () => send(DebugCmd.stepOut()),

  toggleExpand: (objectId) => {
    const { expanded, children } = get();
    if (expanded.includes(objectId)) {
      set({ expanded: expanded.filter((id: number) => id !== objectId) });
    } else {
      set({ expanded: [...expanded, objectId] });
      if (!children[objectId]) send(DebugCmd.getChildren(objectId));
    }
  },

  clearError: () => set({ error: null }),

  initListeners: () => {
    // 1) 应用日志 → JDWP 就绪 → attach 代理
    const unOut = listen<TerminalOutputEvent>('terminal:output', (event) => {
      if (get().phase !== 'launching') return;
      if (event.sessionId !== useSpringBootStore.getState().sessionId) return;
      const text = stripAnsi(decodeTerminalBase64Text(event.data));
      if (text) {
        const ready = JDWP_READY_RE.exec(text);
        if (ready) {
          const port = Number(ready[1]);
          attachAgent(port);
        }
      }
    });

    const unSpring = useSpringBootStore.subscribe((s) => {
      if (get().phase === 'launching' && s.jdwpPort) attachAgent(s.jdwpPort);
    });

    // 2) 调试代理事件
    const unDbg = listen<string>('spring-boot-debug:event', (payload) => {
      const ev = parseDebugEvent(typeof payload === 'string' ? payload : String(payload));
      if (!ev) return;
      switch (ev.event) {
        case 'ready': {
          attached = true;
          set({ phase: 'running', agentReady: true });
          for (const bp of get().breakpoints) send(DebugCmd.setBreakpoint(bp.id, bp.className, bp.line));
          break;
        }
        case 'breakpoint': {
          set((s) => ({
            breakpoints: s.breakpoints.map((b) => (b.id === ev.id ? { ...b, verified: ev.verified, message: ev.message } : b)),
          }));
          break;
        }
        case 'stopped': {
          const top = ev.frames[0];
          const file = top ? resolveFile(top.class, get().breakpoints) : undefined;
          const stop: DebugStop = {
            reason: ev.reason,
            thread: ev.thread,
            file,
            line: top?.line ?? -1,
            className: top?.class ?? '',
          };
          set({ phase: 'suspended', stop, frames: ev.frames, variables: ev.variables, children: {}, expanded: [] });
          if (file && top) {
            window.dispatchEvent(new CustomEvent('spring-boot-debug:reveal', { detail: { file, line: top.line } }));
          }
          break;
        }
        case 'continued': set({ phase: 'running' }); break;
        case 'children': set((s) => ({ children: { ...s.children, [ev.objectId]: ev.variables } })); break;
        case 'terminated': attached = false; set({ phase: 'stopped', agentReady: false, ...cleared }); break;
        case 'error': set({ error: ev.message }); break;
        case 'log': log.info('[agent] ' + ev.message); break;
      }
    });

    return () => { unOut.then((f) => f()); unDbg.then((f) => f()); unSpring(); };
  },
}));
