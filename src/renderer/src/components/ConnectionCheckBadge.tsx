import { useApp } from '../store/app'

export default function ConnectionCheckBadge({ connectionId, onEdit, compact = false }: { connectionId: string; onEdit: () => void; compact?: boolean }) {
  const check = useApp(state => state.connectionChecks[connectionId])
  if (!check || (!check.issues.length && !check.credentialLocked)) return null
  const incomplete = check.issues.length > 0
  const label = incomplete ? '待完善' : '待解锁'
  const detail = [...check.issues, ...(check.credentialLocked ? ['保险箱已锁定，解锁后可检查凭据'] : [])].join('；')
  return <button type="button" className="connection-check-badge" data-incomplete={incomplete} data-compact={compact}
    title={`${label}：${detail}。点击编辑连接`} aria-label={`${label}：${detail}，编辑连接`}
    onClick={onEdit}>{compact ? '!' : label}</button>
}
