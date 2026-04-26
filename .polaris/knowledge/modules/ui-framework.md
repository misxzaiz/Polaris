# 模块：UI 框架与通用组件

> ID: ui-framework | 复杂度: 中 | 变更频率: 中
> 依赖: React, lucide-react, i18next, zustand | 被依赖: 所有页面级组件

## 概述

VSCode 风格三栏布局。viewStore 为布局唯一真相源。支持面板折叠、紧凑模式、多会话网格。

## 核心组件

| 组件 | 职责 |
|------|------|
| App | 根组合 |
| ActivityBar | 左侧图标栏 |
| viewStore | 布局状态 + persist |
| KnowledgePanel | 三视图：列表/依赖图/健康度 |

## 已知陷阱

1. ActivityBar/RadialMenu 面板列表需同步
2. ResizeHandle delta 反转
3. z-50 层共享冲突
4. closeOtherTabs 不处理脏标签