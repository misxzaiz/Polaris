/// <reference types="vitest/globals" />
import '@testing-library/jest-dom';

/**
 * Vitest 测试配置 - 全局 Setup
 *
 * 本文件配置测试环境的全局 mock 和 polyfill。
 *
 * ## Vitest Mock 机制说明
 *
 * 1. **vi.mock 提升机制**：
 *    - `vi.mock()` 调用会被静态分析并移动到文件顶部
 *    - 在 setupFiles 中定义的 mock 会影响所有测试文件
 *    - 测试文件中的 mock 会覆盖 setupFiles 中的 mock
 *
 * 2. **模块隔离**：
 *    - Vitest 4.x 默认 `isolate: true`，每个测试文件在隔离环境中运行
 *    - 如果需要在特定测试文件中使用真实模块，使用 `vi.unmock()`
 *
 * 3. **单例模块测试策略**：
 *    - 需要测试真实单例逻辑时：使用 `vi.unmock()` + 提供 `reset*()` 函数
 *    - 只需要模块存在时：使用 `vi.mock()` 返回 mock 实例
 *    - 单例需要状态重置时：提供 `clear()`/`reset()` 函数
 *
 * 4. **最佳实践**：
 *    - 在 beforeEach 中调用 vi.clearAllMocks() 清理调用记录
 *    - 在 afterEach 中重置单例状态（如有 reset 函数）
 *    - 避免 mock 同一模块的不同版本，统一使用此文件的 mock
 */

// ============================================================
// Tauri API Mocks
// ============================================================

/**
 * Mock @tauri-apps/api/core
 *
 * 用于测试中调用 Tauri invoke 命令的场景。
 * 测试文件可通过 vi.mocked(invoke).mockResolvedValue() 设置返回值。
 */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  // `convertFileSrc` is used by code that converts local paths into webview
  // URLs (image previews, plugin asset loading). Tests don't need it to do
  // anything special — passing the path through is enough for unit-test scope.
  convertFileSrc: vi.fn((path: string) => path),
}));

/**
 * Mock @tauri-apps/api/event
 *
 * 用于测试 Tauri 事件监听和发送场景。
 * listen() 返回的 unlisten 函数可用于清理监听器。
 *
 * 该文件通过 vi.unmock + vi.mock 覆盖此全局 mock。
 */
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));

/**
 * Mock @tauri-apps/plugin-opener
 *
 * 用于测试在默认应用中打开文件/路径的场景。
 */
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(() => Promise.resolve()),
}));

/**
 * Mock @tauri-apps/plugin-dialog
 *
 * 用于测试文件保存对话框场景。
 */
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));

/**
 * Mock @tauri-apps/api/window
 *
 * 用于测试窗口控制场景（最小化、最大化、关闭）。
 */
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    minimize: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(() => Promise.resolve()),
    unmaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
  })),
}));

// ============================================================
// Browser API Polyfills
// ============================================================

// ============================================================
// i18n Mocks
// ============================================================

/**
 * Mock react-i18next
 *
 * 用于测试使用 useTranslation hook 的组件。
 * 返回简单的翻译函数，支持 key 和 options 参数。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      // 简单翻译：返回 key 或替换占位符
      if (options) {
        return Object.entries(options).reduce(
          (str, [k, v]) => str.replace(`{{${k}}}`, String(v)),
          key
        );
      }
      return key;
    },
    i18n: {
      language: 'zh-CN',
      changeLanguage: vi.fn(),
    },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
}));

/**
 * Mock i18n 模块
 *
 * 用于测试直接导入 i18n 的模块（如 toolSummary.ts）。
 */
vi.mock('../i18n', () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) => {
      if (options) {
        return Object.entries(options).reduce(
          (str, [k, v]) => str.replace(`{{${k}}}`, String(v)),
          key
        );
      }
      return key;
    },
    language: 'zh-CN',
    changeLanguage: vi.fn(),
  },
}));

// ============================================================
// Browser API Polyfills
// ============================================================

/**
 * Polyfill window.matchMedia
 *
 * 用于测试使用媒体查询的组件（如响应式布局）。
 * 默认返回不匹配任何查询的状态。
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
