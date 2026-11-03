import { useApp } from '../store/app'

/**
 * 外部调用审批
 *
 * AI 或外部系统通过 MCP 发起写操作时，在这里弹确认。
 * 这是「让 AI 能干活，但不让它乱来」的关键一环。
 */
export default function ApprovalToasts() {
  const approvals = useApp((s) => s.approvals)
  const removeApproval = useApp((s) => s.removeApproval)

  if (approvals.length === 0) return null

  const decide = async (requestId: string, approved: boolean) => {
    await window.omnidesk.external.approve(requestId, approved)
    removeApproval(requestId)
  }

  return (
    <div className="toast-stack">
      {approvals.map((req) => (
        <div key={req.requestId} className="toast">
          <div className="toast-head">
            <span className="badge badge-warning">外部请求</span>
            <span className="toast-op mono">{req.operation}</span>
          </div>
          <div className="toast-detail mono">{req.detail}</div>
          <div className="toast-actions">
            <button className="btn btn-sm" onClick={() => decide(req.requestId, false)}>
              拒绝
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => decide(req.requestId, true)}>
              允许
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
