import { useEffect, useRef, useState } from 'react'
import type { AiApprovalRecord, AiApprovalOutcome, AiApi } from '@shared/ai'
import Icon from '../../components/Icon'
import AiMarkdown from './AiMarkdown'

const outcomes: Record<AiApprovalOutcome, string> = { pending: '等待你的确认', confirmed: '已确认', cancelled: '已取消', expired: '已超时', stopped: '任务已停止' }

export default function AiConfirmation({ approval, pendingId, onConfirm }: { approval: AiApprovalRecord; pendingId?: string; onConfirm: AiApi['confirm'] }) {
  const [now, setNow] = useState(Date.now())
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const deciding = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const current = approval.outcome === 'pending' && pendingId === approval.id
  const remaining = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000))
  const outcome = approval.outcome === 'pending' && (!current || !remaining) ? 'expired' : approval.outcome
  const pending = outcome === 'pending'
  useEffect(() => {
    if (!current) return
    setNow(Date.now())
    cancel.current?.focus({ preventScroll: true })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [current, approval.id])
  const decide = async (approved: boolean) => {
    if (!pending || deciding.current) return
    deciding.current = true; setWorking(true); setError('')
    try {
      const result = await onConfirm(approval.id, approved)
      if (!result.ok || !result.data) setError(result.ok ? '此确认已失效，请查看最新任务状态。' : result.message)
    } catch { setError('提交失败，请重试。') }
    finally { deciding.current = false; setWorking(false) }
  }
  const body = approval.kind === 'ssh' ? <>
    <p className="ai-confirmation-target"><strong>{approval.serverName}</strong><code>{approval.destination}</code></p>
    <p className="ai-confirmation-reason">{approval.reason}</p>
    <pre tabIndex={0} aria-label="待执行的完整 SSH 命令">{approval.command}</pre>
    <p className="ai-confirmation-note">取消只跳过这条命令；确认后执行完整命令，并将结果发送给已配置的模型。</p>
  </> : approval.kind === 'delete' ? <><p className="ai-confirmation-target"><strong>{approval.serverName}</strong><code>{approval.destination}</code></p><p>将删除这条本机服务器连接资料。远程机器、凭据和共享配置保留。</p><p className="ai-confirmation-note">确认后删除；取消只跳过此次删除。</p></> : <><AiMarkdown text={approval.message} /><p className="ai-confirmation-note">确定后继续处理；取消将结束本轮后续操作。</p></>
  return <section className="ai-confirmation" data-state={outcome} aria-label={approval.kind === 'ssh' ? 'SSH 命令确认' : approval.kind === 'delete' ? '服务器删除确认' : 'AI 事项确认'} onKeyDown={event => {
    if (event.key === 'Escape' && pending) { event.preventDefault(); event.stopPropagation(); void decide(false) }
  }}>
    <div className="ai-confirmation-heading"><span className="ai-confirmation-icon"><Icon name="shield" size={16} /></span><h3>{approval.kind === 'ssh' ? '执行 SSH 命令' : approval.kind === 'delete' ? '删除服务器资料' : approval.title}</h3><span className="ai-confirmation-state" role="status">{outcomes[outcome]}</span></div>
    {pending ? <>
      <div className="ai-confirmation-body">{body}</div>
      <div className="ai-confirmation-actions"><span>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} 后失效</span><button className="btn" ref={cancel} disabled={working} onClick={() => void decide(false)}>取消</button><button className="btn btn-primary" disabled={working} onClick={() => void decide(true)}>{working ? '正在提交…' : approval.kind === 'ssh' ? '确认执行' : approval.kind === 'delete' ? '确认删除' : '确定'}</button></div>
    </> : <details className="ai-confirmation-history"><summary>{approval.kind === 'ssh' ? `${approval.serverName} · 查看命令与说明` : approval.kind === 'delete' ? `${approval.serverName} · 查看删除说明` : '查看确认内容'}<Icon name="chevron" size={12} /></summary><div className="ai-confirmation-body">{body}</div>{outcome === 'confirmed' && <p className="ai-confirmation-note">这是你的确认记录，实际处理结果请查看后续回复与执行记录。</p>}</details>}
    {error && <p className="ai-feedback is-error" role="alert">{error}</p>}
  </section>
}
