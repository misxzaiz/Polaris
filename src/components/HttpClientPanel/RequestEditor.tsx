/**
 * 请求编辑器
 *
 * 方法/URL + 环境选择 + cURL 导入 + Headers/Query/Body 标签 + 发送。
 * 直接读写 store 中 active tab 的 spec。
 */

import { useCallback, useMemo, useState } from 'react'
import { Send, Loader2, Plus, Trash2, TerminalSquare, Save, AlertTriangle } from 'lucide-react'
import { useHttpClientStore } from '@/stores/httpClientStore'
import { METHODS, BODY_TYPES, type BodyType, type KeyValue, type RequestTab } from './httpClientTypes'
import { parseCurl } from './curlImporter'

type EditorTab = 'headers' | 'query' | 'body'

function KvEditor({
  rows,
  onChange,
}: {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
}) {
  const update = (idx: number, key: 'name' | 'value', value: string) => {
    const next = [...rows]
    next[idx] = { ...next[idx], [key]: value }
    onChange(next)
  }
  return (
    <div className="space-y-1">
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            type="text"
            value={row.name}
            onChange={(e) => update(idx, 'name', e.target.value)}
            placeholder="name"
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => update(idx, 'value', e.target.value)}
            placeholder="value"
            className="flex-1 min-w-0 px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
          />
          <button
            onClick={() => onChange(rows.filter((_, i) => i !== idx))}
            className="p-1 rounded hover:bg-background-elevated text-text-tertiary hover:text-red-400 transition-colors"
            title="删除"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...rows, { name: '', value: '' }])}
        className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <Plus className="w-3 h-3" /> 添加
      </button>
    </div>
  )
}

