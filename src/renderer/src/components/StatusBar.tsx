import { useApp } from '../store/app'

export default function StatusBar() {
  const connections = useApp((s) => s.connections)
  const sessions = useApp((s) => s.sessions)
  const tabs = useApp((s) => s.tabs)
  const externalConfig = useApp((s) => s.externalConfig)
  const openTab = useApp((s) => s.openTab)

  const connected = sessions.filter((s) => s.status === 'connected').length + tabs.filter((tab) => tab.kind === 'rdp' && tab.status === 'connected').length
  const mcpOn = externalConfig?.mcp.enabled ?? false
  const apiOn = externalConfig?.api.enabled ?? false

  return (
    <div className="statusbar">
      <span className="statusbar-item">
        <span className={`dot ${connected ? 'dot-connected' : 'dot-idle'}`} />
        {connected} 个活跃会话
      </span>
      <span className="statusbar-item">{connections.length} 个主机</span>

      <span className="statusbar-spacer" />

      <button
        className="statusbar-item"
        onClick={() =>
          openTab({ kind: 'external', title: '开放能力', status: 'idle', id: 'tab-external' })
        }
        title="开放能力设置"
      >
        <span className={`dot ${mcpOn ? 'dot-connected' : 'dot-idle'}`} />
        MCP {mcpOn ? `:${externalConfig?.mcp.port}` : '关闭'}
      </button>

      <button
        className="statusbar-item"
        onClick={() =>
          openTab({ kind: 'external', title: '开放能力', status: 'idle', id: 'tab-external' })
        }
        title="开放能力设置"
      >
        <span className={`dot ${apiOn ? 'dot-connected' : 'dot-idle'}`} />
        API {apiOn ? `:${externalConfig?.api.port}` : '关闭'}
      </button>
    </div>
  )
}
