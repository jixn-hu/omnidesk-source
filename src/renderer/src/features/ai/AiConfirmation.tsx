import { useRef, useState } from 'react'
import type { AiApprovalRecord, AiApprovalOutcome, AiApi } from '@shared/ai'
import Icon from '../../components/Icon'
import AiMarkdown from './AiMarkdown'

const outcomes: Record<AiApprovalOutcome, string> = { pending: '等待你的确认', confirmed: '已确认', cancelled: '已取消', expired: '已超时', stopped: '任务已停止', superseded: '已由新消息替代' }

export default function AiConfirmation({ approval, pendingId, onConfirm }: { approval: AiApprovalRecord; pendingId?: string; onConfirm: AiApi['confirm'] }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const deciding = useRef(false)
  const current = approval.outcome === 'pending' && pendingId === approval.id
  const outcome = approval.outcome === 'pending' && !current ? 'stopped' : approval.outcome
  const pending = outcome === 'pending'
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
  </> : approval.kind === 'delete' ? <><p className="ai-confirmation-target"><strong>{approval.serverName}</strong><code>{approval.destination}</code></p><p>将删除这条本机服务器连接资料。远程机器、凭据和共享配置保留。</p><p className="ai-confirmation-note">确认后删除；取消只跳过此次删除。</p></> : approval.kind === 'edit' ? <><pre tabIndex={0} aria-label="待修改的服务器资料">{approval.message}</pre><p className="ai-confirmation-note">确认仅授权本次资料变更，当前对话权限保持不变。取消后不修改资料。</p></> : <><AiMarkdown text={approval.message} /><p className="ai-confirmation-note">点击确定后继续处理；也可以直接发送新想法，替代本次确认。</p></>
  return <section className="ai-confirmation" data-state={outcome} aria-label={approval.kind === 'ssh' ? 'SSH 命令确认' : approval.kind === 'delete' ? '服务器删除确认' : approval.kind === 'edit' ? '服务器资料修改确认' : 'AI 事项确认'} onKeyDown={event => {
    if (event.key === 'Escape' && pending) { event.preventDefault(); event.stopPropagation(); void decide(false) }
  }}>
    <div className="ai-confirmation-heading"><span className="ai-confirmation-icon"><Icon name="shield" size={16} /></span><h3>{approval.kind === 'ssh' ? '执行 SSH 命令' : approval.kind === 'delete' ? '删除服务器资料' : approval.title}</h3><span className="ai-confirmation-state" role="status">{outcomes[outcome]}</span></div>
    {pending ? <>
      <div className="ai-confirmation-body">{body}</div>
      <div className="ai-confirmation-actions"><span>可直接发送新要求</span><button className="btn" disabled={working} onClick={() => void decide(false)}>取消</button><button className="btn btn-primary" disabled={working} onClick={() => void decide(true)}>{working ? '正在提交…' : approval.kind === 'ssh' ? '确认执行' : approval.kind === 'delete' ? '确认删除' : approval.kind === 'edit' ? '确认修改' : '确定'}</button></div>
    </> : <details className="ai-confirmation-history"><summary>{approval.kind === 'ssh' ? `${approval.serverName} · 查看命令与说明` : approval.kind === 'delete' ? `${approval.serverName} · 查看删除说明` : '查看确认内容'}<Icon name="chevron" size={12} /></summary><div className="ai-confirmation-body">{body}</div>{outcome === 'confirmed' && <p className="ai-confirmation-note">这是你的确认记录，实际处理结果请查看后续回复与执行记录。</p>}</details>}
    {error && <p className="ai-feedback is-error" role="alert">{error}</p>}
  </section>
}
