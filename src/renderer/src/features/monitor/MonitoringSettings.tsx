import { useEffect, useState } from 'react'
import type { MonitorLocal } from '@shared/monitoring'
import { useApp } from '../../store/app'

export default function MonitoringSettings() {
 const user=useApp(s=>s.accountUser), server=useApp(s=>s.accountServerUrl)
 const [local,setLocal]=useState<MonitorLocal>()
 const [interval,setInterval]=useState(60),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{let active=true;void window.omnidesk.monitoring.local().then(r=>{if(active&&r.ok){setLocal(r.data);setInterval(r.data.config.defaultIntervalSeconds ?? 60)}});return()=>{active=false}},[server,user?.id])
 const save=async(enabled:boolean,test=false)=>{
  setBusy(true);setMessage('')
  try {
   const r=await window.omnidesk.monitoring.configure({enabled,defaultIntervalSeconds:interval})
   if(!r.ok)throw new Error(r.message);setLocal(r.data);window.dispatchEvent(new Event('omnidesk:monitoring-changed'))
   if(test){const checked=await window.omnidesk.monitoring.test();if(!checked.ok)throw new Error(checked.message);setMessage('账号鉴权与监控连接正常')}
   else setMessage('已保存。新节点采用默认周期，已有节点的周期保持原设置。')
  }catch(e){setMessage(e instanceof Error?e.message:'保存失败')}finally{setBusy(false)}
 }
 return <div className="card monitoring-settings">
  <div className="monitor-setting-toggle"><div><strong>显示服务器监控</strong><p className="field-hint">后台 Agent 独立采集，关闭客户端后继续上报。</p></div><button type="button" role="switch" aria-label="显示服务器监控" aria-checked={!!local?.config.enabled} className="switch" data-on={!!local?.config.enabled} disabled={!local||busy||!user} onClick={()=>void save(!local?.config.enabled)}/></div>
  <p className="field-hint">{user ? `当前账号：${user.username} · ${server}。监控沿用账号登录，无需另填地址或令牌。` : '登录上方账号后即可使用同一云端的监控功能。'}</p>
  <label className="field">默认采集与上报周期（秒）<input aria-label="默认采集与上报周期" type="number" min="5" max="86400" step="1" value={interval} disabled={busy} onChange={e=>setInterval(Number(e.target.value))}/></label>
  <div className="monitor-actions">{[30,60,300,600].map(value=><button type="button" key={value} className="btn btn-ghost btn-sm" disabled={busy} onClick={()=>setInterval(value)}>{value<60?`${value} 秒`:`${value/60} 分钟`}</button>)}</div>
  <p className="field-hint">默认 60 秒，允许 5 秒至 24 小时；可在每个节点的编辑页面单独设置。</p>
  <div className="monitor-actions"><button className="btn btn-primary btn-sm" disabled={busy||!local} onClick={()=>void save(local?.config.enabled??false)}>保存设置</button><button className="btn btn-sm" disabled={busy||!local||!user} onClick={()=>void save(true,true)}>保存并测试连接</button></div>
  {message&&<p className="field-hint" role="status">{message}</p>}
 </div>
}
