/**
 * Spring Boot 调试运行面板
 *
 * 提供 Spring Boot 项目的检测、启动、停止、状态监控功能
 * 支持实时日志显示和调试模式
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Play,
  Square,
  Bug,
  Terminal,
  CheckCircle,
  XCircle,
  Loader2,
  FolderOpen,
  Settings,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Copy,
  Info,
} from 'lucide-react';
import { useSpringBootStore } from '@/stores/springBootStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { SpringBootProject, StartConfig } from '@/stores/springBootStore';

// ============================================================================
// 日志查看器组件
// ============================================================================

interface LogViewerProps {
  sessionId: string;
  maxHeight?: number;
}

function LogViewer({ sessionId, maxHeight = 300 }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);

  // 清理 ANSI 转义序列
  const cleanAnsi = useCallback((text: string): string => {
    // 移除 ANSI 转义序列
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC 序列
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // 控制字符
      .trim();
  }, []);

  useEffect(() => {
    const handleOutput = (e: CustomEvent<{ sessionId: string; data: string }>) => {
      if (e.detail.sessionId !== sessionId) return;

      try {
        // 解码 base64 数据
        const binary = atob(e.detail.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const text = new TextDecoder().decode(bytes);
        
        // 清理 ANSI 序列并按行分割
        const cleaned = cleanAnsi(text);
        if (!cleaned) return;
        
        const newLines = cleaned.split('\n').filter((line) => line.trim());
        
        setLogs((prev) => {
          const combined = [...prev, ...newLines];
          // 保留最近的500行
          return combined.slice(-500);
        });
      } catch {
        // 解码失败忽略
      }
    };

    window.addEventListener('terminal-output', handleOutput as EventListener);
    return () => {
      window.removeEventListener('terminal-output', handleOutput as EventListener);
    };
  }, [sessionId, cleanAnsi]);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // 如果用户滚动到底部附近，启用自动滚动
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  }, []);

  const handleCopyLogs = useCallback(() => {
    navigator.clipboard.writeText(logs.join('\n'));
  }, [logs]);

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 bg-background-surface border-b border-border">
        <span className="text-xs text-text-secondary">日志输出</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3 h-3"
            />
            自动滚动
          </label>
          <button
            onClick={handleCopyLogs}
            className="p-1 text-text-secondary hover:text-text-primary rounded"
            title="复制日志"
          >
            <Copy size={12} />
          </button>
          <button
            onClick={() => setLogs([])}
            className="p-1 text-text-secondary hover:text-text-primary rounded"
            title="清空日志"
          >
            <XCircle size={12} />
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="font-mono text-xs bg-[#1e1e1e] text-[#d4d4d4] p-2 overflow-y-auto"
        style={{ maxHeight }}
      >
        {logs.length === 0 ? (
          <div className="text-text-tertiary italic">等待日志输出...</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all leading-relaxed">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 调试指引组件
// ============================================================================

function DebugGuide({ port }: { port: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-primary/20 bg-primary/5 rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
      >
        <Bug size={14} className="text-primary" />
        <span className="text-sm font-medium text-primary">调试连接指南</span>
        {expanded ? (
          <ChevronDown size={14} className="ml-auto text-text-secondary" />
        ) : (
          <ChevronRight size={14} className="ml-auto text-text-secondary" />
        )}
      </button>
      
      {expanded && (
        <div className="px-3 pb-3 text-sm space-y-3">
          <div className="text-text-secondary">
            调试端口: <code className="px-1.5 py-0.5 bg-background-surface rounded text-primary font-mono">{port}</code>
          </div>

          {/* IntelliJ IDEA */}
          <div>
            <div className="flex items-center gap-1.5 font-medium text-text-primary mb-1">
              <span>IntelliJ IDEA</span>
            </div>
            <ol className="list-decimal list-inside text-text-secondary space-y-1 ml-2">
              <li>Run → Edit Configurations → + → Remote JVM Debug</li>
              <li>Host: <code className="px-1 bg-background-surface rounded">localhost</code></li>
              <li>Port: <code className="px-1 bg-background-surface rounded">{port}</code></li>
              <li>点击 Debug 按钮连接</li>
            </ol>
          </div>

          {/* VS Code */}
          <div>
            <div className="flex items-center gap-1.5 font-medium text-text-primary mb-1">
              <span>VS Code</span>
            </div>
            <div className="text-text-secondary ml-2">
              在 <code className="px-1 bg-background-surface rounded">.vscode/launch.json</code> 中添加:
              <pre className="mt-1 p-2 bg-[#1e1e1e] text-[#d4d4d4] rounded text-xs overflow-x-auto">{`{
  "type": "java",
  "name": "Remote Debug",
  "request": "attach",
  "hostName": "localhost",
  "port": ${port}
}`}</pre>
            </div>
          </div>

          {/* curl 验证 */}
          <div>
            <div className="flex items-center gap-1.5 font-medium text-text-primary mb-1">
              <span>验证应用运行</span>
            </div>
            <div className="text-text-secondary ml-2">
              <code className="block p-2 bg-[#1e1e1e] text-[#d4d4d4] rounded text-xs">
                curl http://localhost:{port}
              </code>
            </div>
          </div>

          <div className="flex items-start gap-1.5 text-xs text-text-tertiary pt-1">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>调试模式下，应用启动后会等待调试器连接。如需跳过等待，请在 JVM 参数中添加 <code>-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address={port}</code></span>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 项目检测组件
