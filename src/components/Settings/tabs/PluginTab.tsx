import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  PackagePlus,
  RefreshCw,
  Trash2,
  AlertTriangle,
  BookOpen,
  Copy,
  Check,
} from 'lucide-react'
import { listPluginMcpServerStatuses, pluginIconMap, pluginRegistry } from '@/plugin-system'
import {
  applyPluginUpdate,
  checkPluginUpdate,
  discoverInstalledPlugins,
  getPluginInstallLocations,
  installLocalPlugin,
  installPluginPackage,
  installRemotePlugin,
  uninstallLocalPlugin,
  type PluginDiscoveryIssue,
  type PluginInstallLocations,
  type PluginUpdateCheckResult,
} from '@/services/pluginDiscoveryService'
import { listMcpHealthStatuses, type McpHealthStatus } from '@/services/mcpHealthService'
import { openInDefaultApp } from '@/services/tauri/windowService'
import { isTauri } from '@/utils/platform'
import { usePluginStore } from '@/stores/pluginStore'
import { usePluginServiceStore } from '@/stores/pluginServiceStore'
import { pluginServiceManager } from '@/services/pluginServiceManager'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { PolarisPluginManifest } from '@/plugin-system/types'

function formatPermissionLabel(key: string, t: (key: string, options?: { defaultValue?: string }) => string): string {
  return t(`plugins.permissions.${key}`, { defaultValue: key })
}

