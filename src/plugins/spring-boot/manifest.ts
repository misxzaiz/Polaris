import type { PolarisPluginManifest } from '@/plugin-system/types'

export const springBootPluginManifest: PolarisPluginManifest = {
  id: 'polaris.spring-boot',
  name: 'Spring Boot Runner',
  version: '0.1.0',
  description: '轻量级 Spring Boot 运行 / 调试 / 热部署辅助：检测项目、一键运行与调试、启动状态识别。复用 PTY 进程引擎。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'springBoot.panel',
        area: 'activityBar',
        panelType: 'springBoot',
        icon: 'Rocket',
        labelKey: 'labels.springBootPanel',
        labelDefault: 'Spring Boot',
        order: 75,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
  },
}
