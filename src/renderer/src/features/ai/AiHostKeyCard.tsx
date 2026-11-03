import { useState } from 'react'
import type { HostKeyRequest } from '../../store/app'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'

export default function AiHostKeyCard({ request }: { request: HostKeyRequest }) {
  const removeRequest = useApp(state => state.removeHostKeyRequest)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const decide = async (accept: boolean, remember: boolean) => {
    if (working) return
    setWorking(true); setError('')
    try {
      const result = accept ? await window.omnidesk.ssh.resolveHostKey(request.sessionId, { accept, remember }) : await window.omnidesk.ai.cancel()
      if (result.ok) removeRequest(request.sessionId)
      else setError(result.message)
    } catch { setError('提交失败，请重试。') }
    finally { setWorking(false) }
  }
  return <section className={`ai-confirmation ai-host-key ${request.changed ? 'is-changed' : ''}`} data-state="pending" aria-label="SSH 身份确认">
    <div className="ai-confirmation-heading"><span className="ai-confirmation-icon"><Icon name="shield" size={16} /></span><h3>{request.changed ? '主机密钥已变更' : '确认主机密钥'}</h3><span className="ai-confirmation-state">核对服务器身份</span></div>
    <div className="ai-confirmation-body"><p className="ai-confirmation-reason">{request.changed ? '服务器密钥与上次记录不一致，可能是服务器重装，也可能存在连接被截获的风险。请先通过可信渠道核实后再继续。' : '首次连接这台服务器，请核对指纹后选择信任方式。'}</p><p className="ai-confirmation-target"><strong>{request.host}:{request.port}</strong><code>{request.keyType}</code></p><div className="ai-host-fingerprint"><span>SHA256 指纹</span><code>{request.fingerprint}</code></div>{request.changed && request.previousFingerprint && <div className="ai-host-fingerprint"><span>上次记录</span><code>{request.previousFingerprint}</code></div>}</div>
    <div className="ai-confirmation-actions"><span>取消将停止本轮任务</span><button className="btn" disabled={working} onClick={() => void decide(false, false)}>取消</button>{!request.changed && <button className="btn" disabled={working} onClick={() => void decide(true, false)}>仅本次信任</button>}<button className="btn btn-primary" disabled={working} onClick={() => void decide(true, true)}>{request.changed ? '确认变更并继续' : '信任并记住'}</button></div>
    {error && <p className="ai-feedback is-error" role="alert">{error}</p>}
  </section>
}
