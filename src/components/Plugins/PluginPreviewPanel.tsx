/**
 * PluginPreviewPanel — 插件预览开发页（iframe 沙盒）
 *
 * 目的：在 Polaris 主应用里直接预览任意已安装插件的 dist/panel.js，
 * 无需单独启动 http 服务；报错与样式完全隔离在 iframe 内，不影响主应用。
 *
 * 工作原理：
 * 1. 主应用侧选插件 → readFile 读取其 dist/panel.js 源码
 * 2. 通过 postMessage 把 { panelCode, props } 发给 iframe
 * 3. iframe srcdoc 内置宿主 React shim（window.__POLARIS_HOST_REACT__），
 *    收到 panelCode 后做 react import 重写 → Blob URL 动态 import → 挂载到 #root
 * 4. reload = 重发一次 message（iframe 内重新 revoke + import）
 *
 * 隔离：iframe 独立 DOM / CSS / window，插件全局样式与运行时报错全部封在内。
 * 控制：顶部工具栏选插件、reload、传 props、devtools 打开 iframe。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, AlertCircle, ExternalLink, ChevronDown } from 'lucide-react'
import { pluginRegistry } from '@/plugin-system/registry'
import { readFile } from '@/services/tauri/fileService'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginPreview')

/** 可预览的插件项：installPath + panel entry + 基础信息 */
interface PreviewablePlugin {
  id: string
  name: string
  version: string
  panelType: string
  entry: string
  installPath: string
}

/** 从已注册插件清单里挑出有面板入口的 */
function usePreviewablePlugins(): PreviewablePlugin[] {
  return useMemo(() => {
    const out: PreviewablePlugin[] = []
    for (const m of pluginRegistry.listPlugins()) {
      const entry = m.contributes.panel?.entry
      const views = m.contributes.views ?? []
      if (!entry || !m.installPath || views.length === 0) continue
      for (const v of views) {
        out.push({
          id: m.id,
          name: m.name,
          version: m.version,
          panelType: v.panelType,
          entry,
          installPath: m.installPath,
        })
      }
    }
    return out
  }, [])
}

/** iframe 内置 HTML 壳：提供 React shim + 消息处理 + 错兜底 */
const IFRAME_SRCDOC = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#fff;color:#111;font-family:system-ui,sans-serif}
  #root{height:100%}
  #__err{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;padding:12px;color:#b91c1c;background:#fef2f2;border-bottom:1px solid #fecaca}
  #__hint{padding:8px 12px;font:12px/1.5 sans-serif;color:#6b7280;background:#f9fafb}
