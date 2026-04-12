# 设置

通过 ActivityBar 底部的 **Settings** 图标或顶栏打开设置弹窗。设置弹窗采用左右分栏布局：左侧导航 + 右侧内容区。

<div class="mock-settings">
  <div class="mock-settings-sidebar">
    <div class="ms-item active">通用</div>
    <div class="ms-item">系统提示词</div>
    <div class="ms-item">快捷片段</div>
    <div class="ms-item">窗口</div>
    <div class="ms-item">AI 引擎</div>
    <div class="ms-item">翻译</div>
    <div class="ms-item">QQ Bot</div>
    <div class="ms-item">飞书</div>
    <div class="ms-item">语音输入</div>
  </div>
  <div class="mock-settings-content">
    <div style="font-weight:600;color:var(--p-text-primary);margin-bottom:12px;">通用设置</div>
    <div style="margin-bottom:8px;">语言设置</div>
    <div style="opacity:0.5;font-size:12px;">切换界面显示语言</div>
  </div>
</div>

<p style="text-align:center;font-size:12px;color:var(--p-text-muted);font-style:italic;margin-top:-12px;">（模拟界面 · 非实际截图）</p>

## 设置标签页

| 标签 | 说明 |
|------|------|
| 通用 | 语言设置（中文/英文切换） |
| 系统提示词 | 自定义 AI 的 System Prompt，支持默认/追加/替换模式 |
| 快捷片段 | 管理提示词模板，详见 [快捷片段](./prompt-snippet) |
| 窗口 | 大窗模式和小屏模式的透明度调节 |
| AI 引擎 | Claude CLI 路径配置和自动检测 |
| 翻译 | 百度翻译 API 配置（App ID + Secret Key） |
| QQ Bot | QQ 机器人实例管理，详见 [平台集成](./integration) |
| 飞书 | 飞书机器人集成配置 |
| 语音输入 | 语音识别和 TTS 配置，详见 [语音](./speech) |

## AI 引擎配置

这是首次使用的关键配置步骤：

| 操作 | 说明 |
|------|------|
| 自动检测 | 自动搜索系统中的 Claude CLI |
| 手动输入 | 直接填写 CLI 完整路径 |
| 重新检测 | 重新扫描可用路径 |

Windows 常见路径：`C:\Users\<用户名>\AppData\Roaming\npm\claude.cmd`
macOS/Linux 常见路径：`/usr/local/bin/claude`

## 系统提示词

| 模式 | 说明 |
|------|------|
| 默认 | 使用内置提示词 |
| 追加 | 在默认提示词后追加自定义内容 |
| 替换 | 完全替换为自定义内容 |

支持变量：`{{workspaceName}}`、`{{workspacePath}}`、`{{contextWorkspaces}}`、`{{date}}`、`{{time}}`、`{{defaultPrompt}}`

提供字符计数、预览功能、重置/填入默认按钮。
