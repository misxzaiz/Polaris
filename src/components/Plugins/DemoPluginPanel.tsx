import { useMemo, useState } from 'react'
import { Bot, Clipboard, RotateCcw, Send } from 'lucide-react'
import { pluginRegistry } from '@/plugin-system'
import { usePluginStore } from '@/stores/pluginStore'

interface DemoPluginPanelProps {
  onSendToChat?: (message: string) => void | Promise<void>
}

const DEMO_PLUGIN_ID = 'example.demo-mcp'
const DEMO_SERVER_ID = 'example-demo-mcp'

export function DemoPluginPanel({ onSendToChat }: DemoPluginPanelProps) {
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const [input, setInput] = useState('hello demo plugin')
  const [echoText, setEchoText] = useState('hello demo plugin')
  const [sendState, setSendState] = useState<'idle' | 'sent'>('idle')

  const plugin = useMemo(
    () => pluginRegistry.listPlugins().find((item) => item.id === DEMO_PLUGIN_ID),
    []
  )
  const state = pluginStates[DEMO_PLUGIN_ID]
  const mcpServer = plugin?.contributes.mcpServers?.find((server) => server.id === DEMO_SERVER_ID)
  const testPrompt = `请调用 ${DEMO_SERVER_ID} 的 demo_workspace 工具，并告诉我它返回的 workspacePath。`

  const handleEcho = () => {
    setEchoText(input.trim() || '(empty)')
  }

  const handleSendPrompt = async () => {
    if (!onSendToChat) return
    await onSendToChat(testPrompt)
    setSendState('sent')
    window.setTimeout(() => setSendState('idle'), 1400)
  }

  return (
    <div className="flex h-full flex-col bg-background-elevated text-text-primary">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Bot size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Demo MCP</h2>
            <div className="truncate text-xs text-text-tertiary">{DEMO_PLUGIN_ID}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Runtime
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary">Plugin</span>
                <span className={plugin ? 'text-green-400' : 'text-yellow-400'}>
                  {plugin ? 'Installed' : 'Not discovered'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary">UI</span>
                <span>{state?.uiEnabled === false ? 'Disabled' : 'Enabled'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary">MCP</span>
                <span>{state?.mcpEnabled === false ? 'Disabled' : 'Enabled'}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary">Server</span>
                <span className="truncate font-mono">{mcpServer?.id ?? DEMO_SERVER_ID}</span>
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Echo
            </h3>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="h-24 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              spellCheck={false}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleEcho}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover"
              >
                <RotateCcw size={14} />
                Echo
              </button>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(echoText)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-text-secondary hover:bg-background-hover hover:text-text-primary"
              >
                <Clipboard size={14} />
                Copy
              </button>
            </div>
            <div className="mt-3 rounded-md bg-background px-3 py-2 text-sm text-text-secondary">
              {echoText}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              MCP Test
            </h3>
            <div className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-text-secondary">
              {testPrompt}
            </div>
            <button
              type="button"
              onClick={handleSendPrompt}
              disabled={!onSendToChat}
              className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={14} />
              {sendState === 'sent' ? 'Sent' : 'Send to chat'}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
