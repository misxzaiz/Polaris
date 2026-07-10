import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('transport index local events', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function importHttpTransportIndex(serverListen = vi.fn(async () => () => {})) {
    vi.doMock('./detector', () => ({
      detectTransport: () => 'http',
    }));
    vi.doMock('./httpTransport', () => ({
      createHttpTransport: () => ({
        invoke: vi.fn(),
        listen: serverListen,
        disconnect: vi.fn(),
        manualReconnect: vi.fn(),
      }),
    }));
    vi.doMock('./tauriTransport', () => ({
      tauriTransport: {
        invoke: vi.fn(),
        listen: vi.fn(async () => () => {}),
      },
    }));
    vi.doMock('./auth', () => ({
      getServerUrl: () => 'http://127.0.0.1:9830',
      storeServerUrl: vi.fn(),
    }));
    vi.doMock('../../stores/toastStore', () => ({
      useToastStore: {
        getState: () => ({
          error: vi.fn(() => 'toast-id'),
          success: vi.fn(),
          removeToast: vi.fn(),
        }),
      },
    }));

    return import('./index');
  }

  it('delivers file opened events locally in HTTP mode', async () => {
    const serverListen = vi.fn(async () => () => {});
    const { emit, listen } = await importHttpTransportIndex(serverListen);
    const handler = vi.fn();

    const unlisten = await listen<{ path: string; name: string }>('file:opened', handler);
    await emit('file:opened', { path: 'D:/workspace/a.ts', name: 'a.ts' });

    expect(handler).toHaveBeenCalledWith({ path: 'D:/workspace/a.ts', name: 'a.ts' });
    expect(serverListen).not.toHaveBeenCalled();

    unlisten();
    await emit('file:opened', { path: 'D:/workspace/b.ts', name: 'b.ts' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps backend events routed through HTTP transport in HTTP mode', async () => {
    const serverUnlisten = vi.fn();
    const serverListen = vi.fn(async () => serverUnlisten);
    const { listen } = await importHttpTransportIndex(serverListen);
    const handler = vi.fn();

    const unlisten = await listen('chat-event', handler);

    expect(serverListen).toHaveBeenCalledWith('chat-event', handler);

    unlisten();
    expect(serverUnlisten).toHaveBeenCalledTimes(1);
  });
});

describe('transport index mobile config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('rebuilds HTTP transport after mobile server config loads', async () => {
    const transports: Array<{
      invoke: ReturnType<typeof vi.fn>;
      listen: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      manualReconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const createHttpTransport = vi.fn((baseUrl: string) => {
      const transport = {
        invoke: vi.fn(),
        listen: vi.fn(async () => () => {}),
        disconnect: vi.fn(),
        manualReconnect: vi.fn(async () => {}),
      };
      transports.push(transport);
      return transport;
    });
    const mobileInvoke = vi.fn(async () => ({
      serverUrl: 'http://192.168.1.20:9830',
      token: 'token-md5',
    }));

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Android');

    vi.doMock('./detector', () => ({
      detectTransport: () => 'http',
    }));
    vi.doMock('./httpTransport', () => ({ createHttpTransport }));
    vi.doMock('./tauriTransport', () => ({
      tauriTransport: {
        invoke: vi.fn(),
        listen: vi.fn(async () => () => {}),
      },
    }));
    vi.doMock('./auth', async () => {
      const actual = await vi.importActual<typeof import('./auth')>('./auth');
      return actual;
    });
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: mobileInvoke,
    }));
    vi.doMock('../../stores/toastStore', () => ({
      useToastStore: {
        getState: () => ({
          error: vi.fn(() => 'toast-id'),
          success: vi.fn(),
          removeToast: vi.fn(),
        }),
      },
    }));

    await import('./index');
    await vi.waitFor(() => {
      expect(createHttpTransport).toHaveBeenCalledTimes(2);
    });

    expect(createHttpTransport).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(Object));
    expect(createHttpTransport).toHaveBeenNthCalledWith(2, 'http://192.168.1.20:9830', expect.any(Object));
    expect(transports[0].disconnect).toHaveBeenCalledTimes(1);
    expect(transports[1].manualReconnect).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('polaris_server_url')).toBe('http://192.168.1.20:9830');
    expect(localStorage.getItem('polaris_web_token_md5')).toBe('token-md5');

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
