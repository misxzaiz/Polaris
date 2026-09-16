/**
 * 临时验证：configPatchTop / configPatch 在 Tauri 模式下
 * 收到裸 Config（config_patch_via_bus 真实返回形态）时不再抛
 * "cap.config patch 失败"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/services/transport', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  currentMode: 'tauri',
}));

import { configPatchTop, configPatch } from '@/services/configDispatchService';

const FAKE_CONFIG = {
  performance: { fileWatcher: true, schedulerDaemon: true },
  workspaces: [],
};

describe('configDispatchService tauri branch', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('configPatchTop: 裸 Config 返回时原样透传，不抛错', async () => {
    invokeMock.mockResolvedValue(FAKE_CONFIG);
    const saved = await configPatchTop({ performance: { fileWatcher: true } });
    expect(saved).toEqual(FAKE_CONFIG);
    expect(invokeMock).toHaveBeenCalledWith('config_patch_via_bus', {
      req: {
        target: 'cap.config',
        payload: { action: 'patch', patch: { performance: { fileWatcher: true } } },
      },
    });
  });

  it('configPatch: 裸 Config 返回时原样透传，不抛错', async () => {
    invokeMock.mockResolvedValue(FAKE_CONFIG);
    const saved = await configPatch('performance', { fileWatcher: true });
    expect(saved).toEqual(FAKE_CONFIG);
    expect(invokeMock).toHaveBeenCalledWith('config_patch_via_bus', {
      req: {
        target: 'cap.config',
        payload: { action: 'patch', section: 'performance', value: { fileWatcher: true } },
      },
    });
  });

  it('Rust 命令 reject 时仍按原样抛错（保留 catch 语义）', async () => {
    invokeMock.mockRejectedValue(new Error('config patch 失败: IO'));
    await expect(configPatchTop({ performance: { fileWatcher: true } })).rejects.toThrow(
      'config patch 失败: IO',
    );
  });
});
