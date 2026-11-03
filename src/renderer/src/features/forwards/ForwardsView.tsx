import { useCallback, useEffect, useState } from 'react'
import { useApp, type Tab } from '../../store/app'
import type { ForwardKind, PortForwardRule, PortForwardStatus } from '@shared/types'
import { formatBytes } from '../files/FilesView'

/**
 * 端口转发管理
 *
 * 三种转发面向三种真实场景，界面上要说清楚区别 —— 这是最容易配错的功能：
 *   本地转发：远端内网的东西 → 搬到本机能访问
 *   远程转发：本机的东西 → 暴露给远端
 *   动态转发：本机所有程序 → 从远端出口上网（等价于只对这台机器生效的 VPN）
 */
const KIND_META: Record<
  ForwardKind,
  { label: string; short: string; desc: string; example: string }
> = {
  local: {
    label: '本地转发',
    short: '-L',
    desc: '在【本机】监听一个端口，访问它等于访问【远端可达的】目标',
    example: '例：把远端内网的 MySQL 搬到本机 → 本机 13306 → 远端 127.0.0.1:3306'
  },
  remote: {
    label: '远程转发',
    short: '-R',
    desc: '在【远端】监听一个端口，访问它等于访问【本机可达的】目标',
    example: '例：把本机开发服务暴露给远端 → 远端 8080 → 本机 127.0.0.1:3000'
  },
  dynamic: {
    label: '动态转发',
    short: '-D',
    desc: '在【本机】开一个 SOCKS5 代理，流量从【远端】出去',
    example: '例：让本机浏览器从这台服务器上网 → 浏览器设 SOCKS5 127.0.0.1:1080'
  }
}

