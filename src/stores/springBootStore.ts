/**
 * Spring Boot Runner 状态管理
 *
 * 复用 Polaris 既有能力，不重造进程引擎：
 * - 检测：terminal_discover_scripts（已识别 Maven Spring Boot 项目，生成 spring-boot:run）
 * - 运行/停止：useTerminalStore 的 createSession / closeSession（portable-pty）
 * - 状态识别：监听 terminal:output，解码后喂 logParser 推导 starting→running(:port)/failed
 *
 * 聚焦 Maven（暂不支持 Gradle）。
 */

import { create } from 'zustand';
import { invoke, listen } from '@/services/transport';
import { useTerminalStore } from './terminalStore';
import type { DiscoveredTerminalScript } from '@/types/terminalScript';
import type { TerminalOutputEvent, TerminalExitEvent } from '@/types/terminal';
import {
  parseSpringBootLogChunk,
  createRunState,
  stripAnsi,
  type SpringBootRunState,
} from '@/plugins/spring-boot/logParser';
import { createLogger } from '@/utils/logger';

const log = createLogger('SpringBootStore');

const JDWP_JVM_ARG = '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:0';
const JDWP_READY_RE = /Listening for transport dt_socket at address:\s*(\d+)/;
/** 统一子进程输出 UTF-8 并关闭 ANSI 颜色，规避 Windows 控制台乱码 */
const ENCODING_JVM_ARG = '-Dfile.encoding=UTF-8';
const NO_ANSI_JVM_ARG = '-Dspring.output.ansi.enabled=never';
/** 面板内日志 tail 上限（字符），避免无限增长占用内存 */
const MAX_LOG_CHARS = 16000;

export type SpringBootRunMode = 'run' | 'debug';

interface SpringBootDetection {
  available: boolean;
  runCommand: string | null;
  cwd: string | null;
  sourcePath: string | null;
}

interface SpringBootState {
  workspacePath: string | null;
  detection: SpringBootDetection;
  detecting: boolean;
  run: SpringBootRunState;
  mode: SpringBootRunMode | null;
  sessionId: string | null;
  jdwpPort: number | null;
  logTail: string;
  error: string | null;

  detect: (workspacePath: string | null) => Promise<void>;
  start: (mode: SpringBootRunMode) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  clearLog: () => void;
  clearError: () => void;
  initListeners: () => () => void;
}

const emptyDetection: SpringBootDetection = {
  available: false,
  runCommand: null,
  cwd: null,
  sourcePath: null,
};

/** base64(bytes) → 文本。优先 UTF-8；Windows Maven/cmd 输出偶发 GBK/GB18030 时自动降级。 */
export function decodeTerminalBase64Text(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        return new TextDecoder('gb18030').decode(bytes);
      } catch {
        try {
          return new TextDecoder('gbk').decode(bytes);
        } catch {
          return new TextDecoder('utf-8').decode(bytes);
        }
      }
    }
  } catch {
    return '';
  }
}

/**
 * 构造运行命令：
 * - `-B`：Maven 批处理模式，关闭其自身颜色 / 下载进度条（乱码主因之一）
 * - 应用 JVM 参数通过 JAVA_TOOL_OPTIONS 注入，避免 Windows cmd/mvnw.cmd 解析
 *   `-Dspring-boot.run.jvmArguments="a=b c=d"` 时出现 `=UTF-8 was unexpected`。
 */
function buildCommand(runCommand: string, mode: SpringBootRunMode): string {
  const debugArg = mode === 'debug' ? ` -Dspring-boot.run.jvmArguments=${JDWP_JVM_ARG}` : '';
  return `${runCommand} -B${debugArg}`;
}

function buildEnv(_mode: SpringBootRunMode): Record<string, string> {
  return {
    MAVEN_OPTS: ENCODING_JVM_ARG,
    JAVA_TOOL_OPTIONS: [ENCODING_JVM_ARG, NO_ANSI_JVM_ARG].join(' '),
  };
}

export const useSpringBootStore = create<SpringBootState>((set, get) => ({
  workspacePath: null,
  detection: emptyDetection,
  detecting: false,
  run: createRunState('idle'),
  mode: null,
  sessionId: null,
  jdwpPort: null,
  logTail: '',
  error: null,

  detect: async (workspacePath) => {
    set({ workspacePath, detecting: true, error: null });
    if (!workspacePath) {
      set({ detection: emptyDetection, detecting: false });
      return;
    }
    try {
      const scripts = await invoke<DiscoveredTerminalScript[]>('terminal_discover_scripts', { workspacePath });
      const runScript = scripts.find((s) => s.source === 'maven' && s.name === 'spring-boot:run');
      set({
        detection: {
          available: !!runScript,
          runCommand: runScript?.command ?? null,
          cwd: runScript?.cwd ?? workspacePath,
          sourcePath: runScript?.sourcePath ?? null,
        },
        detecting: false,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log.error('Spring Boot 检测失败', e instanceof Error ? e : new Error(error));
      set({ detection: emptyDetection, detecting: false, error });
    }
  },

  start: async (mode) => {
    const { detection } = get();
    if (!detection.available || !detection.runCommand) {
      throw new Error('当前工作区未检测到 Spring Boot（Maven）项目');
    }
    if (get().sessionId) {
      await get().stop();
    }

    const command = buildCommand(detection.runCommand, mode);
    set({
      run: createRunState('starting'),
      mode,
      jdwpPort: null,
      logTail: '',
      error: null,
    });

    try {
      const session = await useTerminalStore.getState().createSession({
        name: mode === 'debug' ? 'Spring Boot (Debug)' : 'Spring Boot',
        cwd: detection.cwd || get().workspacePath || undefined,
        initialCommand: command,
        env: buildEnv(mode),
        purpose: 'script',
      });
      set({ sessionId: session.id });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set((s) => ({ run: { ...s.run, phase: 'failed' }, error }));
      throw e;
    }
  },

  stop: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      await useTerminalStore.getState().closeSession(sessionId);
    } catch (e) {
      log.warn('停止 Spring Boot 会话失败', { error: String(e) });
    }
    set((s) => ({ sessionId: null, run: { ...s.run, phase: 'stopped' } }));
  },

  restart: async () => {
    const mode = get().mode ?? 'run';
    await get().stop();
    await get().start(mode);
  },

  clearLog: () => set({ logTail: '' }),
  clearError: () => set({ error: null }),

  initListeners: () => {
    const unlistenOutput = listen<TerminalOutputEvent>('terminal:output', (event) => {
      const { sessionId } = get();
      if (!sessionId || event.sessionId !== sessionId) return;
      const text = stripAnsi(decodeTerminalBase64Text(event.data));
      if (!text) return;
      set((s) => {
        const nextRun = parseSpringBootLogChunk(text, s.run);
        const ready = JDWP_READY_RE.exec(text);
        const jdwpPort = ready ? Number(ready[1]) : s.jdwpPort;
        const logTail = (s.logTail + text).slice(-MAX_LOG_CHARS);
        return nextRun === s.run && jdwpPort === s.jdwpPort ? { logTail } : { run: nextRun, jdwpPort, logTail };
      });
    });

    const unlistenExit = listen<TerminalExitEvent>('terminal:exit', (event) => {
      const { sessionId } = get();
      if (!sessionId || event.sessionId !== sessionId) return;
      set((s) => ({
        sessionId: null,
        run: {
          ...s.run,
          phase: s.run.phase === 'running' || event.exitCode === 0 ? 'stopped' : 'failed',
        },
      }));
    });

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
    };
  },
}));
