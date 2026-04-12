import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Polaris',
  description: '智能桌面助手使用指南',

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
            { text: '开发者工具', link: '/guide/developer' },
            { text: '平台集成', link: '/guide/integration' },
            { text: '语音', link: '/guide/speech' },
            { text: '快捷片段', link: '/guide/prompt-snippet' },
          ],
        },
        {
          text: '配置',
          items: [
            { text: '设置', link: '/guide/settings' },
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
      message: 'Polaris 智能桌面助手',
    },
  },
})