function PluginGuide() {
  const [copied, setCopied] = useState(false)

  const guideContent = `# Polaris 插件开发指南

## 快速开始 — 最简 MCP 插件

### 目录结构

my-plugin/
├── plugin.json
└── mcp/
    └── server.js

### plugin.json

{
  "id": "my-tool",
  "name": "我的工具",
  "version": "1.0.0",
  "enabledByDefault": true,
  "contributes": {
    "mcpServers": [{
      "id": "my-server",
      "transport": "stdio",
      "command": "node",
      "argsTemplate": ["{{pluginDir}}/mcp/server.js"]
    }]
  },
  "permissions": { "aiToolAccess": true }
}

### mcp/server.js

#!/usr/bin/env node
function send(m) { process.stdout.write(JSON.stringify(m) + '\\n') }

const tools = [{
  name: 'my_tool',
  description: '工具描述',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '输入文本' } },
    required: ['text']
  }
}]

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => {
  buf += c
  while (true) {
    const i = buf.indexOf('\\n')
    if (i === -1) break
    const msg = JSON.parse(buf.slice(0, i).trim())
    buf = buf.slice(i + 1)
    if (!msg) continue

    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'my-tool', version: '1.0.0' }
      }})
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } })
    } else if (msg.method === 'tools/call') {
      const args = msg.params?.arguments || {}
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: '结果: ' + args.text }]
      }})
    }
  }
})

安装方式：设置 → 插件 → Install from directory → 选择此目录。

---

## Manifest 规范

### 完整 plugin.json

{
  "id": "my-plugin",              // 必填，全局唯一
  "name": "我的插件",              // 必填，显示名称
  "version": "1.0.0",             // 必填，语义化版本
  "description": "插件描述",       // 可选
  "enabledByDefault": true,       // 可选，默认 true

  "contributes": {
    "views": [{                   // ActivityBar 入口
      "id": "my-plugin.panel",
      "area": "activityBar",      // 固定值
      "panelType": "myPanel",     // 全局唯一，映射 LeftPanelType
      "icon": "Code2",            // Lucide 图标名
      "labelKey": "plugins.myPanel",
      "labelDefault": "我的面板",
      "order": 85
    }],
    "mcpServers": [{
      "id": "my-server",
      "transport": "stdio",       // 固定: "stdio"
      "command": "node",
      "argsTemplate": ["{{pluginDir}}/mcp/server.js"]
    }],
    "panel": {
      "entry": "./dist/panel.js"  // 面板 JS bundle 路径
    }
  },

  "permissions": {
    "workspaceRead": true,        // 读取工作区文件
    "workspaceWrite": false,      // 写入工作区文件
    "appConfigRead": false,       // 读取应用配置
    "appConfigWrite": false,      // 写入应用配置
    "network": false,             // 网络访问
    "aiToolAccess": true          // AI 工具调用
  },

  "origin": {
    "repository": "https://github.com/user/repo",
    "homepage": "https://example.com",
    "updateUrl": "https://example.com/update.json",
    "downloadUrl": "https://example.com/plugin.zip"
  }
}

### 模板占位符

{{pluginDir}}     — 插件安装目录
{{workspacePath}}  — 当前工作区路径
{{appConfigDir}}   — 应用配置目录

### 可用图标

Files, GitPullRequest, CheckSquare, Languages, Clock, Target,
ClipboardList, Terminal, Code2, Bot, BookOpen, AlertCircle, Film, Activity

---

## MCP Server 开发

### 必须处理的方法

initialize      — 返回协议版本和能力声明
tools/list      — 返回工具列表
tools/call      — 执行工具调用，返回结果

### 成功响应

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "输出内容" }]
  }
}

### 错误响应

{
  "content": [{ "type": "text", "text": "错误信息" }],
  "isError": true
}

---

## 可视化面板开发

### 目录结构

my-plugin/
├── plugin.json
├── src/
│   └── Panel.tsx          # 面板源码（React）
├── dist/
│   └── panel.js           # 打包输出（自包含）
└── mcp/
    └── server.js

### src/Panel.tsx

import { useState } from 'react'

interface PluginPanelProps {
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}

export default function MyPanel({ pluginId, onSendToChat }: PluginPanelProps) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>我的面板</h3>
      <div style={{ fontSize: 11, color: '#8E8E93' }}>插件: {pluginId}</div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        style={{ flex: 1, minHeight: 80, padding: 8, borderRadius: 6,
          border: '1px solid #3F3F46', background: '#25252B', color: '#F8F8F8',
          fontFamily: 'monospace', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setOutput(input)}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #3F3F46',
            background: '#2D2D33', color: '#B4B4B8', fontSize: 12 }}>
          处理
        </button>
        {onSendToChat && (
          <button onClick={() => onSendToChat('处理: ' + input)}
            style={{ padding: '6px 12px', borderRadius: 6, border: 'none',
              background: '#3B82F6', color: '#fff', fontSize: 12 }}>
            发送到聊天
          </button>
        )}
      </div>
      {output && (
        <pre style={{ padding: 8, borderRadius: 6, border: '1px solid #3F3F46',
          background: '#25252B', color: '#B4B4B8', fontFamily: 'monospace',
          fontSize: 12, margin: 0, overflow: 'auto' }}>
          {output}
        </pre>
      )}
    </div>
  )
}

### 打包命令

npx esbuild src/Panel.tsx --bundle --format=esm --outfile=dist/panel.js --jsx=automatic --nodePaths=/path/to/polaris/node_modules

### 面板 Props

pluginId       — 当前插件 ID
onSendToChat() — 发送消息到聊天

---

## 内置插件开发

### src/plugins/myPlugin/manifest.ts

import type { PolarisPluginManifest } from '@/plugin-system/types'

export const myPluginManifest: PolarisPluginManifest = {
  id: 'polaris.myPlugin',
  name: '我的插件',
  version: '0.1.0',
  description: '插件描述',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [{
      id: 'myPlugin.panel',
      area: 'activityBar',
      panelType: 'myPanelType',
      icon: 'Bot',
      labelKey: 'labels.myPanel',
      labelDefault: '我的面板',
      order: 85,
    }],
    mcpServers: [{
      id: 'my-mcp-server',
      transport: 'stdio',
      command: 'my_mcp_command',
      argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
    }],
  },
  permissions: { workspaceRead: true, aiToolAccess: true },
}

### 在 src/plugin-system/builtinPlugins.ts 中注册

import { myPluginManifest } from '@/plugins/myPlugin/manifest'

export function registerBuiltinPlugins(): void {
  pluginRegistry.register(corePluginManifest)
  pluginRegistry.register(myPluginManifest)
}

---

## 安装与调试

### 安装方式

本地目录：设置 → 插件 → Install from directory
包文件：  设置 → 插件 → Install package（.zip/.json）
远程 URL：设置 → 插件 → 输入 URL → Install remote

### 安装路径

用户级：%APPDATA%/com.polaris.app/plugins/（Windows）
         ~/.config/polaris/plugins/（Linux/Mac）
项目级：工作区根目录 .polaris/plugins/

### 调试技巧

- 手动运行 MCP Server：node mcp/server.js
- 浏览器 DevTools 中查看 blob URL 对应源码
- "Manifest diagnostics" 显示校验错误
- 修改 plugin.json 后点击 Refresh 刷新

---

## 常见问题

问：面板报错 "Invalid hook call"
答：面板 bundle 内嵌了独立的 React 副本。重新打包时 React 设为 external，运行时由宿主提供。

问：面板报错 "Failed to fetch"
答：不能用 import() 加载 file:// URL。使用 Polaris 注册表系统，通过 Tauri 后端读取文件。

问：MCP Server 启动失败
答：检查：command 是否在 PATH 中、argsTemplate 路径是否正确、脚本是否有执行权限、手动运行是否报错。

---

完整文档：docs/plugins/plugin-development-guide.md`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(guideContent)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = guideContent
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-tertiary">复制以下全部内容，粘贴给 AI 助手（如 Claude Code）即可生成插件。</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/15 transition-colors shrink-0"
        >
          {copied ? <><Check size={12} /> 已复制</> : <><Copy size={12} /> 复制全部</>}
        </button>
      </div>
      <pre className="rounded-lg border border-border-subtle bg-background-elevated p-3 text-[11px] font-mono text-text-tertiary overflow-auto max-h-[500px] whitespace-pre-wrap leading-relaxed">
        {guideContent}
      </pre>
    </div>
  )
}

