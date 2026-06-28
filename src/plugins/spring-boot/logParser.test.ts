import { describe, it, expect } from 'vitest';
import {
  parseSpringBootLogLine,
  parseSpringBootLogChunk,
  createRunState,
  stripAnsi,
  type SpringBootRunState,
} from './logParser';

function feed(lines: string[], from: SpringBootRunState = createRunState('starting')): SpringBootRunState {
  return lines.reduce((s, l) => parseSpringBootLogLine(l, s), from);
}

describe('parseSpringBootLogLine', () => {
  it('识别标准 Spring Boot 3.x 启动序列 → running + port + appName', () => {
    const state = feed([
      '2026-06-28 10:00:00.100  INFO 1 --- [main] com.example.demo.DemoApplication : Starting DemoApplication using Java 17.0.19',
      '2026-06-28 10:00:01.200  INFO 1 --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat started on port(s): 8080 (http) with context path \'\'',
      '2026-06-28 10:00:01.300  INFO 1 --- [main] com.example.demo.DemoApplication : Started DemoApplication in 1.523 seconds (JVM running for 1.9)',
    ]);
    expect(state.phase).toBe('running');
    expect(state.port).toBe(8080);
    expect(state.appName).toBe('DemoApplication');
    expect(state.startedInSeconds).toBeCloseTo(1.523);
  });

  it('识别免依赖探针(App.java)的真实日志格式', () => {
    const state = feed([
      '2026-06-28 02:13:01.715  INFO  --- [main] c.example.probe.App : Starting App using Java 17.0.19',
      '2026-06-28 02:13:02.694  INFO  --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat started on port(s): 18080 (http) with context path \'\'',
      '2026-06-28 02:13:02.696  INFO  --- [main] c.example.probe.App : Started App in 1.004 seconds (JVM running for 1.404)',
    ]);
    expect(state.phase).toBe('running');
    expect(state.port).toBe(18080);
    expect(state.appName).toBe('App');
  });

  it('端口占用 → failed', () => {
    const state = feed([
      '... Starting DemoApplication using Java 17',
      '*** Web server failed to start. Port 8080 was already in use.',
    ]);
    expect(state.phase).toBe('failed');
  });

  it('APPLICATION FAILED TO START → failed', () => {
    const state = feed(['***************************', 'APPLICATION FAILED TO START', '***************************']);
    expect(state.phase).toBe('failed');
  });

  it('Maven BUILD FAILURE → failed', () => {
    const state = feed(['[INFO] BUILD FAILURE']);
    expect(state.phase).toBe('failed');
  });

  it('仅端口行 → 更新 port，phase 保持 starting', () => {
    const state = parseSpringBootLogLine('Tomcat started on port 9090 (http)', createRunState('starting'));
    expect(state.port).toBe(9090);
    expect(state.phase).toBe('starting');
  });

  it('无关日志行 → 返回原引用（便于上层跳过更新）', () => {
    const prev = createRunState('starting');
    const next = parseSpringBootLogLine('Hibernate: select * from users', prev);
    expect(next).toBe(prev);
  });

  it('Netty 反应式端口格式', () => {
    const state = parseSpringBootLogLine('Netty started on port 8081', createRunState('starting'));
    expect(state.port).toBe(8081);
  });
});

describe('parseSpringBootLogChunk', () => {
  it('整段多行文本一次解析', () => {
    const chunk = [
      'Starting DemoApplication using Java 17',
      'Tomcat started on port(s): 8080 (http)',
      'Started DemoApplication in 2.0 seconds',
    ].join('\n');
    const state = parseSpringBootLogChunk(chunk, createRunState('starting'));
    expect(state.phase).toBe('running');
    expect(state.port).toBe(8080);
  });
});

describe('stripAnsi', () => {
  it('去除 ANSI 颜色码', () => {
    expect(stripAnsi('\x1b[32mStarted\x1b[0m App')).toBe('Started App');
  });

  it('去除复合 ANSI 序列', () => {
    expect(stripAnsi('\x1b[1;31mERROR\x1b[0m \x1b[2mdim\x1b[22m')).toBe('ERROR dim');
  });

  it('含 ANSI 的启动行剥离后仍能解析为 running', () => {
    const raw = '\x1b[32m2026-06-28 INFO\x1b[0m c.e.DemoApplication : Started DemoApplication in 1.0 seconds';
    const state = parseSpringBootLogLine(stripAnsi(raw), createRunState('starting'));
    expect(state.phase).toBe('running');
    expect(state.appName).toBe('DemoApplication');
  });
});