export default function ForwardsView({ tab }: { tab: Tab }) {
  const [rules, setRules] = useState<PortForwardRule[]>([])
  const [statuses, setStatuses] = useState<Record<string, PortForwardStatus>>({})
  const [editing, setEditing] = useState<PortForwardRule | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const connections = useApp((s) => s.connections)
  const sessions = useApp((s) => s.sessions)
  const openTab = useApp((s) => s.openTab)

  const connection = connections.find((c) => c.id === tab.connectionId)
  const session = sessions.find(
    (s) => s.connectionId === tab.connectionId && s.status === 'connected'
  )

  const refresh = useCallback(async () => {
    const [list, st] = await Promise.all([
      window.omnidesk.forwards.list(),
      window.omnidesk.forwards.status()
    ])
    if (list.ok) setRules(list.data)
    if (st.ok) {
      const map: Record<string, PortForwardStatus> = {}
      for (const s of st.data) map[s.ruleId] = s
      setStatuses(map)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 状态里含流量统计，定时刷新才能看到变化
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const toggleRun = async (rule: PortForwardRule) => {
    setError('')
    setBusy(rule.id)
    const running = statuses[rule.id]?.running
    const res = running
      ? await window.omnidesk.forwards.stop(rule.id)
      : await window.omnidesk.forwards.start(rule.id)
    setBusy(null)
    if (!res.ok) {
      setError(res.message)
    }
    await refresh()
  }

  const remove = async (rule: PortForwardRule) => {
    if (!confirm(`确定删除转发规则「${describe(rule)}」？`)) return
    const res = await window.omnidesk.forwards.remove(rule.id)
    if (!res.ok) setError(res.message)
    await refresh()
  }

  if (!tab.connectionId) {
    return (
      <div className="empty">
        <div className="empty-title">请先选择一个连接</div>
        <div className="empty-desc">端口转发依附于某一条 SSH 连接。</div>
      </div>
    )
  }

  return (
    <div className="files-layout">
      <div className="toolbar">
        <span className="toolbar-title">{connection?.name} · 端口转发</span>
        <span className="toolbar-sub">{connection?.host}</span>
        <span className={`dot ${session ? 'dot-connected' : 'dot-idle'}`} />
        <span className="toolbar-spacer" />
        <button className="btn btn-sm" onClick={() => void refresh()}>
          刷新
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          新建规则
        </button>
      </div>

      <div className="pane">
        {!session && (
          <div className="alert alert-warning" style={{ marginBottom: 16 }}>
            <span>⚠</span>
            <div>
              该主机尚未建立 SSH 会话。转发依赖 SSH 隧道，请
              <button
                className="btn btn-sm"
                style={{ margin: '0 6px' }}
                onClick={() =>
                  connection &&
                  openTab({
                    kind: 'ssh',
                    title: connection.name,
                    connectionId: connection.id,
                    status: 'idle'
                  })
                }
              >
                打开终端
              </button>
              先连上再启动转发。
            </div>
          </div>
        )}

        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            <span>⚠</span>
            <div>{error}</div>
          </div>
        )}

        {rules.length === 0 ? (
          <div className="empty" style={{ height: 260 }}>
            <div className="empty-title">还没有转发规则</div>
            <div className="empty-desc">
              端口转发能让远端内网的服务在本机直接访问，
              或让本机流量从远端出去。点右上角「新建规则」开始。
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 46 }}>状态</th>
                  <th style={{ width: 96 }}>类型</th>
                  <th>监听</th>
                  <th>目标</th>
                  <th style={{ width: 130, textAlign: 'right' }}>流量</th>
                  <th style={{ width: 130 }} />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const st = statuses[rule.id]
                  const running = st?.running ?? false
                  const port = st?.actualPort ?? rule.listenPort
                  return (
                    <tr key={rule.id}>
                      <td>
                        <span className={`dot ${running ? 'dot-connected' : 'dot-idle'}`} />
                      </td>
                      <td>
                        <span className={`badge ${running ? 'badge-accent' : ''}`}>
                          {KIND_META[rule.kind].short} {KIND_META[rule.kind].label}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {rule.listenHost || '127.0.0.1'}:{port}
                        {running && st?.actualPort && st.actualPort !== rule.listenPort && (
                          <span style={{ color: 'var(--text-tertiary)' }}>（系统分配）</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                        {rule.kind === 'dynamic' ? '由客户端决定' : `${rule.targetHost}:${rule.targetPort}`}
                      </td>
                      <td className="mono" style={{ fontSize: 11, textAlign: 'right' }}>
                        {running ? (
                          <>
                            ↑{formatBytes(st?.bytesOut ?? 0)} ↓{formatBytes(st?.bytesIn ?? 0)}
                            <div style={{ color: 'var(--text-tertiary)' }}>{st?.connections ?? 0} 连接</div>
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-sm"
                            onClick={() => toggleRun(rule)}
                            disabled={busy === rule.id || (!running && !session)}
                          >
                            {busy === rule.id ? '…' : running ? '停止' : '启动'}
                          </button>
                          <button className="btn btn-sm" onClick={() => setEditing(rule)}>
                            编辑
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => remove(rule)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="alert alert-info" style={{ marginTop: 16 }}>
          <span>ℹ</span>
          <div>
            三种转发的区别：
            <div style={{ marginTop: 6, lineHeight: 1.8 }}>
              <strong>本地转发</strong> —— {KIND_META.local.desc}
              <div className="field-hint">{KIND_META.local.example}</div>
              <strong>远程转发</strong> —— {KIND_META.remote.desc}
              <div className="field-hint">{KIND_META.remote.example}</div>
              <strong>动态转发</strong> —— {KIND_META.dynamic.desc}
              <div className="field-hint">{KIND_META.dynamic.example}</div>
            </div>
          </div>
        </div>
      </div>

      {(creating || editing) && (
        <RuleEditor
          connectionId={tab.connectionId}
          rule={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onSaved={async () => {
            setCreating(false)
            setEditing(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function describe(rule: PortForwardRule): string {
  const listen = `${rule.listenHost || '127.0.0.1'}:${rule.listenPort}`
  if (rule.kind === 'dynamic') return `${listen} → SOCKS5`
  return `${listen} → ${rule.targetHost}:${rule.targetPort}`
}

function RuleEditor({
  connectionId,
  rule,
  onClose,
  onSaved
}: {
  connectionId: string
  rule: PortForwardRule | null
  onClose: () => void
  onSaved: () => void
}) {
  const [kind, setKind] = useState<ForwardKind>(rule?.kind ?? 'local')
  const [listenHost, setListenHost] = useState(rule?.listenHost ?? '127.0.0.1')
  const [listenPort, setListenPort] = useState(String(rule?.listenPort ?? 13306))
  const [targetHost, setTargetHost] = useState(rule?.targetHost ?? '127.0.0.1')
  const [targetPort, setTargetPort] = useState(String(rule?.targetPort ?? 3306))
  const [label, setLabel] = useState(rule?.label ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // 切换类型时给一组合理的默认值
  useEffect(() => {
    if (rule) return
    if (kind === 'dynamic') setListenPort('1080')
    else if (kind === 'local') setListenPort('13306')
    else setListenPort('8080')
  }, [kind, rule])

  const save = async () => {
    setError('')
    const lp = Number(listenPort)
    if (!Number.isInteger(lp) || lp < 0 || lp > 65535) return setError('监听端口需为 0 - 65535')

    const payload: PortForwardRule = {
      id: rule?.id ?? '',
      connectionId,
      kind,
      listenHost: listenHost.trim() || '127.0.0.1',
      listenPort: lp,
      label: label.trim() || undefined,
      enabled: true,
      ...(kind !== 'dynamic'
        ? {
            targetHost: targetHost.trim(),
            targetPort: Number(targetPort)
          }
        : {})
    }

    setSaving(true)
    const res = await window.omnidesk.forwards.save(payload)
    setSaving(false)
    if (!res.ok) return setError(res.message)
    onSaved()
  }

  const meta = KIND_META[kind]
  const wildcard = listenHost.trim() === '0.0.0.0' || listenHost.trim() === '::'

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{rule ? '编辑转发规则' : '新建转发规则'}</h2>
        </div>

        <div className="modal-body">
          <div className="field">
            <span className="field-label">转发类型</span>
            <div className="segmented">
              {(['local', 'remote', 'dynamic'] as ForwardKind[]).map((k) => (
                <button key={k} data-active={kind === k} onClick={() => setKind(k)}>
                  {KIND_META[k].label}
                </button>
              ))}
            </div>
            <span className="field-hint">{meta.desc}</span>
            <span className="field-hint" style={{ color: 'var(--text-tertiary)' }}>
              {meta.example}
            </span>
          </div>

          <div className="field-row">
            <div className="field">
              <span className="field-label">监听地址</span>
              <input
                value={listenHost}
                onChange={(e) => setListenHost(e.target.value)}
                placeholder="127.0.0.1"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <span className="field-label">监听端口</span>
              <input
                value={listenPort}
                onChange={(e) => setListenPort(e.target.value)}
                placeholder={kind === 'dynamic' ? '1080' : '13306'}
                spellCheck={false}
              />
            </div>
          </div>

          <span className="field-hint" style={{ marginTop: -8, marginBottom: 12, display: 'block' }}>
            端口填 0 表示由系统自动分配一个空闲端口。
          </span>

          {wildcard && (
            <div className="alert alert-warning" style={{ marginBottom: 14 }}>
              <span>⚠</span>
              <div>
                <strong>监听 0.0.0.0 会让同网段的其他机器也能访问这个端口。</strong>
                如果你只是自己用，请改回 127.0.0.1。转发到生产数据库这类场景尤其要注意。
              </div>
            </div>
          )}

          {kind !== 'dynamic' && (
            <>
              <div className="field-row">
                <div className="field">
                  <span className="field-label">
                    {kind === 'local' ? '目标地址（从远端看）' : '目标地址（从本机看）'}
                  </span>
                  <input
                    value={targetHost}
                    onChange={(e) => setTargetHost(e.target.value)}
                    placeholder="127.0.0.1"
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <span className="field-label">目标端口</span>
                  <input
                    value={targetPort}
                    onChange={(e) => setTargetPort(e.target.value)}
                    placeholder="3306"
                    spellCheck={false}
                  />
                </div>
              </div>
              <span className="field-hint" style={{ marginTop: -8, marginBottom: 12, display: 'block' }}>
                {kind === 'local'
                  ? '远端能访问到就行，所以常用 127.0.0.1（指远端本机）。'
                  : '本机能访问到就行，所以常用 127.0.0.1（指你本机）。'}
              </span>
            </>
          )}

          <div className="field">
            <span className="field-label">备注（可选）</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="这个转发是干什么用的"
            />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
