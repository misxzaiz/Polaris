/**
 * Spring Boot 启动日志解析（纯函数，无副作用）。
 *
 * 由 springBootStore 逐行喂入 PTY（terminal:output）解码后的日志，
 * 增量推导运行状态：starting → running(:port) / failed。
 *
 * 设计为纯函数以便 vitest 单测，不依赖任何运行时/DOM。
 */

export type SpringBootPhase = 'idle' | 'starting' | 'running' | 'failed' | 'stopped';

export interface SpringBootRunState {
  phase: SpringBootPhase;
  /** 运行时监听端口（从 "started on port(s): N" 解析） */
  port?: number;
  /** 应用主类名（从 "Starting XxxApplication" 或 "Started XxxApplication" 解析） */
  appName?: string;
  /** 启动耗时秒数（从 "Started ... in N seconds" 解析） */
  startedInSeconds?: number;
}

export function createRunState(phase: SpringBootPhase = 'idle'): SpringBootRunState {
  return { phase };
}

// 失败信号：应用上下文启动失败 / 端口占用 / 构建失败
const FAILURE_RE =
  /APPLICATION FAILED TO START|Error starting ApplicationContext|Web server failed to start|Port \d+ was already in use|BUILD FAILURE/i;

// "Starting DemoApplication using Java 17" / "Starting App on HOST with PID"
const STARTING_RE = /Starting\s+([\w.$]+?)(?:\s+using|\s+on|\s+v\d|\s+with)/;

// "Tomcat started on port(s): 8080 (http)" / "Netty started on port 8080" / probe 的 "port(s): 18080"
const PORT_RE = /started on port\(?s?\)?:?\s*(\d+)/i;

// "Started DemoApplication in 2.345 seconds (JVM running for 2.789)"
const STARTED_RE = /Started\s+([\w.$]+)\s+in\s+([\d.]+)\s+seconds/;

/**
 * 根据单行日志增量更新运行状态。
 * 返回新对象（不可变）；无匹配时原样返回（引用不变，便于上层跳过 setState）。
 */
export function parseSpringBootLogLine(line: string, prev: SpringBootRunState): SpringBootRunState {
  // 失败优先级最高
  if (FAILURE_RE.test(line)) {
    return prev.phase === 'failed' ? prev : { ...prev, phase: 'failed' };
  }

  let next = prev;

  const starting = STARTING_RE.exec(line);
  if (starting) {
    next = next === prev ? { ...prev } : next;
    next.appName = starting[1];
  }

  const port = PORT_RE.exec(line);
  if (port) {
    next = next === prev ? { ...prev } : next;
    next.port = Number(port[1]);
  }

  const started = STARTED_RE.exec(line);
  if (started) {
    next = next === prev ? { ...prev } : next;
    next.phase = 'running';
    next.startedInSeconds = Number(started[2]);
    if (!next.appName) next.appName = started[1];
  }

  return next;
}

/** 便捷封装：把一段（可能多行）文本逐行喂入解析器。 */
export function parseSpringBootLogChunk(chunk: string, prev: SpringBootRunState): SpringBootRunState {
  let state = prev;
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length === 0) continue;
    state = parseSpringBootLogLine(line, state);
  }
  return state;
}

// ANSI 转义序列（CSI：颜色/光标控制）。Spring Boot / Maven 在 PTY(TTY) 下默认输出颜色，
// 而面板用 <pre> 裸显示会把这些码显示为乱码，故在写入日志前剥离。
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 去除 ANSI 转义序列，避免在非终端组件中裸显示为乱码。 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}
