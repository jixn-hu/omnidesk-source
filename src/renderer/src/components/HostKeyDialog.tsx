import { useApp } from '../store/app'

/**
 * 主机密钥确认（TOFU：Trust On First Use）
 *
 * 首次连接某主机时展示指纹让用户确认；
 * 如果指纹与之前记录的不一致，用醒目警告提示可能的中间人攻击。
 */
export default function HostKeyDialog() {
  const current = useApp((s) => s.hostKeyRequest)
  const queue = useApp((s) => s.hostKeyQueue)
  const sessions = useApp((s) => s.sessions)
  const assistantActive = useApp((s) => s.tabs.find(tab => tab.id === s.activeTabId)?.kind === 'ai')
  const req = [current, ...queue].find(request => request && !(assistantActive && sessions.some(session => session.id === request.sessionId && session.ownerId?.startsWith('ai-'))))
  const removeRequest = useApp((s) => s.removeHostKeyRequest)
  if (!req) return null

  const decide = async (accept: boolean, remember: boolean) => {
    await window.omnidesk.ssh.resolveHostKey(req.sessionId, { accept, remember })
    removeRequest(req.sessionId)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{req.changed ? '主机密钥已变更' : '确认主机密钥'}</h2>
        </div>

        <div className="modal-body">
          {req.changed ? (
            <div className="alert alert-danger" style={{ marginBottom: 14 }}>
              <span>⚠</span>
              <div>
                <strong>该主机的密钥与上次记录不一致。</strong>
                这可能意味着服务器被重装，也可能意味着有人在中间截获连接。
                请先通过其他可信渠道核实，再决定是否继续。
              </div>
            </div>
          ) : (
            <div className="alert alert-info" style={{ marginBottom: 14 }}>
              <span>ℹ</span>
              <div>这是第一次连接该主机。请核对下方指纹与服务器实际指纹是否一致。</div>
            </div>
          )}

          <div className="field">
            <span className="field-label">主机</span>
            <div className="mono">
              {req.host}:{req.port}
            </div>
          </div>

          <div className="field">
            <span className="field-label">密钥类型</span>
            <div className="mono">{req.keyType}</div>
          </div>

          <div className="field">
            <span className="field-label">指纹（SHA256）</span>
            <div className="mono" style={{ wordBreak: 'break-all', lineHeight: 1.6 }}>
              {req.fingerprint}
            </div>
          </div>

          {req.changed && req.previousFingerprint && (
            <div className="field">
              <span className="field-label">上次记录的指纹</span>
              <div className="mono" style={{ wordBreak: 'break-all', opacity: 0.6, lineHeight: 1.6 }}>
                {req.previousFingerprint}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={() => decide(false, false)}>
            取消连接
          </button>
          {!req.changed && (
            <button className="btn" onClick={() => decide(true, false)}>
              仅本次信任
            </button>
          )}
          <button className="btn btn-primary" onClick={() => decide(true, true)}>
            {req.changed ? '确认变更并继续' : '信任并记住'}
          </button>
        </div>
      </div>
    </div>
  )
}
