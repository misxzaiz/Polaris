/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 主色调 - 蓝色系（CSS 变量驱动，支持多主题）
        primary: {
          DEFAULT: 'rgb(var(--c-primary) / <alpha-value>)',
          hover: 'rgb(var(--c-primary-hover) / <alpha-value>)',
          50: 'rgb(var(--c-primary-50) / <alpha-value>)',
          100: 'rgb(var(--c-primary-100) / <alpha-value>)',
          200: 'rgb(var(--c-primary-200) / <alpha-value>)',
          300: 'rgb(var(--c-primary-300) / <alpha-value>)',
          400: 'rgb(var(--c-primary-400) / <alpha-value>)',
          500: 'rgb(var(--c-primary-500) / <alpha-value>)',
          600: 'rgb(var(--c-primary-600) / <alpha-value>)',
          700: 'rgb(var(--c-primary-700) / <alpha-value>)',
          faint: 'rgb(var(--c-primary) / 0.15)',
          glow: 'rgb(var(--c-primary) / 0.3)',
        },
        // 背景色系 - 复合 --window-opacity 与 <alpha-value>
        background: {
          base: 'rgb(var(--c-bg-base) / calc(var(--window-opacity, 1) * <alpha-value>))',
          elevated: 'rgb(var(--c-bg-elevated) / calc(var(--window-opacity, 1) * <alpha-value>))',
          surface: 'rgb(var(--c-bg-surface) / calc(var(--window-opacity, 1) * <alpha-value>))',
          hover: 'rgb(var(--c-bg-hover) / calc(var(--window-opacity, 1) * <alpha-value>))',
          active: 'rgb(var(--c-bg-active) / calc(var(--window-opacity, 1) * <alpha-value>))',
          tertiary: 'rgb(var(--c-bg-tertiary) / calc(var(--window-opacity, 1) * <alpha-value>))',
          secondary: 'rgb(var(--c-bg-secondary) / calc(var(--window-opacity, 1) * <alpha-value>))',
        },
        // 边框色系 - 固定 alpha（边框不复合窗口透明度，保持可见性）
        border: {
          DEFAULT: 'rgb(var(--c-border) / 0.15)',
          subtle: 'rgb(var(--c-border) / 0.08)',
          default: 'rgb(var(--c-border) / 0.15)',
          strong: 'rgb(var(--c-border) / 0.25)',
          muted: 'rgb(var(--c-border) / 0.12)',
          focus: 'rgb(var(--c-primary) / 0.5)',
        },
        // 文本色系
        text: {
          DEFAULT: 'rgb(var(--c-text-primary) / <alpha-value>)',
          primary: 'rgb(var(--c-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--c-text-tertiary) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
        },
        // 语义化颜色（保留旧 token 兼容）
        success: {
          DEFAULT: 'rgb(var(--c-status-success) / <alpha-value>)',
          faint: 'rgb(var(--c-status-success) / 0.15)',
        },
        warning: {
          DEFAULT: 'rgb(var(--c-status-warning) / <alpha-value>)',
          faint: 'rgb(var(--c-status-warning) / 0.15)',
        },
        danger: {
          DEFAULT: 'rgb(var(--c-status-danger) / <alpha-value>)',
          faint: 'rgb(var(--c-status-danger) / 0.15)',
        },
        info: {
          DEFAULT: 'rgb(var(--c-status-info) / <alpha-value>)',
          faint: 'rgb(var(--c-status-info) / 0.15)',
        },
        // 新增：业务状态色（需求库/Todo 等使用）
        status: {
          warning: 'rgb(var(--c-status-warning) / <alpha-value>)',
          success: 'rgb(var(--c-status-success) / <alpha-value>)',
          danger: 'rgb(var(--c-status-danger) / <alpha-value>)',
          info: 'rgb(var(--c-status-info) / <alpha-value>)',
          done: 'rgb(var(--c-status-done) / <alpha-value>)',
          failed: 'rgb(var(--c-status-failed) / <alpha-value>)',
          neutral: 'rgb(var(--c-status-neutral) / <alpha-value>)',
        },
        // 新增：优先级色
        priority: {
          low: 'rgb(var(--c-priority-low) / <alpha-value>)',
          normal: 'rgb(var(--c-priority-normal) / <alpha-value>)',
          high: 'rgb(var(--c-priority-high) / <alpha-value>)',
          urgent: 'rgb(var(--c-priority-urgent) / <alpha-value>)',
        },
        // 新增：强调色
        accent: {
          ai: 'rgb(var(--c-accent-ai) / <alpha-value>)',
          prototype: 'rgb(var(--c-accent-prototype) / <alpha-value>)',
          workspace: 'rgb(var(--c-accent-workspace) / <alpha-value>)',
        },
        // 新增：模态遮罩
        overlay: {
          DEFAULT: 'rgb(var(--c-overlay) / 0.5)',
          light: 'rgb(var(--c-overlay) / 0.3)',
          strong: 'rgb(var(--c-overlay) / 0.9)',
        },
        // 新增：主色/危险按钮文字色
        'on-primary': 'rgb(var(--c-on-primary) / <alpha-value>)',
        'on-danger': 'rgb(var(--c-on-primary) / <alpha-value>)',
        // 新增：恒白画布（原型 HTML 预览底色等）
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        // 新增：标签色
        tag: {
          bg: 'rgb(var(--c-tag-bg) / 0.08)',
          foreground: 'rgb(var(--c-status-info) / <alpha-value>)',
        },
      },
      // 阴影 - 引用 --c-shadow，主题感知
      boxShadow: {
        'soft': '0 4px 12px rgb(var(--c-shadow) / 0.15)',
        'medium': '0 8px 24px rgb(var(--c-shadow) / 0.2)',
        'glow': '0 0 24px rgb(var(--c-primary) / 0.15)',
        'glow-lg': '0 0 48px rgb(var(--c-primary) / 0.1)',
        'inner-soft': 'inset 0 2px 4px rgb(var(--c-shadow) / 0.1)',
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
        // 语音伙伴：呼吸（光晕/描边环，带透明度起伏）
        'breathe': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.75' },
          '50%': { transform: 'scale(1.07)', opacity: '1' },
        },
        // 语音伙伴：核心球呼吸（仅缩放，幅度更小）
        'breathe-core': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.035)' },
        },
        // 语音伙伴：聆听涟漪扩散
        'voice-ripple': {
          '0%': { transform: 'scale(0.78)', opacity: '0.7' },
          '100%': { transform: 'scale(1.5)', opacity: '0' },
        },
        // 语音伙伴：说话音量条律动
        'voice-bar': {
          '0%, 100%': { transform: 'scaleY(0.45)' },
          '50%': { transform: 'scaleY(1)' },
        },
        // 语音伙伴：aurora 光斑漂移
        'aurora-drift-1': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(8%, 10%) scale(1.12)' },
        },
        'aurora-drift-2': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(-10%, -8%) scale(1.08)' },
        },
      },
      animation: {
        'shake-once': 'shake-once 0.5s ease-in-out',
        'flow': 'flow 3s ease infinite',
        'breathe': 'breathe 5.6s ease-in-out infinite',
        'breathe-core': 'breathe-core 5.6s ease-in-out infinite',
        'voice-ripple': 'voice-ripple 2.6s ease-out infinite',
        'voice-bar': 'voice-bar 1s ease-in-out infinite',
        'aurora-drift-1': 'aurora-drift-1 22s ease-in-out infinite',
        'aurora-drift-2': 'aurora-drift-2 28s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
