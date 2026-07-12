import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpTransport } from './httpTransport';
import { storeTokenMd5 } from './auth';

describe('createHttpTransport', () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure token is empty by default
    storeTokenMd5('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  });

  it('sends the raw config object for update_config in HTTP mode', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');
    const config = {
      defaultEngine: 'claude-code',
      claudeCode: { cliPath: 'claude' },
      qqbot: { enabled: false, instances: [] },
      web: { enabled: true, host: '0.0.0.0', port: 9800 },
    };

    await transport.invoke('update_config', { config });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(config),
      })
    );
  });

  it('sends the raw patch object for update_config_patch in HTTP mode', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');
    const patch = {
      defaultEngine: 'codex',
      gitBinPath: null,
    };

    await transport.invoke('update_config_patch', { patch });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
    );
  });

  it('keeps non-config commands wrapped as their original argument objects', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    await transport.invoke('set_work_dir', { path: 'D:/workspace' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/api/set-work-dir',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'D:/workspace' }),
      })
    );
  });

  it('adds Authorization header when token md5 is set', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    storeTokenMd5('abc');
    await transport.invoke('health_check');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/api/health',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer abc',
        }),
      })
    );
  });

  it('throws an auth error with isAuthError=true on 401', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    try {
      await transport.invoke('health_check');
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error & { isAuthError: boolean }).isAuthError).toBe(true);
      expect((e as Error & { status: number }).status).toBe(401);
      expect((e as Error).message).toBe('Unauthorized');
    }

    // Stored token should be cleared
    expect(localStorage.getItem('polaris_web_token_md5')).toBe('');
  });

  it('throws an auth error with isAuthError=true on 403', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    try {
      await transport.invoke('health_check');
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect((e as Error & { isAuthError: boolean }).isAuthError).toBe(true);
      expect((e as Error & { status: number }).status).toBe(403);
    }
  });

  it('clears stale token on 401', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    // Pre-store a stale token
    storeTokenMd5('stale_md5_value');
    expect(localStorage.getItem('polaris_web_token_md5')).toBe('stale_md5_value');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    try {
      await transport.invoke('health_check');
    } catch {
      // Expected to throw
    }

    // Stored token should be cleared
    expect(localStorage.getItem('polaris_web_token_md5')).toBe('');
  });

  it('routes get_claude_code_session_history to the dedicated /history sub-path (not the list endpoint)', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    // Regression guard: this command must NOT be treated as a generic GET command.
    // It needs /api/claude-sessions/{sessionId}/history (returns the session's messages),
    // not /api/claude-sessions?sessionId=... which collides with the "list sessions"
    // endpoint and returns session metadata — silently breaking restore in Web mode.
    await transport.invoke('get_claude_code_session_history', {
      sessionId: 'abc-123',
      projectPath: 'D--space-base-Polaris',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/api/claude-sessions/abc-123/history',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('routes list_claude_code_sessions to the list endpoint with query params', async () => {
    const transport = createHttpTransport('http://127.0.0.1:9800');

    await transport.invoke('list_claude_code_sessions', {
      projectPath: 'D--space-base-Polaris',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9800/api/claude-sessions?projectPath=D--space-base-Polaris',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
