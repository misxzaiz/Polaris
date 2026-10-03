import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFilePreviewUrl, buildSvgBlobUrl } from './fileService';

/**
 * buildFilePreviewUrl 双模式 URL 生成测试。
 *
 * 桌面 Tauri（__TAURI_INTERNALS__ 存在）→ asset:// 协议。
 * Web 模式（无 Tauri）→ 后端 /api/files/* HTTP 路由 + token query。
 */

function setTauriEnv(value: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (value) {
    w.__TAURI_INTERNALS__ = { convertFileSrc: () => 'asset://local/x' };
  } else {
    delete w.__TAURI_INTERNALS__;
  }
}

function setLocalStorage(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

describe('buildFilePreviewUrl', () => {
  beforeEach(() => {
    setTauriEnv(false);
    setLocalStorage('polaris_server_url', null);
    setLocalStorage('polaris_web_token_md5', null);
  });

  afterEach(() => {
    setTauriEnv(false);
    setLocalStorage('polaris_server_url', null);
    setLocalStorage('polaris_web_token_md5', null);
  });

  it('returns empty when filePath is empty', () => {
    expect(buildFilePreviewUrl('')).toBe('');
  });

  it('web mode: uses origin /api/files when no server url stored', () => {
    // jsdom 里 window.location.origin 是 http://localhost:3000
    const url = buildFilePreviewUrl('C:\\Users\\me\\pic.png');
    expect(url.startsWith('http://localhost:3000/api/files/')).toBe(true);
    expect(url).toContain('pic.png');
  });

  it('web mode: appends token md5 when token configured', () => {
    setLocalStorage('polaris_server_url', 'http://192.168.1.5:9829');
    setLocalStorage('polaris_web_token_md5', 'abc123');
    const url = buildFilePreviewUrl('C:\\Users\\me\\video.mp4');
    expect(url.startsWith('http://192.168.1.5:9829/api/files/')).toBe(true);
    expect(url).toContain('?token=abc123');
  });

  it('web mode: no token query when token is empty', () => {
    setLocalStorage('polaris_server_url', 'http://192.168.1.5:9829');
    const url = buildFilePreviewUrl('C:\\a\\b.png');
    expect(url).not.toContain('?token=');
  });

  it('web mode: encodes path segments', () => {
    setLocalStorage('polaris_server_url', 'http://localhost:9829');
    const url = buildFilePreviewUrl('C:\\Users\\me\\my pic.png');
    // 冒号按 URI 规范编码为 %3A（浏览器/后端均正确解码，安全且规范）
    expect(url).toContain('/api/files/C%3A/Users/me/my%20pic.png');
  });

  it('tauri mode: returns asset protocol url', () => {
    setTauriEnv(true);
    // 模拟 convertFileSrc
    (window as unknown as { __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string } })
      .__TAURI_INTERNALS__.convertFileSrc = (p: string) => `asset://local/${p}`;
    const url = buildFilePreviewUrl('C:\\Users\\me\\pic.png');
    expect(url.startsWith('asset://local/')).toBe(true);
  });
});

describe('buildSvgBlobUrl', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-svg-url');
  });

  afterEach(() => {
    vi.mocked(URL.createObjectURL).mockRestore();
  });

  it('returns empty when filePath is empty', async () => {
    expect(await buildSvgBlobUrl('')).toBe('');
  });

  it('reads file content and returns blob url with svg mime', async () => {
    const reader = vi.fn().mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"/>');

    const url = await buildSvgBlobUrl('C:\\a\\icon.svg', reader);
    expect(reader).toHaveBeenCalledWith('C:\\a\\icon.svg');
    expect(url).toBe('blob:mock-svg-url');

    // 校验 Blob 的 MIME 类型（createObjectURL 收到的第一个参数）
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toContain('<svg');
  });

  it('returns empty when read fails', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('read fail'));
    expect(await buildSvgBlobUrl('C:\\a\\broken.svg', reader)).toBe('');
  });
});