export function RequestEditor({ tab }: { tab: RequestTab }) {
  const updateTabSpec = useHttpClientStore((s) => s.updateTabSpec)
  const sendActiveRequest = useHttpClientStore((s) => s.sendActiveRequest)
  const environments = useHttpClientStore((s) => s.environments)
  const activeEnvId = useHttpClientStore((s) => s.activeEnvId)
  const setActiveEnv = useHttpClientStore((s) => s.setActiveEnv)
  const missingVars = useHttpClientStore((s) => s.missingVars)
  const saveActiveOverExisting = useHttpClientStore((s) => s.saveActiveOverExisting)

  const [editorTab, setEditorTab] = useState<EditorTab>('headers')
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlWarnings, setCurlWarnings] = useState<string[]>([])

  const spec = tab.spec

  const patch = useCallback(
    (p: Partial<typeof spec>) => updateTabSpec(tab.id, p),
    [tab.id, updateTabSpec, spec],
  )

  const envOptions = useMemo(() => environments, [environments])

  const importCurl = useCallback(() => {
    const text = curlText.trim()
    if (!text) {
      setCurlWarnings(['请粘贴 curl 命令'])
      return
    }
    const { spec: parsed, warnings } = parseCurl(text)
    if (!parsed.url) {
      setCurlWarnings([...warnings, '解析失败：未识别到 URL'])
      return
    }
    updateTabSpec(tab.id, parsed)
    setCurlWarnings(warnings)
    setCurlOpen(false)
    setEditorTab(parsed.bodyType && parsed.bodyType !== 'none' ? 'body' : 'headers')
  }, [curlText, tab.id, updateTabSpec])

  const activeKvCount = {
    headers: spec.headers.filter((h: KeyValue) => h.name.trim()).length,
    query: spec.query.filter((q: KeyValue) => q.name.trim()).length,
  }

  return (
    <div className="flex flex-col border-b border-border">
      {/* 方法 + URL + 环境选择 + 发送 */}
      <div className="flex items-center gap-1.5 p-2">
        <select
          value={spec.method}
          onChange={(e) => patch({ method: e.target.value })}
          className="px-2 py-1.5 text-xs bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-primary/50 shrink-0"
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={spec.url}
          onChange={(e) => patch({ url: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendActiveRequest()
          }}
          placeholder="https://{{baseUrl}}/api/resource"
          className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50"
        />
        <select
          value={activeEnvId ?? ''}
          onChange={(e) => setActiveEnv(e.target.value || null)}
          className="px-2 py-1.5 text-xs bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-primary/50 shrink-0 max-w-[100px]"
          title="环境变量"
        >
          <option value="">无环境</option>
          {envOptions.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
        <button
          onClick={sendActiveRequest}
          disabled={tab.loading}
          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 shrink-0"
        >
          {tab.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          发送
        </button>
      </div>

      {/* 工具栏：cURL 导入 / 保存 / 缺失变量提示 */}
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button
          onClick={() => setCurlOpen((v) => !v)}
          className={`flex items-center gap-1 px-1.5 py-1 text-[10px] rounded transition-colors ${
            curlOpen ? 'bg-background-elevated text-text-primary' : 'text-text-tertiary hover:text-text-primary hover:bg-background-elevated'
          }`}
          title="导入 cURL"
        >
          <TerminalSquare className="w-3 h-3" /> cURL
        </button>
        {tab.savedId && (
          <button
            onClick={() => saveActiveOverExisting()}
            disabled={!tab.dirty}
            className="flex items-center gap-1 px-1.5 py-1 text-[10px] rounded text-text-tertiary hover:text-text-primary hover:bg-background-elevated disabled:opacity-40 transition-colors"
            title="保存覆盖已存在请求"
          >
            <Save className="w-3 h-3" /> 保存 {tab.dirty && '•'}
          </button>
        )}
        {missingVars.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-yellow-400" title="发送时未解析的变量">
            <AlertTriangle className="w-3 h-3" /> 缺失变量: {missingVars.join(', ')}
          </span>
        )}
      </div>

      {/* cURL 导入区 */}
      {curlOpen && (
        <div className="px-2 pb-2 space-y-1.5">
          <textarea
            value={curlText}
            onChange={(e) => setCurlText(e.target.value)}
            placeholder={`curl -X POST https://api.example.com/users \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"test"}'`}
            className="w-full h-20 px-2 py-1.5 text-xs font-mono bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50 resize-y"
          />
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              {curlWarnings.map((w, i) => (
                <span key={i} className="text-[10px] text-yellow-400">
                  {w}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={importCurl} className="px-2 py-1 text-[10px] font-medium bg-primary text-white rounded hover:bg-primary/90">
                导入
              </button>
              <button
                onClick={() => {
                  setCurlOpen(false)
                  setCurlWarnings([])
                }}
                className="px-2 py-1 text-[10px] text-text-tertiary hover:text-text-primary"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 编辑标签 */}
      <div className="flex items-center gap-3 px-2 border-b border-border">
        {(['headers', 'query', 'body'] as EditorTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setEditorTab(t)}
            className={`px-1 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
              editorTab === t ? 'text-text-primary border-primary' : 'text-text-tertiary border-transparent hover:text-text-secondary'
            }`}
          >
            {t === 'headers'
              ? `Headers${activeKvCount.headers ? ` (${activeKvCount.headers})` : ''}`
              : t === 'query'
                ? `Query${activeKvCount.query ? ` (${activeKvCount.query})` : ''}`
                : 'Body'}
          </button>
        ))}
      </div>

      <div className="p-2">
        {editorTab === 'headers' && <KvEditor rows={spec.headers} onChange={(r) => patch({ headers: r })} />}
        {editorTab === 'query' && <KvEditor rows={spec.query} onChange={(r) => patch({ query: r })} />}
        {editorTab === 'body' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-tertiary">类型</span>
              <select
                value={spec.bodyType ?? 'none'}
                onChange={(e) => patch({ bodyType: e.target.value as BodyType })}
                className="px-2 py-1 text-xs bg-background-elevated border border-border rounded text-text-primary focus:outline-none focus:border-primary/50"
              >
                {BODY_TYPES.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              value={spec.body ?? ''}
              onChange={(e) => patch({ body: e.target.value })}
              disabled={spec.bodyType === 'none'}
              placeholder={spec.bodyType === 'json' ? '{ "key": "value" }' : '请求体内容'}
              className="w-full h-32 px-2 py-1.5 text-xs font-mono bg-background-elevated border border-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50 disabled:opacity-50 resize-y"
            />
          </div>
        )}
      </div>
    </div>
  )
}
