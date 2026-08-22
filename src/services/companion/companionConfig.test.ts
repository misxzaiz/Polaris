/**
 * CompanionConfig 单元测试
 *
 * 覆盖：加载、校验、回退、合并、更新
 */

import { describe, it, expect } from 'vitest';
import {
  CompanionConfigManager,
  LocalStorageConfigStorage,
  MemoryConfigStorage,
  validateCompanionConfig,
  resolveCompanionConfig,
  createDefaultConfig,
} from './companionConfig';
import { DEFAULT_COMPANION_CONFIG } from './types';

describe('validateCompanionConfig', () => {
  it('应接受合法配置', () => {
    const errors = validateCompanionConfig(createDefaultConfig());
    expect(errors).toEqual([]);
  });

  it('应拒绝空人格', () => {
    const config = createDefaultConfig();
    config.personality.systemPrompt = '短';
    const errors = validateCompanionConfig(config);
    expect(errors).toContainEqual(expect.stringContaining('systemPrompt'));
  });

  it('应拒绝静默日超出 0-6', () => {
    const config = createDefaultConfig();
    config.quietDays = [7];
    const errors = validateCompanionConfig(config);
    expect(errors).toContainEqual(expect.stringContaining('quietDays'));
  });

  it('应拒绝非法 maxDailyInteractions', () => {
    const config = createDefaultConfig();
    config.maxDailyInteractions = -1;
    const errors = validateCompanionConfig(config);
    expect(errors).toContainEqual(expect.stringContaining('maxDailyInteractions'));
  });

  it('应拒绝非法 difficultLevel', () => {
    const config = createDefaultConfig();
    config.difficultyLevel = 'hard' as never;
    const errors = validateCompanionConfig(config);
    expect(errors).toContainEqual(expect.stringContaining('difficultyLevel'));
  });
});

describe('resolveCompanionConfig', () => {
  it('传入 null 应返回默认配置', () => {
    const { config, errors } = resolveCompanionConfig(null);
    expect(errors).toEqual([]);
    expect(config.enabled).toBe(true);
  });

  it('应合并部分配置', () => {
    const { config, errors } = resolveCompanionConfig({ enabled: false });
    expect(errors).toEqual([]);
    expect(config.enabled).toBe(false);
    expect(config.personality.name).toBe(DEFAULT_COMPANION_CONFIG.personality.name);
  });

  it('非法字段应回退到默认值', () => {
    const { config, errors } = resolveCompanionConfig({
      maxDailyInteractions: -1,
      // @ts-expect-error 测试非法值
      activeWindowStart: '25:00',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(config.maxDailyInteractions).toBe(DEFAULT_COMPANION_CONFIG.maxDailyInteractions);
    expect(config.activeWindowStart).toBe(DEFAULT_COMPANION_CONFIG.activeWindowStart);
  });
});

describe('CompanionConfigManager', () => {
  it('应使用 MemoryConfigStorage 读写', () => {
    const storage = new MemoryConfigStorage();
    const manager = new CompanionConfigManager(storage);

    // 初始加载 = 默认
    const config = manager.load();
    expect(config.enabled).toBe(true);

    // 更新
    const saved = manager.update({ enabled: false });
    expect(saved).toBe(true);

    // 重新加载
    const reloaded = manager.load();
    expect(reloaded.enabled).toBe(false);
  });

  it('应拒绝非法保存', () => {
    const storage = new MemoryConfigStorage();
    const manager = new CompanionConfigManager(storage);

    const config = createDefaultConfig();
    config.maxDailyInteractions = 999;
    const result = manager.save(config);
    expect(result).toBe(false);
  });

  it('reset 应恢复默认', () => {
    const storage = new MemoryConfigStorage();
    const manager = new CompanionConfigManager(storage);

    manager.update({ enabled: false });
    const resetConfig = manager.reset();
    expect(resetConfig.enabled).toBe(true);
  });
});

describe('LocalStorageConfigStorage (jsdom)', () => {
  it('应读写 localStorage', () => {
    const storage = new LocalStorageConfigStorage('test.polaris.companion');
    const config = createDefaultConfig();

    storage.save(config);

    const loaded = storage.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.enabled).toBe(true);
    expect(loaded!.personality.name).toBe(config.personality.name);
  });

  it('空存储应返回 null', () => {
    // 使用不同的 key 避免冲突
    const storage = new LocalStorageConfigStorage('test.polaris.companion.empty');
    expect(storage.load()).toBeNull();
  });
});