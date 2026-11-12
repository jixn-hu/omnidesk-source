import { useState } from 'react'
import { EMPTY_ASSET, renewedDate, type MonitorAsset, type MonitorNode } from '@shared/monitoring'

export default function MonitorAssetEditor({ node, onClose, onSaved }: {
  node: MonitorNode; onClose: () => void; onSaved: () => void
}) {
  const [intervalSeconds,setIntervalSeconds]=useState(node.intervalSeconds || node.metrics?.intervalSeconds || 60)
  const [asset, setAsset] = useState<MonitorAsset>({ ...EMPTY_ASSET, ...node?.asset })
  const [name, setName] = useState(node?.name ?? ''), [group, setGroup] = useState(node?.group ?? '')
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [renewal, setRenewal] = useState('')
  const discovered = node?.metrics?.discovered
  const field = <K extends keyof MonitorAsset>(key: K, value: MonitorAsset[K]) => setAsset(current => ({ ...current, [key]: value }))
  const save = async () => {
    setBusy(true); setMessage('')
    try {
      const result = await window.omnidesk.monitoring.saveNode({ id: node?.id, name, group, asset, intervalSeconds })
      if (!result.ok) throw new Error(result.message)
      onSaved(); onClose()
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败') } finally { setBusy(false) }
  }
  return <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="modal monitor-editor" role="dialog" aria-modal="true" aria-labelledby="monitor-editor-title">
    <header className="modal-header"><h2 id="monitor-editor-title">编辑节点资料</h2><button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose} aria-label="关闭监控编辑">关闭</button></header>
    <div className="modal-body monitor-form">
      <label className="field">节点名称<input aria-label="节点名称" value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="field">采集与上报周期（秒）<input aria-label="采集与上报周期" type="number" min="5" max="86400" step="1" value={intervalSeconds} onChange={event=>setIntervalSeconds(Number(event.target.value))}/></label>
      <p className="field-hint monitor-form-note">保存后在 Agent 下次成功上报时应用。{node.metrics?.intervalSeconds ? `当前实际周期：${node.metrics.intervalSeconds} 秒。` : '旧版 Agent 需更新后才能远程调整周期。'}</p>
      <label className="field">分组<input value={group} onChange={event => setGroup(event.target.value)} /></label>
      <label className="field">服务商<input value={asset.provider} placeholder={discovered?.provider ? `自动：${discovered.provider}` : '采集后自动识别，可手动填写'} onChange={event => field('provider', event.target.value)} /></label>
      <label className="field">地区<input value={asset.region} placeholder={discovered?.region ? `自动：${discovered.region}` : '采集后自动识别，可手动填写'} onChange={event => field('region', event.target.value)} /></label>
      <p className="field-hint monitor-form-note">服务商和地区留空时使用自动识别结果，手动填写优先。{discovered ? `来源 ${discovered.source}，公网 IP ${discovered.ip}${discovered.asn ? '，' + discovered.asn : ''}；识别时区 ${discovered.timezone || '未知'}。IP 归属可能是机房或上游网络，可按商家资料修正。` : '服务商和地区由后台采集端自动识别并上报。'}到期日、价格、套餐和计费时区按你填写的资料保存。</p>
      <label className="field">到期日期<input aria-label="到期日期" type="date" value={asset.expiresAt} onChange={event => { field('expiresAt', event.target.value); setRenewal('') }} /></label>
      <label className="field">计费周期<select value={asset.billingCycle} onChange={event => field('billingCycle', event.target.value)}><option value="monthly">月付</option><option value="quarterly">季付</option><option value="yearly">年付</option><option value="custom">自定义</option></select></label>
      <label className="field">每周期价格<input type="number" min="0" step="0.01" value={asset.price} onChange={event => field('price', Number(event.target.value))} /></label>
      <label className="field">币种<input value={asset.currency} maxLength={20} onChange={event => field('currency', event.target.value)} /></label>
      <label className="field monitor-form-note">商家后台地址<input type="url" value={asset.vendorUrl} onChange={event => field('vendorUrl', event.target.value)} /></label>
      <label className="monitor-checkbox monitor-form-note"><input type="checkbox" checked={asset.autoPay} onChange={event => field('autoPay', event.target.checked)} />商家已开启自动扣款（仍保留到期提醒）</label>
      <div className="monitor-form-note monitor-renewal"><button className="btn btn-sm" disabled={!asset.expiresAt || asset.billingCycle === 'custom'} onClick={() => { try { setRenewal(renewedDate(asset.expiresAt, asset.billingCycle)) } catch (error) { setMessage(String(error)) } }}>确认已续费 · 预览日期</button>{renewal && <span>新到期日期：<strong>{renewal}</strong> <button className="btn btn-sm" onClick={() => { field('expiresAt', renewal); setRenewal('') }}>采用此日期</button></span>}</div>
      <>
        <label className="field">套餐流量（GB，0 表示不限）<input type="number" min="0" value={asset.trafficLimit / 1e9} onChange={event => field('trafficLimit', Math.round(Number(event.target.value) * 1e9))} /></label>
        <label className="field">计费方向<select value={asset.trafficMode} onChange={event => field('trafficMode', event.target.value as MonitorAsset['trafficMode'])}><option value="sum">上传 + 下载</option><option value="up">仅上传</option><option value="down">仅下载</option><option value="max">上传、下载取最大</option><option value="min">上传、下载取最小</option></select></label>
        <label className="field">每月重置日<input type="number" min="1" max="31" value={asset.resetDay} onChange={event => field('resetDay', Number(event.target.value))} /></label>
        <label className="field">统计时区<input value={asset.timezone} onChange={event => field('timezone', event.target.value)} placeholder="Asia/Shanghai" /></label>
        <label className="field">起始用量所属周期开始日<input type="date" value={asset.initialPeriod} onChange={event => field('initialPeriod', event.target.value)} /></label>
        <label className="field">起始已上传（GB）<input type="number" min="0" value={asset.initialUpload / 1e9} onChange={event => field('initialUpload', Math.round(Number(event.target.value) * 1e9))} /></label>
        <label className="field">起始已下载（GB）<input type="number" min="0" value={asset.initialDownload / 1e9} onChange={event => field('initialDownload', Math.round(Number(event.target.value) * 1e9))} /></label>
        <p className="field-hint monitor-form-note">起始用量只应用于指定周期。网卡在采集端配置 includeNics 中选择。流量统一使用十进制（1 GB = 1000 MB），填写 1000 GB 即显示总量 1000 GB。内存和磁盘容量按原有口径显示。</p>
      </>
      {message && <p role="alert" className="monitor-form-note alert alert-danger">{message}</p>}
    </div><footer className="modal-footer"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></footer>
  </section></div>
}
