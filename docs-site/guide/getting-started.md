# 安装与启动

## 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11（推荐） |
| macOS | 12+（实验性支持） |
| 内存 | 至少 4GB 可用 |
| 网络 | 需要访问 AI API 服务 |

## 安装步骤

<div class="step-card">
  <div class="step-number">1</div>
  <div class="step-content">
    <h4>下载安装包</h4>
    <p>从 <a href="https://github.com/misxzaiz/Polaris/releases">GitHub Releases</a> 下载最新版本的安装包</p>
  </div>
</div>

<div class="step-card">
  <div class="step-number">2</div>
  <div class="step-content">
    <h4>运行安装程序</h4>
    <p>双击安装包，按提示完成安装。首次启动会自动初始化配置目录</p>
  </div>
</div>

<div class="step-card">
  <div class="step-number">3</div>
  <div class="step-content">
    <h4>连接 Claude CLI</h4>
    <p>首次启动会检测 Claude CLI。如未检测到，需在连接页面手动指定 CLI 路径或在「设置 → AI 引擎」中配置</p>
  </div>
</div>

<div class="step-card">
  <div class="step-number">4</div>
  <div class="step-content">
    <h4>开始对话</h4>
    <p>连接成功后，右侧 AI 面板即可使用。在输入框输入消息，按 <span class="shortcut">Enter</span> 发送，<span class="shortcut">Shift</span> + <span class="shortcut">Enter</span> 换行</p>
  </div>
</div>

## 首次连接问题排查

应用启动后会自动检测 Claude CLI。如果检测失败，会显示连接页面，列出可能的诊断原因：

| 问题 | 解决方式 |
|------|----------|
| CLI 未安装 | 通过 `npm install -g @anthropic-ai/claude-code` 安装 |
| CLI 路径未配置 | 点击「设置 Claude 路径」手动输入完整路径 |
| 系统PATH未包含CLI目录 | 将 CLI 所在目录添加到系统 PATH 环境变量 |
| 权限不足 | 以管理员权限运行终端安装 CLI |

<div class="info-card tip">
  <div class="card-title">提示</div>
  <p>Windows 常见路径示例：<code>C:\Users\&lt;用户名&gt;\AppData\Roaming\npm\claude.cmd</code>。macOS/Linux：<code>/usr/local/bin/claude</code></p>
</div>
