import { useEffect, useMemo, useRef, useState } from 'react'
import { connectionKey } from '@shared/connection-identity'
import { useApp } from '../../store/app'
import type { ImportApplyResult, ImportCandidate, ImportScanResult, IpcResult } from '@shared/types'

export default function ImportDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<'xterminal' | 'rdo' | null>(null)
  if (source) return <ImportPreview source={source} onClose={onClose} onBack={() => setSource(null)} />
  return <Shell title="导入连接" onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
    <p className="field-hint" style={{ margin: '0 0 16px', lineHeight: 1.8 }}>选择配置来源，先预览、核对，再导入。原文件保持不变，密码仅保存在本机保险箱。</p>
    <div style={{ display: 'grid', gap: 12 }}>
      <button className="card" style={{ padding: 18, textAlign: 'left', cursor: 'pointer' }} onClick={() => setSource('xterminal')}>
        <strong>XTerminal</strong><div className="field-hint" style={{ marginTop: 6 }}>读取本机配置库，迁移 SSH、RDP、分组及已解锁凭据。</div>
      </button>
      <button className="card" style={{ padding: 18, textAlign: 'left', cursor: 'pointer' }} onClick={() => setSource('rdo')}>
        <strong>Remote Desktop Organizer</strong><div className="field-hint" style={{ marginTop: 6 }}>选择 .rdo 文件，迁移远程桌面、目录分组、备注及身份卡关联密码。</div>
      </button>
    </div>
  </Shell>
}

