# 界面总览

Polaris 采用类似 VS Code 的三栏布局。所有导航通过 Zustand 状态驱动，无需 URL 路由。

<div class="ui-mock">
  <div class="ui-mock-label">
    <span class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></span>
    <span>Polaris — 智能桌面助手</span>
    <span class="mock-hint">（模拟界面 · 非实际截图）</span>
  </div>
  <div class="ui-mock-body" style="display:flex; gap:2px; min-height:180px;">
    <div class="mock-activitybar">
      <div class="ab-icon active" title="文件浏览器">📄</div>
      <div class="ab-icon" title="Git 面板">🔀</div>
      <div class="ab-icon" title="待办面板">☑️</div>
      <div class="ab-icon" title="翻译面板">🌐</div>
      <div class="ab-icon" title="定时任务">⏰</div>
      <div class="ab-icon" title="需求队列">📋</div>
      <div class="ab-icon" title="终端">💻</div>
      <div class="ab-icon" title="开发者面板">🔧</div>
      <div class="ab-icon" title="机器人管理">🤖</div>
    </div>
    <div class="mock-leftpanel">
      <div style="color:var(--p-text-primary);font-weight:600;font-size:12px;margin-bottom:8px;">文件</div>
      <div style="opacity:0.5;font-size:12px;">📁 src/</div>
      <div style="opacity:0.5;font-size:12px;padding-left:12px;">📄 App.tsx</div>
      <div style="opacity:0.5;font-size:12px;padding-left:12px;">📄 main.tsx</div>
      <div style="opacity:0.5;font-size:12px;">📁 components/</div>
    </div>
    <div class="mock-center">
      <div style="color:var(--p-text-tertiary);font-size:12px;">打开文件或查看差异</div>
      <div style="opacity:0.4;font-size:11px;margin-top:4px;">从左侧文件浏览器打开文件，或在 Git 面板中查看差异</div>
    </div>
    <div class="mock-rightpanel">
      <div style="color:var(--p-primary);font-weight:600;font-size:13px;">Polaris</div>
      <div style="font-size:12px;margin-top:4px;color:var(--p-text-tertiary);">智能编程助手，让代码编辑更高效</div>
      <div style="display:flex;gap:8px;margin-top:8px;font-size:11px;">
        <span style="background:var(--p-bg-surface);padding:4px 8px;border-radius:4px;">文件管理</span>
        <span style="background:var(--p-bg-surface);padding:4px 8px;border-radius:4px;">代码编辑</span>
        <span style="background:var(--p-bg-surface);padding:4px 8px;border-radius:4px;">智能分析</span>
      </div>
      <div style="font-size:11px;margin-top:12px;color:var(--p-text-muted);">输入消息开始对话</div>
    </div>
  </div>
</div>

## 四大区域

| 区域 | 宽度 | 说明 |
|------|------|------|
| **ActivityBar** | 48px 固定 | 最左侧图标栏，切换各功能面板，支持折叠为悬浮扇形菜单 |
| **LeftPanel** | 200~600px（默认280px） | ActivityBar 选中的功能面板，可拖拽调整宽度 |
| **CenterStage** | 自适应 | 中间编辑区，打开文件时显示代码编辑器和多标签页 |
| **RightPanel** | 200~1200px（默认400px） | AI 对话面板，可折叠 |

## 顶栏 (TopMenuBar)

顶栏高 40px，从左到右依次为：

| 元素 | 说明 |
|------|------|
| Logo | 24x24 圆角方块，蓝色渐变背景，白色 "P" 字母 |
| 应用名 | "Polaris" 文字 |
| 工作区切换器 | 快速切换或创建工作区 |
| ActivityBar 切换 | 折叠/展开左侧图标栏 |
| AI 面板切换 | 折叠/展开右侧 AI 面板 |
| 窗口置顶 | 切换始终置顶 |
| 窗口控制 | 最小化 / 最大化 / 关闭 |

## ActivityBar 功能入口

ActivityBar 从上到下排列 9 个功能入口（使用 lucide-react 图标）：

| 图标 | 面板 | 说明 |
|------|------|------|
| Files | 文件浏览器 | 浏览工作区文件，支持新建/重命名/删除/搜索 |
| GitPullRequest | Git 面板 | 变更查看、提交、分支管理、历史、远程、标签、Stash、.gitignore |
| CheckSquare | 待办事项 | 创建和管理待办，支持优先级、标签、子任务 |
| Languages | 翻译 | 中英互译，可发送到 AI 对话 |
| Clock | 定时任务 | 创建和管理定时/周期任务，支持简单模式和协议模式 |
| ClipboardList | 需求队列 | 需求全生命周期管理，支持原型预览 |
| Terminal | 终端 | 内置命令行终端 |
| Code2 | 开发者面板 | MCP 服务器管理和开发调试 |
| Bot | 机器人管理 | QQ Bot、飞书等平台集成配置 |

底部的两个图标：

| 图标 | 说明 |
|------|------|
| PanelRight | 切换右侧 AI 面板的显示/隐藏 |
| Settings | 打开设置弹窗 |

## 折叠模式

ActivityBar 支持折叠。折叠后左边缘显示一个半圆悬浮触发器，悬停展开扇形菜单，包含所有面板图标。

## 小屏模式

当窗口宽度小于 500px 时自动进入小屏模式：

- 隐藏 ActivityBar、LeftPanel、CenterStage
- 仅显示 AI 对话面板
- 顶栏切换为精简模式（仅保留窗口控制按钮）
