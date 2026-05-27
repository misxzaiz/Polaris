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
  }
);
