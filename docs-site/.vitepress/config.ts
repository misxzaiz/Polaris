import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Polaris',
  description: 'Claude Code 可视化平台使用指南',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
  ],

  themeConfig: {

    nav: [
      { text: '首页', link: '/' },
      { text: '使用指南', link: '/guide/getting-started' },
      { text: '常见问题', link: '/faq' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '快速开始',
          items: [
            { text: '安装与启动', link: '/guide/getting-started' },
            { text: '五分钟快速体验', link: '/guide/quick-tour' },
            { text: '界面总览', link: '/guide/overview' },
          ],
        },
        {
          text: '核心功能',
          items: [
            { text: 'AI 对话', link: '/guide/ai-chat' },
            { text: '文件管理', link: '/guide/file-explorer' },
            { text: '工作区', link: '/guide/workspace' },
            { text: 'Git 版本控制', link: '/guide/git' },
          ],
        },
        {
          text: '扩展功能',
          items: [
            { text: '翻译', link: '/guide/translate' },
            { text: '定时任务', link: '/guide/scheduler' },
            { text: '需求管理', link: '/guide/requirement' },
            { text: '终端', link: '/guide/terminal' },
            { text: '开发者面板', link: '/guide/developer' },
            { text: '平台集成', link: '/guide/integration' },
            { text: '语音', link: '/guide/speech' },
            { text: '快捷片段', link: '/guide/prompt-snippet' },
          ],
        },
        {
          text: '设置',
          items: [
            { text: '设置总览', link: '/guide/settings' },
          ],
        },
        {
          text: '实战教程',
          items: [
            { text: '修复一个 Bug', link: '/guide/workflows/bug-fix' },
            { text: '代码审查工作流', link: '/guide/workflows/code-review' },
            { text: '定时任务生成日报', link: '/guide/workflows/daily-report' },
            { text: '多会话协作', link: '/guide/workflows/multi-session' },
          ],
        },
        {
          text: '进阶',
          items: [
            { text: '会话配置', link: '/guide/advanced/session-config' },
            { text: '自动模式', link: '/guide/advanced/auto-mode' },
            { text: '插件系统', link: '/guide/advanced/plugins' },
            { text: '快捷键参考', link: '/guide/advanced/keyboard' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/misxzaiz/Polaris' },
    ],

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Polaris — Claude Code 可视化平台',
    },
  },
})