export function PluginTab() {
  const { t } = useTranslation('settings')
  const [mcpHealthStatuses, setMcpHealthStatuses] = useState<McpHealthStatus[]>([])
  const [mcpHealthLoading, setMcpHealthLoading] = useState(false)
  const [mcpHealthError, setMcpHealthError] = useState<string | null>(null)
  const [pluginDiscoveryLoading, setPluginDiscoveryLoading] = useState(false)
  const [pluginDiscoveryError, setPluginDiscoveryError] = useState<string | null>(null)
  const [pluginDiscoveryIssues, setPluginDiscoveryIssues] = useState<PluginDiscoveryIssue[]>([])
  const [pluginInstallLocations, setPluginInstallLocations] = useState<PluginInstallLocations | null>(null)
  const [pluginOperationLoading, setPluginOperationLoading] = useState(false)
  const [pluginOperationMessage, setPluginOperationMessage] = useState<string | null>(null)
  const [pluginUpdateChecks, setPluginUpdateChecks] = useState<Record<string, PluginUpdateCheckResult>>({})
  const [pluginUpdateLoadingId, setPluginUpdateLoadingId] = useState<string | null>(null)
  const [pluginUpdateApplyLoadingId, setPluginUpdateApplyLoadingId] = useState<string | null>(null)
  const [pluginInstallScope, setPluginInstallScope] = useState<'user' | 'project'>('user')
  const [pluginRemoteSourceUrl, setPluginRemoteSourceUrl] = useState('')
  const [plugins, setPlugins] = useState(() => pluginRegistry.listPlugins())
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set())
  const [showGuide, setShowGuide] = useState(false)
  const currentWorkspacePath = useWorkspaceStore((state) => state.getCurrentWorkspace()?.path)
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const setPluginEnabled = usePluginStore((state) => state.setPluginEnabled)
  const setPluginUiEnabled = usePluginStore((state) => state.setPluginUiEnabled)
  const setPluginMcpEnabled = usePluginStore((state) => state.setPluginMcpEnabled)
  const setPluginMcpServerEnabled = usePluginStore((state) => state.setPluginMcpServerEnabled)
  const resetPluginState = usePluginStore((state) => state.resetPluginState)

  const discoveredPluginCount = plugins.filter((plugin) => !plugin.builtin).length
  const mcpServerStatuses = listPluginMcpServerStatuses(pluginStates)
  const enabledMcpServerCount = mcpServerStatuses.filter((server) => server.enabled).length
  const disabledMcpServerCount = mcpServerStatuses.length - enabledMcpServerCount
  const mcpHealthByName = useMemo(() => {
    return new Map(mcpHealthStatuses.map((status) => [status.name, status]))
  }, [mcpHealthStatuses])

  const toggleExpand = useCallback((pluginId: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev)
      if (next.has(pluginId)) {
        next.delete(pluginId)
      } else {
        next.add(pluginId)
      }
      return next
    })
  }, [])

  const refreshMcpHealth = useCallback(async () => {
    setMcpHealthLoading(true)
    setMcpHealthError(null)

    try {
      setMcpHealthStatuses(await listMcpHealthStatuses())
    } catch (error) {
      setMcpHealthError(error instanceof Error ? error.message : String(error))
      setMcpHealthStatuses([])
    } finally {
      setMcpHealthLoading(false)
    }
  }, [])

  const refreshInstalledPlugins = useCallback(async () => {
    setPluginDiscoveryLoading(true)
    setPluginDiscoveryError(null)

    try {
      const result = await discoverInstalledPlugins(currentWorkspacePath)
      pluginRegistry.replaceInstalled(result.plugins)
      setPluginDiscoveryIssues(result.errors)
      setPlugins(pluginRegistry.listPlugins())

      // 触发 autoStart：对发现到的、已启用插件启动 autoStart 服务
      try {
        const states = usePluginStore.getState().pluginStates
        const enabledMap: Record<string, { enabled: boolean }> = {}
        for (const plugin of pluginRegistry.listPlugins()) {
          const st = states[plugin.id]
          enabledMap[plugin.id] = { enabled: st ? st.enabled : plugin.enabledByDefault }
        }
        const statuses = await pluginServiceManager.autoStartAll(enabledMap, currentWorkspacePath)
        if (statuses.length > 0) {
          usePluginServiceStore.getState().updateServiceStatuses(statuses)
        }
      } catch (_err) {
        // 启动失败不阻塞 UI；服务管理面板会显示错误状态
      }
    } catch (error) {
      setPluginDiscoveryError(error instanceof Error ? error.message : String(error))
      setPluginDiscoveryIssues([])
    } finally {
      setPluginDiscoveryLoading(false)
    }
  }, [currentWorkspacePath])

  const refreshInstallLocations = useCallback(async () => {
    try {
      setPluginInstallLocations(await getPluginInstallLocations(currentWorkspacePath))
    } catch (error) {
      setPluginDiscoveryError(error instanceof Error ? error.message : String(error))
      setPluginInstallLocations(null)
    }
  }, [currentWorkspacePath])

  const handleOpenInstallDirectory = useCallback(async () => {
    const path = pluginInstallScope === 'project'
      ? pluginInstallLocations?.projectPath
      : pluginInstallLocations?.userPath
    if (!path) return
    await openInDefaultApp(path)
  }, [pluginInstallLocations, pluginInstallScope])

  const handleInstallLocalPlugin = useCallback(async () => {
    if (!isTauri()) return
    setPluginOperationMessage(null)

    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('plugins.selectPluginDirectory', { defaultValue: 'Select plugin directory' }),
      })
      const sourcePath = Array.isArray(selected) ? selected[0] : selected
      if (!sourcePath) return

      setPluginOperationLoading(true)
      const result = await installLocalPlugin(sourcePath, pluginInstallScope, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.installFailed', { defaultValue: 'Plugin install failed' }))
        return
      }

      setPluginOperationMessage(result.message ?? t('plugins.installSucceeded', { defaultValue: 'Plugin installed' }))
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginOperationLoading(false)
    }
  }, [currentWorkspacePath, pluginInstallScope, refreshInstallLocations, refreshInstalledPlugins, t])

  const handleInstallPluginPackage = useCallback(async () => {
    if (!isTauri()) return
    setPluginOperationMessage(null)

    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [
          { name: 'Plugin package', extensions: ['zip', 'json'] },
        ],
        title: t('plugins.selectPluginPackage', { defaultValue: 'Select plugin package' }),
      })
      const packagePath = Array.isArray(selected) ? selected[0] : selected
      if (!packagePath) return

      setPluginOperationLoading(true)
      const result = await installPluginPackage(packagePath, pluginInstallScope, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.installFailed', { defaultValue: 'Plugin install failed' }))
        return
      }

      setPluginOperationMessage(result.message ?? t('plugins.installSucceeded', { defaultValue: 'Plugin installed' }))
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginOperationLoading(false)
    }
  }, [currentWorkspacePath, pluginInstallScope, refreshInstallLocations, refreshInstalledPlugins, t])

  const handleInstallRemotePlugin = useCallback(async () => {
    const sourceUrl = pluginRemoteSourceUrl.trim()
    if (!sourceUrl) return

    setPluginOperationLoading(true)
    setPluginOperationMessage(null)

    try {
      const result = await installRemotePlugin(sourceUrl, pluginInstallScope, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.installFailed', { defaultValue: 'Plugin install failed' }))
        return
      }

      setPluginRemoteSourceUrl('')
      setPluginOperationMessage(result.message ?? t('plugins.installSucceeded', { defaultValue: 'Plugin installed' }))
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginOperationLoading(false)
    }
  }, [currentWorkspacePath, pluginInstallScope, pluginRemoteSourceUrl, refreshInstallLocations, refreshInstalledPlugins, t])

  const handleUninstallLocalPlugin = useCallback(async (pluginId: string, installPath?: string) => {
    if (!installPath) return
    const confirmed = window.confirm(t('plugins.uninstallConfirm', {
      defaultValue: 'Uninstall plugin {{pluginId}}? This removes its installed directory.',
      pluginId,
    }))
    if (!confirmed) return

    setPluginOperationLoading(true)
    setPluginOperationMessage(null)

    try {
      // 卸载前先停止该插件的所有服务，避免文件被进程占用导致删除失败
      try {
        const stopped = await pluginServiceManager.stopServicesForPlugin(pluginId)
        const serviceStore = usePluginServiceStore.getState()
        for (const status of stopped) {
          serviceStore.removeServiceStatus(status.pluginId, status.serviceId)
        }
      } catch (_err) {
        // 即便停止失败也继续尝试卸载
      }

      const result = await uninstallLocalPlugin(installPath, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.uninstallFailed', { defaultValue: 'Plugin uninstall failed' }))
        return
      }

      resetPluginState(pluginId)
      setPluginOperationMessage(result.message ?? t('plugins.uninstallSucceeded', { defaultValue: 'Plugin uninstalled' }))
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginOperationLoading(false)
    }
  }, [currentWorkspacePath, refreshInstallLocations, refreshInstalledPlugins, resetPluginState, t])

  const handleCheckPluginUpdate = useCallback(async (pluginId: string, installPath?: string) => {
    if (!installPath) return

    setPluginOperationMessage(null)
    setPluginUpdateLoadingId(pluginId)

    try {
      const result = await checkPluginUpdate(installPath)
      setPluginUpdateChecks((checks) => ({ ...checks, [pluginId]: result }))
      if (result.error) {
        setPluginOperationMessage(result.error)
      }
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginUpdateLoadingId(null)
    }
  }, [])

  const handleApplyPluginUpdate = useCallback(async (pluginId: string, installPath?: string) => {
    if (!installPath) return
    const confirmed = window.confirm(t('plugins.applyUpdateConfirm', {
      defaultValue: 'Apply update for plugin {{pluginId}}? This replaces its installed directory.',
      pluginId,
    }))
    if (!confirmed) return

    setPluginUpdateApplyLoadingId(pluginId)
    setPluginOperationMessage(null)

    try {
      const result = await applyPluginUpdate(installPath, currentWorkspacePath)
      if (!result.success) {
        setPluginOperationMessage(result.error ?? t('plugins.updateApplyFailed', { defaultValue: 'Plugin update failed' }))
        return
      }

      setPluginOperationMessage(result.message ?? t('plugins.updateApplySucceeded', { defaultValue: 'Plugin updated' }))
      setPluginUpdateChecks((checks) => {
        const next = { ...checks }
        delete next[pluginId]
        return next
      })
      await refreshInstalledPlugins()
      await refreshInstallLocations()
    } catch (error) {
      setPluginOperationMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginUpdateApplyLoadingId(null)
    }
  }, [currentWorkspacePath, refreshInstallLocations, refreshInstalledPlugins, t])

  useEffect(() => {
    refreshMcpHealth()
  }, [refreshMcpHealth])

  useEffect(() => {
    refreshInstallLocations()
  }, [refreshInstallLocations])

  return (
    <div className="space-y-3">
      {/* === 顶部紧凑工具栏 === */}
      <div className="rounded-lg border border-border-subtle bg-background-surface p-3 space-y-2">
        {/* 第一行：摘要信息 + 刷新 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-xs text-text-tertiary">
            {pluginDiscoveryError
              ? <span className="text-danger">{t('plugins.discoveryError', { defaultValue: 'Discovery failed', error: pluginDiscoveryError })}</span>
              : <span>{t('plugins.discoverySummary', { defaultValue: '{{count}} installed, {{issues}} diagnostics', count: discoveredPluginCount, issues: pluginDiscoveryIssues.length })}</span>
            }
            <span className="text-border-subtle">|</span>
            {mcpHealthError
              ? <span className="text-danger">{t('plugins.mcpHealthError', { defaultValue: 'MCP unavailable', error: mcpHealthError })}</span>
              : <span>{t('plugins.mcpRuntimeSummary', { defaultValue: 'MCP: {{enabled}} on, {{disabled}} off', enabled: enabledMcpServerCount, disabled: disabledMcpServerCount })}</span>
            }
          </div>
          <button
            type="button"
            onClick={() => { refreshInstalledPlugins(); refreshMcpHealth() }}
            disabled={pluginDiscoveryLoading || mcpHealthLoading}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={12} className={pluginDiscoveryLoading || mcpHealthLoading ? 'animate-spin' : ''} />
            {t('plugins.refreshDiscovery', { defaultValue: 'Refresh' })}
          </button>
        </div>

        {/* 第二行：安装目录 + 操作按钮 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-text-tertiary">{t('plugins.installDirectoryTitle', { defaultValue: 'Dir' })}:</span>
          <span className="max-w-[280px] truncate text-text-secondary">
            {pluginInstallScope === 'project'
              ? pluginInstallLocations?.projectPath ?? t('plugins.projectInstallUnavailable', { defaultValue: 'Open a workspace' })
              : pluginInstallLocations?.userPath ?? t('plugins.installLocationsUnavailable', { defaultValue: 'Unavailable' })}
          </span>
          <select
            value={pluginInstallScope}
            onChange={(event) => setPluginInstallScope(event.target.value as 'user' | 'project')}
            className="rounded border border-border-subtle bg-background-surface px-1.5 py-1 text-xs text-text-secondary"
          >
            <option value="user">{t('plugins.userInstallScope', { defaultValue: 'User' })}</option>
            <option value="project" disabled={!currentWorkspacePath}>
              {t('plugins.projectInstallScope', { defaultValue: 'Project' })}
            </option>
          </select>
          <button
            type="button"
            onClick={handleOpenInstallDirectory}
            disabled={pluginInstallScope === 'project' && !pluginInstallLocations?.projectPath}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FolderOpen size={11} />
            {t('plugins.openInstallDirectory', { defaultValue: 'Open' })}
          </button>
          <button
            type="button"
            onClick={handleInstallLocalPlugin}
            disabled={pluginOperationLoading || !isTauri() || (pluginInstallScope === 'project' && !currentWorkspacePath)}
            className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PackagePlus size={11} />
            {t('plugins.installFromDirectory', { defaultValue: 'Install dir' })}
          </button>
          <button
            type="button"
            onClick={handleInstallPluginPackage}
            disabled={pluginOperationLoading || !isTauri() || (pluginInstallScope === 'project' && !currentWorkspacePath)}
            className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PackagePlus size={11} />
            {t('plugins.installFromPackage', { defaultValue: 'Install pkg' })}
          </button>
        </div>

        {/* 第三行：远程安装 URL */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={pluginRemoteSourceUrl}
            onChange={(event) => setPluginRemoteSourceUrl(event.target.value)}
            placeholder={t('plugins.remoteSourcePlaceholder', { defaultValue: 'Remote manifest or package URL' })}
            className="min-w-0 flex-1 rounded border border-border-subtle bg-background-elevated px-2 py-1 text-xs text-text-secondary placeholder:text-text-muted"
          />
          <button
            type="button"
            onClick={handleInstallRemotePlugin}
            disabled={pluginOperationLoading || !pluginRemoteSourceUrl.trim() || (pluginInstallScope === 'project' && !currentWorkspacePath)}
            className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PackagePlus size={11} />
            {t('plugins.installRemote', { defaultValue: 'Remote' })}
          </button>
        </div>

        {/* 操作反馈消息 */}
        {pluginOperationMessage && (
          <div className="text-xs text-text-tertiary">{pluginOperationMessage}</div>
        )}
      </div>

      {/* === 诊断警告 === */}
      {pluginDiscoveryIssues.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 space-y-0.5">
            <div className="text-xs font-medium text-warning">
              {t('plugins.discoveryIssuesTitle', { defaultValue: 'Manifest diagnostics' })}
            </div>
            {pluginDiscoveryIssues.map((issue, index) => (
              <div key={`${issue.path}-${index}`} className="text-[11px] text-text-tertiary">
                <span className="text-text-secondary">{issue.path}</span>
                {' — '}
                {issue.error}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === 插件开发指南 === */}
      <div className="rounded-lg border border-border-subtle bg-background-surface">
        <button
          type="button"
          onClick={() => setShowGuide(!showGuide)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <BookOpen size={14} className="shrink-0 text-text-muted" />
          <span className="flex-1 text-xs font-medium text-text-secondary">
            {t('plugins.guideTitle', { defaultValue: 'Plugin Development Guide' })}
          </span>
          {showGuide ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
        </button>
        {showGuide && (
          <div className="border-t border-border-subtle px-3 py-3">
            <PluginGuide />
          </div>
        )}
      </div>

      {/* === 插件列表 === */}
      <div className="space-y-1">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            state={pluginStates[plugin.id] ?? {
              enabled: plugin.enabledByDefault,
              uiEnabled: true,
              mcpEnabled: true,
            }}
            expanded={expandedPlugins.has(plugin.id)}
            onToggleExpand={toggleExpand}
            mcpServerStatuses={mcpServerStatuses.filter((server) => server.pluginId === plugin.id)}
            mcpHealthByName={mcpHealthByName}
            updateCheck={pluginUpdateChecks[plugin.id]}
            updateLoadingId={pluginUpdateLoadingId}
            updateApplyLoadingId={pluginUpdateApplyLoadingId}
            onSetEnabled={setPluginEnabled}
            onSetUiEnabled={setPluginUiEnabled}
            onSetMcpEnabled={setPluginMcpEnabled}
            onSetMcpServerEnabled={setPluginMcpServerEnabled}
            onReset={resetPluginState}
            onCheckUpdate={handleCheckPluginUpdate}
            onApplyUpdate={handleApplyPluginUpdate}
            onUninstall={handleUninstallLocalPlugin}
            pluginStates={pluginStates}
            operationLoading={pluginOperationLoading}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

/* ========================================================================
   单个插件卡片（折叠/展开）
   ======================================================================== */

interface PluginCardProps {
  plugin: PolarisPluginManifest
  state: { enabled: boolean; uiEnabled: boolean; mcpEnabled: boolean }
  expanded: boolean
  onToggleExpand: (id: string) => void
  mcpServerStatuses: Array<{ id: string; pluginId: string; transport: string; command: string; enabled: boolean }>
  mcpHealthByName: Map<string, McpHealthStatus>
  updateCheck?: PluginUpdateCheckResult
  updateLoadingId: string | null
  updateApplyLoadingId: string | null
  pluginStates: Record<string, { enabled: boolean; uiEnabled: boolean; mcpEnabled: boolean }>
  operationLoading: boolean
  onSetEnabled: (id: string, enabled: boolean) => void
  onSetUiEnabled: (id: string, enabled: boolean) => void
  onSetMcpEnabled: (id: string, enabled: boolean) => void
  onSetMcpServerEnabled: (pluginId: string, serverId: string, enabled: boolean) => void
  onReset: (id: string) => void
  onCheckUpdate: (id: string, installPath?: string) => void
  onApplyUpdate: (id: string, installPath?: string) => void
  onUninstall: (id: string, installPath?: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
}

function PluginCard({
  plugin,
  state,
  expanded,
  onToggleExpand,
  mcpServerStatuses,
  mcpHealthByName,
  updateCheck,
  updateLoadingId,
  updateApplyLoadingId,
  pluginStates,
  operationLoading,
  onSetEnabled,
  onSetUiEnabled,
  onSetMcpEnabled,
  onSetMcpServerEnabled,
  onReset,
  onCheckUpdate,
  onApplyUpdate,
  onUninstall,
  t,
}: PluginCardProps) {
  const isCorePlugin = plugin.id === 'polaris.core'
  const views = plugin.contributes.views ?? []
  const permissionEntries = Object.entries(plugin.permissions).filter(([, enabled]) => enabled)
  const originEntries = Object.entries(plugin.origin ?? {})
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
  const hasDetails = views.length > 0 || mcpServerStatuses.length > 0 || permissionEntries.length > 0 || originEntries.length > 0

  return (
    <div className={`rounded-lg border transition-colors ${expanded ? 'border-border-subtle bg-background-surface' : 'border-transparent hover:border-border-subtle hover:bg-background-surface/50'}`}>
      {/* === 折叠头：始终显示 === */}
      <div
        className={`flex items-center gap-3 px-3 py-2.5 ${hasDetails ? 'cursor-pointer select-none' : ''}`}
        onClick={() => hasDetails && onToggleExpand(plugin.id)}
      >
        {/* 展开箭头 */}
        <span className="shrink-0 text-text-muted">
          {hasDetails
            ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
            : <span className="inline-block w-[14px]" />
          }
        </span>

        {/* 插件名称 + 版本 + 标签 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-text-primary truncate">{plugin.name}</span>
            <span className="text-[10px] text-text-muted">v{plugin.version}</span>
            {plugin.builtin && (
              <span className="rounded-sm bg-primary/10 px-1 py-px text-[10px] leading-tight text-primary">
                {t('plugins.builtin')}
              </span>
            )}
            {!plugin.builtin && plugin.source && (
              <span className="rounded-sm bg-background-hover px-1 py-px text-[10px] leading-tight text-text-muted">
                {plugin.source.kind === 'project'
                  ? t('plugins.projectInstalled', { defaultValue: 'Project' })
                  : t('plugins.userInstalled', { defaultValue: 'User' })}
              </span>
            )}
          </div>
          {plugin.description && (
            <div className="mt-0.5 text-xs text-text-tertiary line-clamp-1">{plugin.description}</div>
          )}
        </div>

        {/* 功能摘要 badge */}
        {!expanded && (
          <div className="hidden sm:flex items-center gap-1.5 shrink-0">
            {views.length > 0 && (
              <span className="text-[10px] text-text-muted">
                {t('plugins.viewCount', { defaultValue: '{{count}} views', count: views.length })}
              </span>
            )}
            {mcpServerStatuses.length > 0 && (
              <span className="text-[10px] text-text-muted">
                {t('plugins.mcpCount', { defaultValue: '{{count}} MCP', count: mcpServerStatuses.length })}
              </span>
            )}
          </div>
        )}

        {/* 启用开关 */}
        <label
          className="shrink-0 flex items-center gap-1.5 text-xs text-text-secondary"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={isCorePlugin}
            onChange={(event) => onSetEnabled(plugin.id, event.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
        </label>
      </div>

      {/* === 展开详情 === */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border-subtle">
          {/* 插件 ID + 路径 + 来源 */}
          <div className="pt-2 space-y-0.5 text-[11px] text-text-muted">
            <div className="font-mono">{plugin.id}</div>
            {!plugin.builtin && plugin.installPath && (
              <div className="truncate">{plugin.installPath}</div>
            )}
            {originEntries.length > 0 && (
              <div className="flex flex-wrap gap-x-3">
                {originEntries.map(([key, value]) => (
                  <span key={key}>
                    {t(`plugins.origin.${key}`, { defaultValue: key })}: {value}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 核心插件锁定提示 */}
          {isCorePlugin && (
            <div className="rounded border border-border-subtle bg-background-elevated px-2.5 py-1.5 text-xs text-text-muted">
              {t('plugins.coreLocked')}
            </div>
          )}

          {/* 三列信息：界面 | MCP 服务器 | 权限 */}
          <div className="grid gap-2 sm:grid-cols-3">
            {/* 界面 */}
            <div className="rounded border border-border-subtle bg-background-elevated p-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-text-secondary">
                  {t('plugins.uiSurface', { defaultValue: 'UI' })}
                </span>
                <input
                  type="checkbox"
                  checked={state.uiEnabled}
                  disabled={!state.enabled || isCorePlugin}
                  onChange={(event) => onSetUiEnabled(plugin.id, event.target.checked)}
                  className="h-3.5 w-3.5 accent-primary"
                />
              </div>
              {views.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {views.map((view) => {
                    const Icon = pluginIconMap[view.icon]
                    return (
                      <span
                        key={view.id}
                        className="inline-flex items-center gap-0.5 rounded-sm bg-background-surface px-1.5 py-0.5 text-[11px] text-text-secondary"
                      >
                        <Icon size={10} />
                        {t(view.labelKey, { defaultValue: view.labelDefault ?? view.panelType })}
                      </span>
                    )
                  })}
                </div>
              ) : (
                <span className="text-[11px] text-text-muted">{t('plugins.noViews', { defaultValue: 'None' })}</span>
              )}
            </div>

            {/* MCP 服务器 */}
            <div className="rounded border border-border-subtle bg-background-elevated p-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-text-secondary">
                  {t('plugins.mcpSurface', { defaultValue: 'MCP' })}
                </span>
                <label className="flex items-center gap-1 text-[11px] text-text-muted">
                  {t('plugins.enableAllMcp', { defaultValue: 'All' })}
                  <input
                    type="checkbox"
                    checked={state.mcpEnabled}
                    disabled={!state.enabled || mcpServerStatuses.length === 0}
                    onChange={(event) => onSetMcpEnabled(plugin.id, event.target.checked)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                </label>
              </div>
              {mcpServerStatuses.length > 0 ? (
                <div className="space-y-1">
                  {mcpServerStatuses.map((server) => {
                    const runtime = mcpHealthByName.get(server.id)
                    return (
                      <div key={server.id} className="flex items-center justify-between gap-1 text-[11px]">
                        <div className="min-w-0 flex-1">
                          <span className={server.enabled ? 'text-text-secondary' : 'text-text-muted line-through'}>
                            {server.id}
                          </span>
                          <span className="ml-1 text-text-muted">[{server.transport}]</span>
                          {server.enabled && runtime && (
                            <span className={`ml-1 ${runtime.connected ? 'text-success' : 'text-warning'}`}>
                              {runtime.connected ? '●' : '○'}
                            </span>
                          )}
                        </div>
                        <input
                          type="checkbox"
                          checked={server.enabled}
                          disabled={!state.enabled || !state.mcpEnabled}
                          onChange={(event) => onSetMcpServerEnabled(plugin.id, server.id, event.target.checked)}
                          className="h-3 w-3 shrink-0 accent-primary"
                        />
                      </div>
                    )
                  })}
                </div>
              ) : (
                <span className="text-[11px] text-text-muted">{t('plugins.noMcpServers', { defaultValue: 'None' })}</span>
              )}
            </div>

            {/* 权限 */}
            <div className="rounded border border-border-subtle bg-background-elevated p-2.5">
              <div className="mb-1.5">
                <span className="text-xs font-medium text-text-secondary">
                  {t('plugins.permissionsTitle', { defaultValue: 'Permissions' })}
                </span>
              </div>
              {permissionEntries.length > 0 ? (
                <div className="text-[11px] text-text-tertiary">
                  {permissionEntries.map(([key], i) => (
                    <span key={key}>
                      {i > 0 && <span className="text-text-muted">, </span>}
                      {formatPermissionLabel(key, t)}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-text-muted">{t('plugins.noPermissions')}</span>
              )}
            </div>
          </div>

          {/* 操作按钮行 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onReset(plugin.id)}
              disabled={pluginStates[plugin.id] === undefined}
              className="rounded border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('plugins.reset')}
            </button>
            {!plugin.builtin && (
              <>
                <button
                  type="button"
                  onClick={() => onCheckUpdate(plugin.id, plugin.installPath)}
                  disabled={updateLoadingId === plugin.id || !plugin.installPath}
                  className="inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:bg-background-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={10} className={updateLoadingId === plugin.id ? 'animate-spin' : ''} />
                  {updateLoadingId === plugin.id
                    ? t('plugins.checkingUpdate', { defaultValue: 'Checking...' })
                    : t('plugins.checkUpdate', { defaultValue: 'Update' })}
                </button>
                <button
                  type="button"
                  onClick={() => onUninstall(plugin.id, plugin.installPath)}
                  disabled={operationLoading || !plugin.installPath}
                  className="inline-flex items-center gap-1 rounded border border-danger/30 px-2 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 size={10} />
                  {t('plugins.uninstall', { defaultValue: 'Uninstall' })}
                </button>
              </>
            )}
          </div>

          {/* 更新信息条 */}
          {updateCheck && (
            <div className="flex items-center justify-between gap-2 rounded border border-border-subtle bg-background-elevated px-2.5 py-1.5 text-[11px] text-text-tertiary">
              <div className="min-w-0 truncate">
                {updateCheck.checked
                  ? updateCheck.updateAvailable
                    ? t('plugins.updateAvailable', {
                      defaultValue: 'Update: {{current}} → {{latest}}',
                      current: updateCheck.currentVersion,
                      latest: updateCheck.latestVersion ?? '?',
                    })
                    : t('plugins.noUpdateAvailable', {
                      defaultValue: 'Up to date ({{version}})',
                      version: updateCheck.currentVersion,
                    })
                  : updateCheck.error ?? t('plugins.updateUnavailable', { defaultValue: 'Update check failed' })}
              </div>
              {updateCheck.updateAvailable && (
                <button
                  type="button"
                  onClick={() => onApplyUpdate(plugin.id, plugin.installPath)}
                  disabled={updateApplyLoadingId === plugin.id || !plugin.installPath || !updateCheck.downloadUrl}
                  className="shrink-0 inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={10} className={updateApplyLoadingId === plugin.id ? 'animate-spin' : ''} />
                  {updateApplyLoadingId === plugin.id
                    ? t('plugins.applyingUpdate', { defaultValue: 'Updating...' })
                    : t('plugins.applyUpdate', { defaultValue: 'Apply' })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
