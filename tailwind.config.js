/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 主色调 - 蓝色系
        primary: {
          DEFAULT: '#3B82F6',
          hover: '#2563EB',
          50: '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          300: '#93C5FD',
          400: '#60A5FA',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
          faint: 'rgba(59, 130, 246, 0.15)',
          glow: 'rgba(59, 130, 246, 0.3)',
        },
        // 背景色系 - 优化的分层深色，支持透明度调节
        background: {
          base: 'rgba(15, 15, 17, var(--window-opacity, 1))',           // 全局背景 - 透明度可调
          elevated: 'rgba(26, 26, 31, var(--window-opacity, 1))',        // 侧边栏/面板 - 增加层次
          surface: 'rgba(37, 37, 43, var(--window-opacity, 1))',         // 卡片/输入框 - 更明显的区分
          hover: 'rgba(45, 45, 53, var(--window-opacity, 1))',           // 悬停 - 增强交互反馈
          active: 'rgba(53, 53, 61, var(--window-opacity, 1))',          // 激活 - 更强的反馈
          tertiary: 'rgba(33, 38, 45, var(--window-opacity, 1))',         // 兼容旧名
          secondary: 'rgba(22, 27, 34, var(--window-opacity, 1))',       // 兼容旧名
        },
        // 边框色系 - 增强对比度
        border: {
          DEFAULT: 'rgba(255, 255, 255, 0.15)',
          subtle: 'rgba(255, 255, 255, 0.08)',
          default: 'rgba(255, 255, 255, 0.15)',
          strong: 'rgba(255, 255, 255, 0.25)',
          muted: 'rgba(255, 255, 255, 0.12)',
          focus: 'rgba(59, 130, 246, 0.5)',
        },
        // 文本色系 - 优化可读性
        text: {
          DEFAULT: '#F8F8F8',
          primary: '#F8F8F8',          // 主要文本 - 稍微柔和
          secondary: '#B4B4B8',        // 次要文本 - 增加对比度
          tertiary: '#8E8E93',         // 辅助文本 - 提高可读性
          muted: '#6D6D70',            // 弱化文本 - 保持可见性
        },
        // 语义化颜色 - 增加温度感
        success: {
          DEFAULT: '#34D399',
          faint: 'rgba(52, 211, 153, 0.15)',
        },
        warning: {
          DEFAULT: '#FBBF24',
          faint: 'rgba(251, 191, 36, 0.15)',
        },
        danger: {
          DEFAULT: '#F87171',
          faint: 'rgba(248, 113, 113, 0.15)',
        },
        info: {
          DEFAULT: '#60A5FA',
          faint: 'rgba(96, 165, 250, 0.15)',
        },
      },
      // 阴影 - 更自然的阴影系统
      boxShadow: {
        'soft': '0 4px 12px rgba(0, 0, 0, 0.15)',
        'medium': '0 8px 24px rgba(0, 0, 0, 0.2)',
        'glow': '0 0 24px rgba(59, 130, 246, 0.15)',
        'glow-lg': '0 0 48px rgba(59, 130, 246, 0.1)',
        'inner-soft': 'inset 0 2px 4px rgba(0, 0, 0, 0.1)',
      },
      // 间距
      spacing: {
        '18': '4.5rem',   // 72px
        '19': '4.75rem',  // 76px
      },
      // 圆角
      borderRadius: {
        '4xl': '2rem',
      },
      // 动画
      keyframes: {
        'shake-once': {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-2px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(2px)' },
        },
        'flow': {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' },
        },
      },
      animation: {
        'shake-once': 'shake-once 0.5s ease-in-out',
        'flow': 'flow 3s ease infinite',
      },
    },
  },
  plugins: [],
}