function ImportPreview({ source, onClose, onBack }: { source: 'xterminal' | 'rdo'; onClose: () => void; onBack: () => void }) {
  const sourceName = source === 'rdo' ? 'Remote Desktop Organizer' : 'XTerminal'
  const title = `从 ${sourceName} 导入`
  const scanRequest = useRef<{ version: number; promise: Promise<IpcResult<ImportScanResult | null>> } | null>(null)
  const [scan, setScan] = useState<ImportScanResult | null>(null)
  const [rows, setRows] = useState<ImportCandidate[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [scanVersion, setScanVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportApplyResult | null>(null)

  const setConnections = useApp((s) => s.setConnections)

  /* ---------------- 扫描 ---------------- */
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setScan(null)
    setRows([])
    setChecked(new Set())
    if (!scanRequest.current || scanRequest.current.version !== scanVersion) {
      scanRequest.current = { version: scanVersion, promise: source === 'rdo' ? window.omnidesk.rdo.scan() : window.omnidesk.xt.scan() }
    }
    const pending = scanRequest.current.promise
    void (async () => {
      const res = await pending
      if (!active) return
      setLoading(false)
      if (!res.ok) {
        setError(res.message)
        return
      }
      if (!res.data) { onBack(); return }
      setScan(res.data)
      setRows(res.data.candidates)

      // 默认勾选规则：
      //   - 有主机地址（能导入）
      //   - 不是重复项
      //   - 地址不是推断出来的（推断的必须用户核对后手动勾）
      const preset = new Set<string>()
      for (const c of res.data.candidates) {
        if (c.host && !c.duplicate && !c.hostInferred && !c.requiresReview) preset.add(c.tempId)
      }
      setChecked(preset)
    })().catch(() => { if (active) { setLoading(false); setError('读取配置失败，请重新选择来源后重试') } })
    return () => { active = false }
  }, [scanVersion, source])

  const stats = useMemo(() => {
    const selectable = rows.filter((r) => r.host.trim())
    return {
      total: rows.length,
      selectable: selectable.length,
      needsAttention: rows.filter((r) => r.hostInferred || r.requiresReview || !r.host.trim()).length,
      selected: [...checked].length
    }
  }, [rows, checked])

  /* ---------------- 编辑单行 ---------------- */
  const patchRow = (tempId: string, patch: Partial<ImportCandidate>) => {
    setRows(previous => {
      const seen = new Set(useApp.getState().connections.map(connectionKey))
      return previous.map(row => {
        const next = row.tempId === tempId ? { ...row, ...patch } : row
        const key = connectionKey(next)
        const duplicate = !!next.host.trim() && seen.has(key)
        if (next.host.trim()) seen.add(key)
        return { ...next, duplicate }
      })
    })
  }

  const toggle = (tempId: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(tempId)) next.delete(tempId)
      else next.add(tempId)
      return next
    })
  }

  const toggleAll = (on: boolean) => {
    setChecked(on ? new Set(rows.filter((r) => r.host.trim() && (!skipDuplicates || !r.duplicate)).map((r) => r.tempId)) : new Set())
  }

  /* ---------------- 导入 ---------------- */
  const doImport = async () => {
    setError('')
    const picked = rows.filter((r) => checked.has(r.tempId) && r.host.trim())
    if (picked.length === 0) {
      setError('没有勾选任何可导入的连接')
      return
    }

    setImporting(true)
    const res = await window.omnidesk.xt.apply(scan!.scanId, picked, skipDuplicates)
    setImporting(false)
    if (!res.ok) {
      setError(res.message)
      return
    }

    const list = await window.omnidesk.connections.list()
    if (list.ok) setConnections(list.data)
    setResult(res.data)
  }

  /* ---------------- 渲染 ---------------- */

  if (loading) {
    return (
      <Shell onClose={() => { if (!importing) onClose() }} title={title}>
        <div className="empty" style={{ height: 220 }}>
          <div className="spinner" />
          <div className="empty-desc">{source === 'rdo' ? '请选择 .rdo 文件，正在读取配置…' : '正在读取 XTerminal 的配置库…'}</div>
        </div>
      </Shell>
    )
  }

  if (result) {
    return (
      <Shell
        onClose={() => { if (!importing) onClose() }}
        title="导入完成"
        footer={
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        }
      >
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>✓</div>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>
            已导入 {result.created} 条连接
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            已迁移 {result.credentials} 条密码 / 私钥，跳过 {result.skipped} 条重复连接。<br />未带凭据的连接可在编辑中选择公共凭据或补填密码。
          </div>

          {result.failed.length > 0 && (
            <div className="alert alert-warning" style={{ marginTop: 18, textAlign: 'left' }}>
              <span>⚠</span>
              <div>
                <strong>{result.failed.length} 条导入失败：</strong>
                {result.failed.slice(0, 5).map((f) => (
                  <div key={f.name} className="field-hint">
                    {f.name} —— {f.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Shell>
    )
  }

  if (!scan) {
    return (
      <Shell
        onClose={() => { if (!importing) onClose() }}
        title={title}
        footer={
          <button className="btn" onClick={onBack}>
            选择其他来源
          </button>
        }
      >
        <div className="alert alert-danger">
          <span>⚠</span>
          <div>{error || `无法读取 ${sourceName} 的配置`}</div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell
      onClose={() => { if (!importing) onClose() }}
      title={title}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onBack} disabled={importing}>切换来源</button>
          <button className="btn" onClick={onClose} disabled={importing}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={doImport}
            disabled={importing || stats.selected === 0}
          >
            {importing ? '导入中…' : `导入 ${stats.selected} 条`}
          </button>
        </>
      }
    >
      {/* 数据来源 */}
      <div className="card" style={{ marginBottom: 14, padding: 12 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 4 }}>数据来源</div>
        <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all', lineHeight: 1.5 }}>
          {scan.dbPath}
        </div>
        <div className="field-hint" style={{ marginTop: 6 }}>
          最后修改于 {new Date(scan.modifiedAt).toLocaleString()} · 只读扫描，未修改原文件
        </div>
      </div>

      <div className="import-options">
        <label className="configuration-choice"><input type="checkbox" checked={skipDuplicates} onChange={event => { setSkipDuplicates(event.target.checked); if (event.target.checked) setChecked(current => new Set([...current].filter(id => !rows.find(row => row.tempId === id)?.duplicate))) }} />只导入新的，跳过重复服务器</label>
        <button className="btn btn-sm" onClick={() => setScanVersion(value => value + 1)}>重新扫描</button>
      </div>
      <div className="field-hint" style={{ marginBottom: 12 }}>可读取的密码和私钥随连接导入保险箱；预览不显示密码。相同协议、主机、端口视为重复；不会修改已有公共凭据。</div>
      {/* 统计 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14, fontSize: 12.5 }}>
        <span>
          找到 <strong>{stats.total}</strong> 条连接
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          SSH {scan.summary.sshTotal} · RDP {scan.summary.rdpTotal}
        </span>
        {scan.summary.groups > 0 && (
          <span style={{ color: 'var(--text-secondary)' }}>分组 {scan.summary.groups} 个</span>
        )}
        <span style={{ color: 'var(--text-secondary)' }}>含凭据 {rows.filter(row => row.credentialAvailable).length} 条 · 重复 {rows.filter(row => row.duplicate).length} 条</span>
      </div>

      {/* 警告 */}
      {scan.warnings.length > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 14 }}>
          <span>⚠</span>
          <div>
            {scan.warnings.map((w) => (
              <div key={w} style={{ marginBottom: 4, lineHeight: 1.6 }}>
                {w}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* 列表 */}
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          maxHeight: 340,
          overflowY: 'auto'
        }}
      >
        <table className="table import-preview-table" style={{ margin: 0 }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 1 }}>
            <tr>
              <th style={{ width: 34 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={stats.selectable > 0 && stats.selected === stats.selectable}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </th>
              <th style={{ width: 52 }}>类型</th>
              <th>名称 / 主机</th>
              <th style={{ width: 170 }}>用户名</th>
              <th style={{ width: 130 }}>分组</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const noHost = !c.host.trim()
              const attn = c.hostInferred || c.requiresReview || noHost
              const disabled = noHost || (skipDuplicates && c.duplicate)

              return (
                <tr key={c.tempId} style={disabled ? { opacity: 0.5 } : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={checked.has(c.tempId)}
                      disabled={disabled}
                      onChange={() => toggle(c.tempId)}
                    />
                  </td>
                  <td>
                    <span className={`badge ${c.kind === 'ssh' ? 'badge-success' : 'badge-accent'}`}>
                      {c.kind.toUpperCase()}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <input
                        value={c.name}
                        onChange={(e) => patchRow(c.tempId, { name: e.target.value })}
                        style={{ height: 24, fontSize: 12, flex: '1 1 120px', minWidth: 0, maxWidth: 200 }}
                      />
                      {c.hostInferred && (
                        <span className="badge badge-warning" title="地址由标题推断，请核对">
                          推断
                        </span>
                      )}
                      <span className={`badge ${c.credentialAvailable ? 'badge-success' : 'badge-warning'}`}>{c.credentialAvailable ? '含凭据' : '无凭据'}</span>
                      {c.requiresReview && <span className="badge badge-warning" title={c.reviewReason}>待核对</span>}
                      {c.duplicate && (
                        <span className="badge" title="与现有连接重复">
                          重复
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        value={c.host}
                        onChange={(e) =>
                          patchRow(c.tempId, { host: e.target.value, hostInferred: false })
                        }
                        placeholder={noHost ? '原标题无法解析出地址，请填写' : ''}
                        className="mono"
                        style={{
                          height: 24,
                          fontSize: 11.5,
                          maxWidth: 190,
                          borderColor: attn ? 'var(--warning)' : undefined
                        }}
                        spellCheck={false}
                      />
                      <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>:</span>
                      <input
                        value={String(c.port)}
                        onChange={(e) => patchRow(c.tempId, { port: Number(e.target.value) || 0 })}
                        className="mono"
                        style={{ height: 24, fontSize: 11.5, width: 58 }}
                        spellCheck={false}
                      />
                    </div>
                  </td>
                  <td>
                    {c.credentialName && <div className="field-hint" title={`RDO 身份卡：${c.credentialName}`}>{c.credentialName}</div>}
                    <input
                      value={c.username}
                      onChange={(e) => patchRow(c.tempId, { username: e.target.value })}
                      placeholder={c.usernameMissing ? '待填写' : ''}
                      style={{
                        height: 24,
                        fontSize: 11.5,
                        borderColor: c.usernameMissing ? 'var(--warning)' : undefined
                      }}
                      spellCheck={false}
                    />
                  </td>
                  <td style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{c.group ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="field-hint" style={{ marginTop: 10, lineHeight: 1.7 }}>
        已选 <strong>{stats.selected}</strong> 条。
        {stats.needsAttention > 0 && (
          <>
            {' '}
            另有 <strong style={{ color: 'var(--warning)' }}>{stats.needsAttention}</strong>{' '}
            条地址需核对或补填（标黄项），核对后手动勾选。
          </>
        )}
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------------ */

function Shell({
  title,
  children,
  footer,
  onClose
}: {
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body" style={{ padding: '16px 18px' }}>
          {children}
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
