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
