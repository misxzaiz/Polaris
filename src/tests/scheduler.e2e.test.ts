/**
 * E2E 测试配置指南
 *
 * 此项目推荐使用 Playwright 进行 E2E 测试。
 * 由于 Tauri 应用的特殊性，E2E 测试需要特殊配置。
 *
 * 安装步骤:
 * 1. 安装 Playwright: npm install -D @playwright/test
 * 2. 安装 Tauri Driver: 参考 https://tauri.app/v1/guides/testing/integration/
 * 3. 运行测试: npx playwright test
 *
 * 下面的测试用例是 E2E 测试的示例模板。
 */

import { describe, it, expect } from 'vitest';

/**
 * Tauri E2E 测试说明
 *
 * 由于 Tauri 应用使用 WebView 而非浏览器，传统 E2E 工具需要特殊适配。
 * 推荐使用以下方式之一:
 *
 * 1. Tauri 官方测试工具 (tauri-driver):
 *    - 支持 WebDriver 协议
 *    - 可以测试原生窗口和 WebView
 *
 * 2. Playwright + Tauri 集成:
 *    - 使用 @playwright/test 的 browser context
 *    - 需要启动 Tauri 应用作为被测目标
 *
 * 3. Spectron (Electron) 类似方案:
 *    - 使用 WebDriverIO
 *    - 可直接操作应用窗口
 */

describe('Scheduler E2E Test Templates', () => {
  /**
   * 注意: 这些测试需要 Tauri 应用运行环境
   * 在 CI/CD 环境中需要特殊配置
   */

  describe('Task Management E2E', () => {
    it.skip('should create a simple task via UI', async () => {
      /**
       * E2E 测试步骤:
       * 1. 启动应用
       * 2. 导航到调度器页面
       * 3. 点击"创建任务"按钮
       * 4. 填写任务表单
       * 5. 保存并验证
       */
      // 示例伪代码:
      // await page.click('[data-testid="create-task-button"]');
      // await page.fill('[data-testid="task-name-input"]', 'E2E Test Task');
      // await page.selectOption('[data-testid="trigger-type-select"]', 'interval');
      // await page.fill('[data-testid="trigger-value-input"]', '5m');
      // await page.click('[data-testid="save-task-button"]');
      // const taskName = await page.textContent('[data-testid="task-name"]');
      // expect(taskName).toContain('E2E Test Task');
      expect(true).toBe(true);
    });

    it.skip('should create a protocol mode task with template', async () => {
      /**
       * 协议模式任务创建测试
       * 1. 选择协议模式
       * 2. 选择模板
       * 3. 填写模板参数
       * 4. 验证文档生成
       */
      expect(true).toBe(true);
    });

    it.skip('should toggle task enabled state', async () => {
      /**
       * 任务启用/禁用测试
       */
      expect(true).toBe(true);
    });

    it.skip('should delete task after confirmation', async () => {
      /**
       * 删除任务测试
       * 需要确认对话框处理
       */
      expect(true).toBe(true);
    });
  });

  describe('Template Management E2E', () => {
    it.skip('should display builtin templates', async () => {
      /**
       * 内置模板显示测试
       */
      expect(true).toBe(true);
    });

    it.skip('should create custom template', async () => {
      /**
       * 创建自定义模板测试
       */
      expect(true).toBe(true);
    });

    it.skip('should edit custom template', async () => {
      /**
       * 编辑自定义模板测试
       */
      expect(true).toBe(true);
    });

    it.skip('should delete custom template', async () => {
      /**
       * 删除自定义模板测试
       * 验证内置模板不能删除
       */
      expect(true).toBe(true);
    });
  });

  describe('Protocol Documents E2E', () => {
    it.skip('should display protocol document viewer', async () => {
      /**
       * 协议文档查看器测试
       */
      expect(true).toBe(true);
    });

    it.skip('should edit user supplement', async () => {
      /**
       * 用户补充编辑测试
       */
      expect(true).toBe(true);
    });

    it.skip('should view memory index and tasks', async () => {
      /**
       * 记忆文件查看测试
       */
      expect(true).toBe(true);
    });
  });

  describe('Scheduler Lifecycle E2E', () => {
    it.skip('should start and stop scheduler', async () => {
      /**
       * 调度器生命周期测试
       */
      expect(true).toBe(true);
    });

    it.skip('should show scheduler status correctly', async () => {
      /**
       * 调度器状态显示测试
       */
      expect(true).toBe(true);
    });
  });
});

/**
 * E2E 测试工具函数
 * 实际使用时需要根据选择的 E2E 框架进行调整
 */
export const E2ETestUtils = {
  /**
   * 等待元素出现
   */
  waitForElement: async (selector: string, timeout = 5000): Promise<void> => {
    // 实现取决于 E2E 框架
    console.log(`Waiting for element: ${selector} (timeout: ${timeout}ms)`);
  },

  /**
   * 等待元素消失
   */
  waitForElementHidden: async (selector: string, timeout = 5000): Promise<void> => {
    console.log(`Waiting for element to hide: ${selector} (timeout: ${timeout}ms)`);
  },

  /**
   * 模拟用户输入
   */
  fillForm: async (data: Record<string, string>): Promise<void> => {
    console.log('Filling form with data:', data);
  },

  /**
   * 点击按钮
   */
  clickButton: async (testId: string): Promise<void> => {
    console.log(`Clicking button: ${testId}`);
  },

  /**
   * 验证文本内容
   */
  verifyText: async (selector: string, expectedText: string): Promise<boolean> => {
    console.log(`Verifying text in ${selector}: ${expectedText}`);
    return true;
  },

  /**
   * 截图
   */
  takeScreenshot: async (name: string): Promise<void> => {
    console.log(`Taking screenshot: ${name}`);
  },
};

/**
 * 测试数据工厂
 */
export const E2ETestDataFactory = {
  createSimpleTaskData: () => ({
    name: `E2E Simple Task ${Date.now()}`,
    triggerType: 'interval' as const,
    triggerValue: '5m',
    engineId: 'claude-code',
    prompt: 'E2E test prompt',
    mode: 'simple' as const,
  }),

  createProtocolTaskData: () => ({
    name: `E2E Protocol Task ${Date.now()}`,
    triggerType: 'interval' as const,
    triggerValue: '1h',
    engineId: 'claude-code',
    prompt: '',
    mode: 'protocol' as const,
    category: 'development' as const,
    mission: 'E2E test mission',
    templateId: 'dev-feature',
    templateParams: { mission: 'Test feature implementation' },
  }),

  createCustomTemplateData: () => ({
    name: `E2E Custom Template ${Date.now()}`,
    description: 'E2E test template description',
    category: 'custom' as const,
    protocolConfig: {
      missionTemplate: 'E2E Test: {mission}',
      executionRules: '1. Step one\n2. Step two',
      memoryRules: '## Memory\n- Remember this',
    },
    params: [
      {
        key: 'mission',
        label: 'Mission',
        type: 'textarea' as const,
        required: true,
      },
    ],
  }),
};
