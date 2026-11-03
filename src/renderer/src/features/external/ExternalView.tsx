import { useEffect, useState } from 'react'
import { useApp } from '../../store/app'
import type { AccessToken, ExternalScope } from '@shared/types'

/**
 * 开放能力配置
 *
 * 这个页面是「把能力交给外部」的总闸门。
 * 设计上刻意让每一步都需要用户主动操作 —— 默认全关，
 * 连接默认不暴露，写操作默认要审批。
 */

const SCOPE_LABELS: Record<ExternalScope, { label: string; desc: string }> = {
  'ssh:read': { label: '读取主机列表', desc: '查看有哪些被授权的主机' },
  'ssh:exec': { label: '执行命令', desc: '在主机上运行 shell 命令' },
  'sftp:read': { label: '读取文件', desc: '浏览目录、读取文本文件' },
  'sftp:write': { label: '写入文件', desc: '修改远端文件内容' },
  'metrics:read': { label: '读取指标', desc: '获取 CPU/内存/磁盘等运行数据' }
}

export default function ExternalView() {
  const config = useApp((s) => s.externalConfig)
  const setConfig = useApp((s) => s.setExternalConfig)
  const connections = useApp((s) => s.connections)
  const setConnections = useApp((s) => s.setConnections)
  const [tab, setTab] = useState<'mcp' | 'api'>('mcp')
  const [busy, setBusy] = useState(false)
  const [newToken, setNewToken] = useState<{ plaintext: string; label: string } | null>(null)
  const [showTokenForm, setShowTokenForm] = useState(false)

  useEffect(() => {
    void window.omnidesk.external.config().then((r) => {
      if (r.ok) setConfig(r.data)
    })
  }, [setConfig])

  if (!config) return <div className="pane">加载中…</div>

  const section = config[tab]

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    const res = await window.omnidesk.external.setEnabled(tab, enabled)
    setBusy(false)
    if (res.ok) setConfig(res.data)
  }

  const revoke = async (tokenId: string) => {
    if (!confirm('确定吊销该令牌？使用它的客户端将立即失去访问权限。')) return
    const res = await window.omnidesk.external.revokeToken(tab, tokenId)
    if (res.ok) setConfig(res.data)
  }

  const toggleExpose = async (connectionId: string, exposed: boolean) => {
    const conn = connections.find((c) => c.id === connectionId)
    if (!conn) return
    const res = await window.omnidesk.connections.save({
      ...conn,
      exposedToExternal: exposed
    } as never)
    if (res.ok) {
      const list = await window.omnidesk.connections.list()
      if (list.ok) setConnections(list.data)
    }
  }

  const sshConnections = connections.filter((c) => c.kind === 'ssh')

  return (
    <div className="pane">
      <div className="pane-narrow">
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 6px' }}>开放能力</h1>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 22px', lineHeight: 1.6 }}>
          把 OmniDesk 的服务器操作能力开放给 AI 客户端和其他系统。
          默认全部关闭 —— 只有你主动打开的开关才会生效。
        </p>

        <div className="segmented" style={{ marginBottom: 18 }}>
          <button data-active={tab === 'mcp'} onClick={() => setTab('mcp')}>
            MCP · 给 AI 用
          </button>
          <button data-active={tab === 'api'} onClick={() => setTab('api')}>
            HTTP API · 给程序用
          </button>
        </div>

        {/* 开关 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="card-title">
                {tab === 'mcp' ? 'MCP 服务' : 'HTTP API 服务'}
              </div>
              <div className="card-desc" style={{ marginBottom: 0 }}>
                {tab === 'mcp'
                  ? '启动后，AI 客户端（如 Claude Code、Cursor）可以连接到本机，通过工具调用操作你的服务器。'
                  : '启动后，其他程序可以通过 REST 接口读取服务器数据、执行命令。'}
                <br />
                监听地址：
                <span className="mono">
                  http://{section.host}:{section.port}
                  {tab === 'mcp' ? '/mcp' : '/api/v1'}
                </span>
                （仅本机可访问）
              </div>
            </div>
            <button
              className="switch"
              data-on={section.enabled}
              onClick={() => toggle(!section.enabled)}
              disabled={busy}
              aria-label="启用服务"
            />
          </div>
        </div>

        {/* 令牌 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ flex: 1 }}>
              <div className="card-title">访问令牌</div>
              <div className="card-desc">
                每个客户端用独立令牌。令牌只在创建时显示一次，之后无法再查看 —— 请当场复制保存。
              </div>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setShowTokenForm(true)}
              disabled={!section.enabled}
            >
              新建令牌
            </button>
          </div>

          {section.tokens.length === 0 ? (
            <div
              style={{
                padding: '18px 0',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 12.5
              }}
            >
              还没有令牌。{!section.enabled && '请先启用服务。'}
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>标签</th>
                  <th>权限</th>
                  <th>最近使用</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {section.tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.label}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {t.scopes.map((s) => (
                          <span key={s} className="badge">
                            {s}
                          </span>
                        ))}
                        {t.allowWriteWithoutApproval && (
                          <span className="badge badge-warning">免审批</span>
                        )}
                      </div>
                    </td>
                    <td style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '从未使用'}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-danger" onClick={() => revoke(t.id)}>
                        吊销
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 主机授权 */}
        {tab === 'api' || tab === 'mcp' ? (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">授权给外部的主机</div>
            <div className="card-desc">
              只有下面打开开关的主机才会对外可见。未授权的主机，外部调用会直接拒绝。
            </div>

            {sshConnections.length === 0 ? (
              <div style={{ padding: '16px 0', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
                还没有 SSH 连接。
              </div>
            ) : (
              sshConnections.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '9px 0',
                    borderTop: '1px solid var(--border)'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5 }}>{c.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {c.host}:{c.port}
                    </div>
                  </div>
                  <button
                    className="switch"
                    data-on={c.exposedToExternal === true}
                    onClick={() => toggleExpose(c.id, !c.exposedToExternal)}
                    aria-label={`授权 ${c.name}`}
                  />
                </div>
              ))
            )}
          </div>
        ) : null}

        {/* 使用说明 */}
        <div className="card">
          <div className="card-title">如何接入</div>
          {tab === 'mcp' ? (
            <pre
              className="mono"
              style={{
                background: 'var(--bg)',
                padding: 12,
                borderRadius: 8,
                fontSize: 11.5,
                lineHeight: 1.7,
                overflowX: 'auto',
                margin: '10px 0 0',
                color: 'var(--text-secondary)'
              }}
            >{`# 在 AI 客户端的 MCP 配置中加入：
{
  "mcpServers": {
    "omnidesk": {
      "url": "http://127.0.0.1:${section.port}/mcp",
      "headers": {
        "Authorization": "Bearer 你的令牌"
      }
    }
  }
}`}</pre>
          ) : (
            <pre
              className="mono"
              style={{
                background: 'var(--bg)',
                padding: 12,
                borderRadius: 8,
                fontSize: 11.5,
                lineHeight: 1.7,
                overflowX: 'auto',
                margin: '10px 0 0',
                color: 'var(--text-secondary)'
              }}
            >{`# 列出已授权主机
curl -H "Authorization: Bearer 你的令牌" \\
  http://127.0.0.1:${section.port}/api/v1/hosts

# 取指标
curl -H "Authorization: Bearer 你的令牌" \\
  http://127.0.0.1:${section.port}/api/v1/hosts/<id>/metrics

# 实时指标流（SSE）
curl -N -H "Authorization: Bearer 你的令牌" \\
  http://127.0.0.1:${section.port}/api/v1/hosts/<id>/metrics/stream`}</pre>
          )}
        </div>
      </div>

      {showTokenForm && (
        <TokenForm
          onClose={() => setShowTokenForm(false)}
          onCreate={async (label, scopes, skipApproval) => {
            const res = await window.omnidesk.external.createToken(tab, label, scopes, skipApproval)
            if (!res.ok) {
              alert(res.message)
              return
            }
            setNewToken({ plaintext: res.data.plaintext, label })
            const cfg = await window.omnidesk.external.config()
            if (cfg.ok) setConfig(cfg.data)
            setShowTokenForm(false)
          }}
        />
      )}

      {newToken && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">令牌已创建</h2>
            </div>
            <div className="modal-body">
              <div className="alert alert-warning" style={{ marginBottom: 14 }}>
                <span>⚠</span>
                <div>
                  <strong>这是唯一一次显示该令牌。</strong>
                  关闭后无法再次查看，只能吊销后重建。
                </div>
              </div>

              <div className="field">
                <span className="field-label">标签</span>
                <div>{newToken.label}</div>
              </div>

              <div className="field">
                <span className="field-label">令牌</span>
                <div
                  className="mono"
                  style={{
                    background: 'var(--bg)',
                    padding: 10,
                    borderRadius: 8,
                    wordBreak: 'break-all',
                    fontSize: 11.5,
                    lineHeight: 1.6
                  }}
                >
                  {newToken.plaintext}
                </div>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 8, alignSelf: 'flex-start' }}
                  onClick={() => void navigator.clipboard.writeText(newToken.plaintext)}
                >
                  复制到剪贴板
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setNewToken(null)}>
                我已保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TokenForm({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (label: string, scopes: ExternalScope[], skipApproval: boolean) => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<Set<ExternalScope>>(
    new Set<ExternalScope>(['ssh:read', 'metrics:read'])
  )
  const [skipApproval, setSkipApproval] = useState(false)

  const toggleScope = (s: ExternalScope) => {
    setScopes((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">新建访问令牌</h2>
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">标签</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：Claude Code · 我的笔记本"
              autoFocus
            />
          </div>

          <div className="field">
            <span className="field-label">权限范围</span>
            {(Object.keys(SCOPE_LABELS) as ExternalScope[]).map((s) => (
              <label
                key={s}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 0',
                  borderTop: '1px solid var(--border)',
                  cursor: 'pointer'
                }}
              >
                <input
                  type="checkbox"
                  checked={scopes.has(s)}
                  onChange={() => toggleScope(s)}
                  style={{ width: 'auto', marginTop: 3 }}
                />
                <div>
                  <div style={{ fontSize: 12.5 }}>{SCOPE_LABELS[s].label}</div>
                  <div className="field-hint">
                    {SCOPE_LABELS[s].desc} · <span className="mono">{s}</span>
                  </div>
                </div>
              </label>
            ))}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              paddingTop: 12,
              borderTop: '1px solid var(--border)'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>写操作免审批</div>
              <div className="field-hint">
                开启后，该令牌发起的执行命令、写文件等操作将不再弹窗确认。
                只在完全可信的客户端上开启。
              </div>
            </div>
            <button
              className="switch"
              data-on={skipApproval}
              onClick={() => setSkipApproval((v) => !v)}
              aria-label="免审批"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={!label.trim() || scopes.size === 0}
            onClick={() => void onCreate(label, [...scopes], skipApproval)}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
