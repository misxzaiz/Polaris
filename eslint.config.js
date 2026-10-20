// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // 全局忽略
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src-tauri/**',
      '*.config.js',
      '*.config.ts',
      'docs-site/**',
      '.codex-test/**',
      // 构建产物与临时目录（避免 lint 扫描 minified 输出）
      'target*/**',
      'temp/**',
      '.polaris-*/**',
      'Polaris-test/**',
      // 通用构建产物：任意子目录 dist/build/gen（minified/第三方/生成代码）
      '**/dist/**',
      '**/build/**',
      '**/gen/**',
      'polaris-mobile/dist/**',
      'polaris-pocket/dist/**',
      // 临时脚本目录（一次性诊断/调试脚本，非产品代码）
      'scripts/tmp/**',
      'examples/**',
      // Claude 工作区（worktrees 内的第三方产物 / dist）
      '.claude/**',
      // 独立演示/迷你项目（minified lib + 输出截图）
      'glass-micro-world/**',
    ],
  },
  // 基础推荐规则
  eslint.configs.recommended,
  // TypeScript 推荐规则
  ...tseslint.configs.recommended,
  // React 配置
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React 规则
      'react/react-in-jsx-scope': 'off', // React 17+ 不需要导入 React
      'react/prop-types': 'off', // 使用 TypeScript，不需要 prop-types
      'react/jsx-uses-react': 'off',
      'react/jsx-uses-vars': 'error',
      'react/no-deprecated': 'warn',
      'react/no-unknown-property': ['error', { ignore: ['tw'] }], // 支持 Tailwind

      // React Hooks 规则
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // TypeScript 规则调整
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // 结构化日志：禁止 console.log/info/debug，保留 console.warn/error（ErrorBoundary 等）
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // 测试文件特殊配置
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  // Logger 内部允许 console（Transport 层直接调用 console 是正确行为）
  {
    files: ['src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // BrowserPanel 调试辅助函数（同步边界诊断日志，保留调试能力）
  {
    files: ['src/components/Browser/BrowserPanel.tsx'],
    rules: {
      'no-console': 'off',
    },
  },
  // PromptSnippetTab 的 Skill 区块被注释暂藏：其变量仅为被注释 JSX 服务，
  // 既有 `;[skills,...]` 占位用来抑制 tsc noUnusedLocals（见 tsconfig strict）。
  // lint 侧豁免表达式语句与未使用变量，避免与 tsc 的占位需求冲突。
  {
    files: ['src/components/Settings/tabs/PromptSnippetTab.tsx'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // sky 独立 Node 服务工程：CLI/server/脚本的 console 是正确行为，不做产品化限制
  {
    files: ['sky/**', 'sky/src/**', 'sky/scripts/**', 'sky/web/**'],
    rules: {
      'no-console': 'off',
      'no-empty': 'off',
    },
  },
  // 子项目（polaris-pocket 移动端 / sky Web 渲染）内部风格规则自治：
  // 它们是无独立 lint 配置的独立交付物，根 lint 不强约束其局部风格细节
  {
    files: ['polaris-pocket/**', 'sky/web/src/render/**'],
    rules: {
      'prefer-const': 'off',
      'no-case-declarations': 'off',
    },
  },
  // errors.ts 错误日志输出需要 console
  {
    files: ['src/types/errors.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // scripts 脚本文件允许 console
  {
    files: ['scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
  // .polaris 内部临时报告/测试脚本允许 console（非产品代码）
  {
    files: ['.polaris/reports/**', '.polaris/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  }
);
