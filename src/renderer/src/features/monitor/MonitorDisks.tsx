import type { DiskMetrics } from '@shared/types'
import { diskExclusionReason } from '@shared/monitor-resources'
import { capacity, number } from './monitor-display'

function DiskTable({ disks, excluded = false, inodesAvailable }: { disks: DiskMetrics[]; excluded?: boolean; inodesAvailable: boolean }) {
  return <div className="monitor-table-wrap"><table className="monitor-table"><thead><tr><th>挂载点</th><th>设备 / 格式</th><th>已用 / 总量</th><th>占用</th><th>inode 占用</th>{excluded && <th>说明</th>}</tr></thead><tbody>{disks.map(disk => <tr key={disk.mount}><td>{disk.mount}</td><td>{disk.device}<small>{disk.fsType || '未提供'}</small></td><td>{capacity(disk.used, disk.total)}</td><td className={!excluded && disk.usagePercent >= 90 ? 'monitor-warning' : undefined}>{number(disk.usagePercent)}%</td><td className={inodesAvailable && !excluded && (disk.inodeUsagePercent ?? 0) >= 90 ? 'monitor-warning' : undefined}>{!inodesAvailable || disk.inodeUsagePercent === undefined ? '—' : number(disk.inodeUsagePercent) + '%'}</td>{excluded && <td>{diskExclusionReason(disk)} · 不参与容量和 inode 告警</td>}</tr>)}</tbody></table></div>
}
export default function MonitorDisks({ disks, inodesAvailable = true }: { disks: DiskMetrics[]; inodesAvailable?: boolean }) {
  const normal = disks.filter(disk => !diskExclusionReason(disk))
  const excluded = disks.filter(disk => !!diskExclusionReason(disk))
  return <section className="monitor-disks"><h3>磁盘与挂载点</h3>{normal.length ? <DiskTable disks={normal} inodesAvailable={inodesAvailable} /> : <p className="field-hint">暂无可监控的磁盘数据</p>}{excluded.length > 0 && <details className="monitor-excluded-disks"><summary>只读镜像与系统挂载 · {excluded.length} 个 · 不参与告警</summary><DiskTable disks={excluded} excluded inodesAvailable={inodesAvailable} /></details>}</section>
}