// ============================================================================

interface ProjectDetectorProps {
  onDetected: (project: SpringBootProject) => void;
}

function ProjectDetector({ onDetected }: ProjectDetectorProps) {
  const { detectProject, loading, error } = useSpringBootStore();
  const getCurrentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace);
  const [path, setPath] = useState('');

  useEffect(() => {
    const workspace = getCurrentWorkspace();
    if (workspace?.path) {
      setPath(workspace.path);
    }
  }, [getCurrentWorkspace]);

  const handleDetect = useCallback(async () => {
    if (!path.trim()) return;
    try {
      const project = await detectProject(path.trim());
      onDetected(project);
    } catch {
      // 错误已在 store 中处理
    }
  }, [path, detectProject, onDetected]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleDetect();
    }
  }, [handleDetect]);

  return (
    <div className="p-4 border-b border-border">
      <div className="text-sm font-medium text-text-primary mb-2">项目路径</div>
      <div className="flex gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入或粘贴 Spring Boot 项目路径"
          className="flex-1 px-3 py-1.5 text-sm bg-background-surface border border-border rounded
                     focus:outline-none focus:border-primary"
        />
        <button
          onClick={handleDetect}
          disabled={loading || !path.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded
                     hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <FolderOpen size={14} />
          )}
          检测
        </button>
      </div>
      {error && (
        <div className="flex items-center gap-1.5 mt-2 text-sm text-error">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 项目信息组件
// ============================================================================

interface ProjectInfoProps {
  project: SpringBootProject;
}

function ProjectInfo({ project }: ProjectInfoProps) {
  return (
    <div className="p-4 border-b border-border bg-background-surface">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-primary" />
          <span className="font-medium text-text-primary">{project.name}</span>
        </div>
        <span
          className={`px-2 py-0.5 text-xs rounded ${
            project.buildTool === 'maven'
              ? 'bg-orange-100 text-orange-700'
              : 'bg-blue-100 text-blue-700'
          }`}
        >
          {project.buildTool === 'maven' ? 'Maven' : 'Gradle'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        {project.springBootVersion && (
          <div className="text-text-secondary">
            Spring Boot: <span className="text-text-primary">{project.springBootVersion}</span>
          </div>
        )}
        {project.javaVersion && (
          <div className="text-text-secondary">
            Java: <span className="text-text-primary">{project.javaVersion}</span>
          </div>
        )}
        {project.port && (
          <div className="text-text-secondary">
            端口: <span className="text-text-primary">{project.port}</span>
          </div>
        )}
        {project.mainClass && (
          <div className="text-text-secondary col-span-2 truncate">
            主类: <span className="text-text-primary font-mono text-xs">{project.mainClass}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-3">
        {project.hasDevtools && (
          <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded">
            DevTools ✓ 热重载
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 启动配置组件
// ============================================================================

interface StartConfigPanelProps {
  project: SpringBootProject;
  onStart: (config: StartConfig) => void;
  loading: boolean;
}

function StartConfigPanel({ project, onStart, loading }: StartConfigPanelProps) {
  const [debug, setDebug] = useState(false);
  const [debugPort, setDebugPort] = useState('5005');
  const [appPort, setAppPort] = useState(String(project.port || 8080));
  const [jvmArgs, setJvmArgs] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleStart = useCallback(() => {
    const config: StartConfig = {
      projectPath: project.path,
      debug,
      debugPort: debug ? parseInt(debugPort) : undefined,
      appPort: parseInt(appPort) || undefined,
      jvmArgs: jvmArgs.trim() ? jvmArgs.split(/\s+/) : undefined,
    };
    onStart(config);
  }, [project.path, debug, debugPort, appPort, jvmArgs, onStart]);

  return (
    <div className="p-4 border-b border-border">
      <div className="flex items-center gap-2 mb-3">
        <Settings size={14} className="text-text-secondary" />
        <span className="text-sm font-medium text-text-primary">启动配置</span>
      </div>

      <div className="space-y-3">
        {/* 调试模式 */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => setDebug(e.target.checked)}
            className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
          />
          <Bug size={14} className={debug ? 'text-primary' : 'text-text-secondary'} />
          <span className="text-sm text-text-primary">启用调试模式</span>
          <span className="text-xs text-text-tertiary">(远程调试)</span>
        </label>

        {debug && (
          <div className="ml-6 p-2 bg-primary/5 border border-primary/20 rounded text-xs text-text-secondary">
            <div className="flex items-center gap-1 mb-1">
              <Info size={12} className="text-primary" />
              <span className="font-medium text-primary">调试模式已启用</span>
            </div>
            <p>应用启动后可通过 IDE 连接调试器，端口: <code className="text-primary">{debugPort}</code></p>
          </div>
        )}

        {/* 应用端口 */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary">应用端口:</span>
          <input
            type="number"
            value={appPort}
            onChange={(e) => setAppPort(e.target.value)}
            className="w-20 px-2 py-1 text-sm bg-background-surface border border-border rounded
                       focus:outline-none focus:border-primary"
          />
        </div>

        {/* 高级选项 */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
        >
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          高级选项
        </button>

        {showAdvanced && (
          <div className="space-y-3 pl-4 border-l-2 border-border">
            {debug && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-secondary">调试端口:</span>
                <input
                  type="number"
                  value={debugPort}
                  onChange={(e) => setDebugPort(e.target.value)}
                  className="w-20 px-2 py-1 text-sm bg-background-surface border border-border rounded
                             focus:outline-none focus:border-primary"
                />
              </div>
            )}

            {/* JVM 参数 */}
            <div>
              <span className="text-sm text-text-secondary block mb-1">额外 JVM 参数:</span>
              <input
                type="text"
                value={jvmArgs}
                onChange={(e) => setJvmArgs(e.target.value)}
                placeholder="-Xmx512m -Dspring.profiles.active=dev"
                className="w-full px-3 py-1.5 text-sm bg-background-surface border border-border rounded
                           focus:outline-none focus:border-primary font-mono"
              />
            </div>
          </div>
        )}

        {/* 启动按钮 */}
        <button
          onClick={handleStart}
          disabled={loading}
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-sm font-medium
                     bg-green-600 text-white rounded hover:bg-green-700
                     disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Play size={16} />
          )}
          {debug ? '启动并等待调试器' : '启动应用'}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 应用状态组件（带日志）
// ============================================================================

interface AppStatusCardProps {
  app: {
    id: string;
    sessionId?: string;
    project: SpringBootProject;
    status: string;
    port?: number;
    debugEnabled: boolean;
    debugPort?: number;
    error?: string;
  };
  onStop: (appId: string) => void;
  loading: boolean;
}

function AppStatusCard({ app, onStop, loading }: AppStatusCardProps) {
  const [showLogs, setShowLogs] = useState(app.status === 'starting' || app.status === 'running');
  const statusConfig: Record<string, { icon: typeof XCircle; color: string; bg: string; label: string; animate?: boolean }> = {
    stopped: { icon: XCircle, color: 'text-text-secondary', bg: 'bg-gray-100', label: '已停止' },
    starting: { icon: Loader2, color: 'text-yellow-500', bg: 'bg-yellow-100', label: '启动中', animate: true },
    running: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-100', label: '运行中' },
    stopping: { icon: Loader2, color: 'text-orange-500', bg: 'bg-orange-100', label: '停止中', animate: true },
    error: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100', label: '错误' },
  };

  const status = statusConfig[app.status as keyof typeof statusConfig] || statusConfig.stopped;
  const StatusIcon = status.icon;

  return (
    <div className="border-b border-border">
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-primary" />
            <span className="font-medium text-text-primary">{app.project.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded ${status.bg} ${status.color}`}
            >
              <StatusIcon
                size={12}
                className={status.animate ? 'animate-spin' : ''}
              />
              {status.label}
            </span>
            {(app.status === 'running' || app.status === 'starting') && (
              <button
                onClick={() => onStop(app.id)}
                disabled={loading}
                className="p-1.5 text-text-secondary hover:text-red-500 hover:bg-red-50 rounded
                           disabled:opacity-50 transition-colors"
                title="停止应用"
              >
                <Square size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="text-sm text-text-secondary space-y-1">
          {app.port && (
            <div className="flex items-center gap-1">
              <span>端口:</span>
              <code className="px-1 bg-background-surface rounded text-text-primary">{app.port}</code>
              {app.status === 'running' && (
                <a
                  href={`http://localhost:${app.port}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          )}
          {app.debugEnabled && app.debugPort && (
            <div className="flex items-center gap-1">
              <Bug size={12} className="text-primary" />
              <span>调试端口:</span>
              <code className="px-1 bg-primary/10 rounded text-primary">{app.debugPort}</code>
            </div>
          )}
          {app.error && (
            <div className="text-red-500 mt-2 p-2 bg-red-50 rounded text-xs">{app.error}</div>
          )}
        </div>

        {/* 调试指引 */}
        {app.debugEnabled && app.status === 'running' && app.debugPort && (
          <div className="mt-3">
            <DebugGuide port={app.debugPort} />
          </div>
        )}

        {/* 日志切换按钮 */}
        <button
          onClick={() => setShowLogs(!showLogs)}
          className="flex items-center gap-1 mt-3 text-xs text-text-secondary hover:text-text-primary"
        >
          {showLogs ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {showLogs ? '隐藏日志' : '查看日志'}
        </button>
      </div>

      {/* 日志输出 */}
      {showLogs && app.sessionId && (
        <div className="px-4 pb-4">
          <LogViewer sessionId={app.sessionId} maxHeight={250} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 主面板组件
// ============================================================================

export function SpringBootPanel() {
  const {
    apps,
    loading,
    error,
    startApp,
    stopApp,
    listApps,
    clearError,
  } = useSpringBootStore();

  const initEventListeners = useTerminalStore((state) => state.initEventListeners);
  const [detectedProject, setDetectedProject] = useState<SpringBootProject | null>(null);

  // 初始化终端事件监听
  useEffect(() => {
    const cleanup = initEventListeners();
    return cleanup;
  }, [initEventListeners]);

  // 加载应用列表
  useEffect(() => {
    listApps();
  }, [listApps]);

  // 处理项目检测
  const handleDetected = useCallback((project: SpringBootProject) => {
    setDetectedProject(project);
    clearError();
  }, [clearError]);

  // 处理启动
  const handleStart = useCallback(
    async (config: StartConfig) => {
      try {
        await startApp(config);
        // 启动后跳转到日志显示
        setDetectedProject(null);
        // 自动刷新应用列表
        await listApps();
      } catch {
        // 错误已在 store 中处理
      }
    },
    [startApp, listApps]
  );

  // 处理停止
  const handleStop = useCallback(
    async (appId: string) => {
      try {
        await stopApp(appId);
      } catch {
        // 错误已在 store 中处理
      }
    },
    [stopApp]
  );

  return (
    <div className="flex flex-col h-full bg-background-base">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Terminal size={15} className="text-text-tertiary" />
        <span className="text-sm font-medium text-text-primary">Spring Boot 调试</span>
        {apps.length > 0 && (
          <span className="ml-auto text-xs text-text-secondary">
            {apps.length} 个运行中
          </span>
        )}
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* 项目检测 */}
        <ProjectDetector onDetected={handleDetected} />

        {/* 检测到的项目 */}
        {detectedProject && (
          <>
            <ProjectInfo project={detectedProject} />
            <StartConfigPanel
              project={detectedProject}
              onStart={handleStart}
              loading={loading}
            />
          </>
        )}

        {/* 全局错误 */}
        {error && !detectedProject && (
          <div className="p-4">
            <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded text-sm">
              <AlertCircle size={14} />
              {error}
              <button
                onClick={clearError}
                className="ml-auto text-red-500 hover:text-red-700"
              >
                <XCircle size={14} />
              </button>
            </div>
          </div>
        )}

        {/* 运行中的应用 */}
        {apps.length > 0 && (
          <div>
            <div className="px-4 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              运行中的应用
            </div>
            {apps.map((app) => (
              <AppStatusCard
                key={app.id}
                app={app}
                onStop={handleStop}
                loading={loading}
              />
            ))}
          </div>
        )}

        {/* 空状态 */}
        {apps.length === 0 && !detectedProject && (
          <div className="flex flex-col items-center justify-center h-64 text-text-secondary px-6">
            <Terminal size={48} className="mb-3 opacity-50" />
            <p className="text-sm text-center">选择 Spring Boot 项目开始调试</p>
            <p className="text-xs mt-1 text-center">支持 Maven 和 Gradle 项目</p>
            <div className="mt-4 p-3 bg-background-surface rounded-lg text-xs text-left max-w-xs">
              <p className="font-medium text-text-primary mb-2">快速开始:</p>
              <ol className="list-decimal list-inside space-y-1 text-text-secondary">
                <li>输入项目路径</li>
                <li>点击"检测"识别项目</li>
                <li>配置启动参数</li>
                <li>点击"启动应用"</li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 需要导入 terminalStore
import { useTerminalStore } from '@/stores/terminalStore';

export default SpringBootPanel;
