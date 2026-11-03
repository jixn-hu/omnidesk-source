import type { RdpFileTransferStatus } from '@shared/freerdp-protocol'

interface Props {
  status: RdpFileTransferStatus
  onCancel(): void
  onDismiss(): void
}

export default function FileTransferNotice({ status, onCancel, onDismiss }: Props) {
  if (status.state === 'available' || status.state === 'unavailable') return null
  return <div className="desktop-clipboard-notice" role="status">
    <span>{status.message}{status.total > 0 && ` · ${Math.floor(status.completed / status.total * 100)}%`}</span>
    {['ready', 'progress'].includes(status.state) && <button className="btn btn-ghost btn-sm" onClick={onCancel}>取消传输</button>}
    <button className="btn btn-ghost btn-sm" onClick={onDismiss}>关闭</button>
  </div>
}