</style></head><body>
<div id="__hint">等待主应用发送插件模块…</div>
<div id="root"></div>
<div id="__err" style="display:none"></div>
<script>
  // 宿主 React 注入点：由主应用通过 postMessage 传入
  window.__POLARIS_HOST_REACT__ = null;
  window.__POLARIS_HOST_REACT_JSX__ = null;

  let mounted = null;       // 当前挂载的卸载函数
  let currentBlobUrl = null;

  function showErr(msg){
    const el = document.getElementById('__err');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function clearErr(){ document.getElementById('__err').style.display='none'; }
  function clearHint(){ document.getElementById('__hint').remove(); }

  function loadPanel(panelCode, props){
    clearHint();
    clearErr();
    // 先卸载旧的
    try { if (mounted && mounted.unmount) mounted.unmount(); } catch(e){}
    try { if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl); } catch(e){}
    mounted = null;
    document.getElementById('root').innerHTML = '';

    // 重写 react 引用 → shim（依赖 window.__POLARIS_HOST_REACT__）
    const shimCode = 'const R=window.__POLARIS_HOST_REACT__;const J=window.__POLARIS_HOST_REACT_JSX__;'
      + 'if(!R)throw new Error("Host React not injected");'
      + 'export const useState=R.useState;export const useEffect=R.useEffect;'
      + 'export const useCallback=R.useCallback;export const useMemo=R.useMemo;'
      + 'export const useRef=R.useRef;export const memo=R.memo;'
      + 'export const createElement=R.createElement;export const Fragment=R.Fragment;'
      + 'export const Component=R.Component;export const forwardRef=R.forwardRef;'
      + 'export const useContext=R.useContext;export const useReducer=R.useReducer;'
      + 'export const useLayoutEffect=R.useLayoutEffect;'
      + 'export default R;export const jsx=J&&J.jsx;export const jsxs=J&&J.jsxs;';
    let shimUrl;
    try {
      const shimBlob = new Blob([shimCode], { type: 'application/javascript' });
      shimUrl = URL.createObjectURL(shimBlob);
    } catch(e){ showErr('shim blob 失败: '+e.message); return; }

    let patched = panelCode;
    try {
      patched = panelCode
        .replace(/from\\s*["']react["']/g, 'from "'+shimUrl+'"')
        .replace(/from\\s*["']react\\/jsx-runtime["']/g, 'from "'+shimUrl+'"')
        .replace(/require\\(\\s*["']react["']\\s*\\)/g, 'require("'+shimUrl+'")')
        .replace(/require\\(\\s*["']react\\/jsx-runtime["']\\s*\\)/g, 'require("'+shimUrl+'")');
    } catch(e){ showErr('rewrite 失败: '+e.message); return; }

    try {
      const blob = new Blob([patched], { type: 'application/javascript' });
      currentBlobUrl = URL.createObjectURL(blob);
      import(/* @vite-ignore */ currentBlobUrl).then(mod => {
        const Comp = mod.default;
        if (!Comp) { showErr('panel 模块未导出 default 组件'); return; }
        const R = window.__POLARIS_HOST_REACT__;
        const root = document.getElementById('root');
        // 用宿主 createRoot 挂载（React 18+）
        if (R.createRoot) {
          const r = R.createRoot(root);
          r.render(R.createElement(Comp, props || {}));
          mounted = { unmount: () => r.unmount() };
        } else {
          // React 17 fallback
          R.render(R.createElement(Comp, props || {}), root);
          mounted = { unmount: () => {} };
        }
      }).catch(e => {
        showErr('动态 import 失败: ' + (e && (e.stack || e.message) || String(e)));
      });
    } catch(e) {
      showErr('加载失败: ' + (e && e.message || String(e)));
    }
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'host-react') {
      window.__POLARIS_HOST_REACT__ = d.react;
      window.__POLARIS_HOST_REACT_JSX__ = d.jsxRuntime;
    } else if (d.type === 'load-panel') {
      loadPanel(d.panelCode, d.props);
    } else if (d.type === 'reload') {
      // 重新加载当前面板（主应用会再发一次 load-panel）
    }
  });
  // 通知主应用 iframe 就绪
  parent.postMessage({ type: 'preview-ready' }, '*');
</script>
</body></html>`

export function PluginPreviewPanel() {
  const plugins = usePreviewablePlugins()
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [propsText, setPropsText] = useState<string>('{}')
  const [loadKey, setLoadKey] = useState(0)
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const pendingLoadRef = useRef<{ code: string; props: unknown } | null>(null)

  const selected = useMemo(
    () => plugins.find((p) => `${p.id}::${p.panelType}` === selectedKey) ?? null,
    [plugins, selectedKey],
  )

  // 默认选第一个
  useEffect(() => {
    if (!selectedKey && plugins.length > 0) {
      setSelectedKey(`${plugins[0].id}::${plugins[0].panelType}`)
    }
  }, [plugins, selectedKey])

  const sendReactShim = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow) return
    // 注入宿主 React 实例给 iframe
    const reactMod = (window as unknown as { __POLARIS_HOST_REACT__?: unknown }).__POLARIS_HOST_REACT__
    // jsx-runtime 也从全局取（pluginModuleLoader 同款约定）
    const jsxRuntime = (window as unknown as { __POLARIS_HOST_REACT_JSX__?: unknown }).__POLARIS_HOST_REACT_JSX__
    iframe.contentWindow.postMessage(
      { type: 'host-react', react: reactMod, jsxRuntime },
      '*',
    )
  }, [])

  const sendLoadPanel = useCallback(
    async (code: string, props: unknown) => {
      const iframe = iframeRef.current
      if (!iframe || !iframe.contentWindow) return
      // 确保先注入 React
      sendReactShim()
      iframe.contentWindow.postMessage({ type: 'load-panel', panelCode: code, props }, '*')
    },
    [sendReactShim],
  )

  // iframe 就绪消息
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const d = ev.data
      if (d && typeof d === 'object' && d.type === 'preview-ready') {
        readyRef.current = true
        if (pendingLoadRef.current) {
          const p = pendingLoadRef.current
          pendingLoadRef.current = null
          sendLoadPanel(p.code, p.props).catch(() => {})
        }
      }
      // iframe 内的错误回传
      if (d && typeof d === 'object' && d.type === 'preview-error') {
        setError(d.message)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [sendLoadPanel])

  // 加载逻辑：选中的插件变化 或 loadKey 变化 → 读文件 → 注入
  useEffect(() => {
    if (!selected) {
      setError(null)
      setStatus('没有可预览的插件')
      return
    }
    let cancelled = false
    setError(null)
    setStatus(`读取 ${selected.entry}…`)

    const fullPath = `${selected.installPath.replace(/\\/g, '/')}/${selected.entry.replace(/^\.\//, '')}`
    readFile(fullPath)
      .then((code) => {
        if (cancelled) return
        setStatus(`已加载: ${selected.name} / ${selected.panelType}`)
        // 解析 props
        let props: unknown = {}
        try {
          props = propsText.trim() ? JSON.parse(propsText) : {}
        } catch {
          setError('props JSON 解析失败，已用 {} 代替')
          props = {}
        }
        const payload = { code, props }
        if (readyRef.current) {
          sendLoadPanel(code, props)
        } else {
          pendingLoadRef.current = payload
        }
      })
      .catch((e) => {
        if (cancelled) return
        setStatus('')
        setError(`读取文件失败: ${e instanceof Error ? e.message : String(e)}`)
      })
    return () => {
      cancelled = true
    }
  }, [selected, loadKey, propsText, sendLoadPanel])

  const handleReload = useCallback(() => {
    setLoadKey((k) => k + 1)
  }, [])

  const handleOpenDevtools = useCallback(() => {
    // 提示：在浏览器里右键 iframe → 检查；Tauri 里可走 devtools
    // 这里仅触发一次 reload 并打日志，便于排查
    log.info('reload triggered', { panelType: selected?.panelType ?? 'unknown' })
    handleReload()
  }, [handleReload, selected])

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 工具栏 */}
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5 shrink-0">
        <div className="relative flex-1 min-w-0">
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className="w-full appearance-none rounded-md border border-border-subtle bg-background px-2 py-1 pr-7 text-xs text-text-primary outline-none hover:border-border focus:border-accent"
          >
            {plugins.length === 0 && <option value="">无可预览插件</option>}
            {plugins.map((p) => (
              <option key={`${p.id}::${p.panelType}`} value={`${p.id}::${p.panelType}`}>
                {p.name} · {p.panelType}
              </option>
            ))}
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-muted" />
        </div>
        <button
          type="button"
          onClick={handleReload}
          title="重新加载"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-background-hover hover:text-text-primary"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          onClick={handleOpenDevtools}
          title="打开 iframe DevTools（浏览器右键检查 / Tauri devtools）"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-background-hover hover:text-text-primary"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {/* props 输入 */}
      <div className="border-b border-border px-2 py-1 shrink-0">
        <input
          value={propsText}
          onChange={(e) => setPropsText(e.target.value)}
          placeholder="props JSON（如 {} 或 {&quot;pluginId&quot;:&quot;relay-devkit&quot;}）"
          className="w-full rounded border border-border-subtle bg-background px-2 py-1 text-[11px] font-mono text-text-primary outline-none focus:border-accent"
        />
      </div>

      {/* 状态条 */}
      {(status || error) && (
        <div className={`flex items-center gap-1.5 px-2 py-1 text-[11px] shrink-0 ${error ? 'text-warning' : 'text-text-tertiary'}`}>
          {error && <AlertCircle size={11} />}
          <span className="truncate">{error || status}</span>
        </div>
      )}

      {/* iframe 沙盒 */}
      <div className="flex-1 min-h-0 bg-white">
        <iframe
          ref={iframeRef}
          srcDoc={IFRAME_SRCDOC}
          title="plugin-preview"
          sandbox="allow-scripts allow-same-origin"
          className="h-full w-full border-0"
        />
      </div>
    </div>
  )
}
