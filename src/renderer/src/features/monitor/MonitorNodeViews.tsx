import type { MonitorRow } from './monitor-display'
import { capacity, cpuCapacity, networkRate, nodeDisplay, number, rate, trafficAmount, trafficQuota } from './monitor-display'
import { resourceAlert } from '@shared/monitor-resources'
import Icon from '../../components/Icon'

type Props = { rows: MonitorRow[]; now: number; onDetail: (row: MonitorRow) => void; onEdit: (row: MonitorRow) => void; onInstall: (row: MonitorRow) => void; onDelete: (row: MonitorRow) => void }

function State({ status, error }: { status: string; error?: string }) {
  return <span className={`monitor-state ${status === '正常' ? 'is-ok' : ['失联', '资源告警', '采集异常'].includes(status) ? 'is-danger' : ''}`} title={error}>{status}</span>
}
function Usage({ label, value, amount, title }: { label: string; value?: number; amount: string; title?: string }) {
  const known = value !== undefined && Number.isFinite(value)
  return <div className="monitor-resource" title={title}><div className="monitor-resource-label"><span>{label}</span><strong>{amount}</strong></div><div className="monitor-resource-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.max(0, Math.min(100, value)) : undefined} aria-valuetext={known ? `${amount}，使用率 ${number(value)}%` : '暂无数据'}><span data-level={known && value >= 90 ? 'danger' : known && value >= 75 ? 'warning' : 'normal'} style={{ width: `${known ? Math.max(0, Math.min(100, value)) : 0}%` }} /></div></div>
}
function Actions({ row, onDetail, onInstall }: Pick<Props, 'onDetail' | 'onInstall'> & { row: MonitorRow }) {
  return <div className="monitor-row-actions">{!row.metrics && <button className="btn btn-sm" onClick={() => onInstall(row)}>安装采集端</button>}<button className="btn btn-ghost btn-sm" onClick={() => onDetail(row)}>查看详情<Icon name="chevron" size={12} /></button></div>
}
function Updated({ row, now }: { row: MonitorRow; now: number }) {
  if (!row.metrics) return <span>等待首次上报</span>
  const seconds = Math.max(0, Math.floor((now - row.metrics.timestamp) / 1000))
  return <span title={`最近采集：${new Date(row.metrics.timestamp).toLocaleString()}`}>{seconds < 60 ? '刚刚上报' : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前上报` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前上报` : `${Math.floor(seconds / 86400)} 天前上报`}</span>
}
function Traffic({ row }: { row: MonitorRow }) {
  if (!row.metrics) return null
  const { asset, used, trafficMode } = nodeDisplay(row, Date.now())
  const percent = asset.trafficLimit > 0 ? used / asset.trafficLimit * 100 : undefined
  const details = `本周期 ↓ ${trafficAmount(row.node.periodDownload)} · ↑ ${trafficAmount(row.node.periodUpload)} · 按${trafficMode}计费${row.node.incomplete ? ' · 统计不完整' : ''}`
  return <div className="monitor-period" title={details}><div className="monitor-period-heading"><span>本周期流量</span><strong>已用 {trafficAmount(used)}{asset.trafficLimit > 0 && <small> / 总量 {trafficQuota(asset.trafficLimit)}</small>}</strong></div>{percent !== undefined && <div className="monitor-resource-track"><span data-level={percent >= 100 ? 'danger' : percent >= 80 ? 'warning' : 'normal'} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>}{row.node.incomplete && <small>统计不完整</small>}</div>
}
export function MonitorCards(props: Props) {
  return <div className="monitor-card-grid">{props.rows.map(row => {
    const { metrics: m, status, disk, asset, days, expiry } = nodeDisplay(row, props.now)
    const ip = row.metrics?.publicIP?.ipv4 || row.metrics?.publicIP?.ipv6 || row.metrics?.discovered?.ip
    return <article key={row.id} className="monitor-node-card" data-status={status} aria-label={`${row.name}监控卡片`}>
      <header className="monitor-card-header"><span className="monitor-card-icon"><Icon name="server" size={18} /></span><div><button className="monitor-name" title={row.name} onClick={() => props.onDetail(row)}>{row.name}</button>{row.group && <span className="monitor-card-group">{row.group}</span>}</div><State status={status} error={row.error || (m ? resourceAlert(m) : undefined)} /></header>
      {ip && <div className="monitor-card-address"><code>{ip}</code></div>}
      {m && <div className="monitor-card-resources">
        <Usage label="CPU" value={m?.cpu.usage} amount={cpuCapacity(m)} title="已用 / 总逻辑核数，已用按 CPU 使用率折算" />
        <Usage label="内存" value={m?.memory.usagePercent} amount={m ? capacity(m.memory.used, m.memory.total) : '—'} />
        {disk && <Usage label="磁盘" value={disk.usagePercent} amount={capacity(disk.used, disk.total)} title={`最高占用分区：${disk.mount}`} />}
      </div>}
      {m && (networkRate(m, 'rxRate') !== undefined || networkRate(m, 'txRate') !== undefined) && <div className="monitor-card-network"><div><span>↓ 下载</span><strong>{rate(networkRate(m, 'rxRate'))}</strong></div><div><span>↑ 上传</span><strong>{rate(networkRate(m, 'txRate'))}</strong></div></div>}
      <Traffic row={row} />
      {asset.expiresAt && <div className="monitor-card-expiry"><span>到期</span><span className={days !== undefined && days <= 7 ? 'monitor-warning' : ''} title={asset.expiresAt}>{expiry}</span></div>}
      <footer className="monitor-card-footer"><Updated row={row} now={props.now} /><Actions {...props} row={row} /></footer>
    </article>
  })}</div>
}
export function MonitorList(props: Props) {
  const showExpiry = props.rows.some(row => !!row.node.asset.expiresAt)
  return <div className="monitor-table-wrap"><table className="monitor-table monitor-node-table"><thead><tr><th>服务器</th><th>状态</th><th>CPU</th><th>内存</th><th>磁盘</th><th>下载 / 上传</th><th>周期流量 / 额度</th>{showExpiry && <th>到期</th>}<th>操作</th></tr></thead><tbody>{props.rows.map(row => {
    const { status, metrics: m, disk, asset, days, expiry } = nodeDisplay(row, props.now)
    const ip = row.metrics?.publicIP?.ipv4 || row.metrics?.publicIP?.ipv6 || row.metrics?.discovered?.ip
    return <tr key={row.id}>
      <td><button className="monitor-name" title={row.name} onClick={() => props.onDetail(row)}>{row.name}</button>{row.group && <small>{row.group}</small>}{ip && <small className="monitor-ip">{ip}</small>}</td>
      <td><State status={status} error={row.error || (m ? resourceAlert(m) : undefined)} /><small><Updated row={row} now={props.now} /></small></td>
      <td><Usage label="CPU" value={m?.cpu.usage} amount={cpuCapacity(m)} title="已用 / 总逻辑核数，已用按 CPU 使用率折算" /></td>
      <td><Usage label="内存" value={m?.memory.usagePercent} amount={m ? capacity(m.memory.used, m.memory.total) : '—'} /></td>
      <td><Usage label="磁盘" value={disk?.usagePercent} amount={disk ? capacity(disk.used, disk.total) : '—'} title={disk?.mount} /></td>
      <td className="monitor-numeric">↓ {rate(networkRate(m, 'rxRate'))}<small>↑ {rate(networkRate(m, 'txRate'))}</small></td>
      <td><Traffic row={row} /></td>{showExpiry && <td><span className={days !== undefined && days <= 7 ? 'monitor-warning' : ''}>{asset.expiresAt ? expiry : '—'}</span></td>}
      <td><Actions {...props} row={row} /></td>
    </tr>
  })}</tbody></table></div>
}
