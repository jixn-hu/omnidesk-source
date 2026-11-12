import { useEffect, useState } from 'react'
import { AI_DEFAULT_MAX_MODEL_CALLS, AI_MAX_MODEL_CALLS, aiPermissionModes, type AiConfiguration } from '@shared/ai'
import Icon from '../../components/Icon'

export default function AiSettings({ onSaved, embedded = false }: { onSaved?: (configuration: AiConfiguration) => void; embedded?: boolean }) {
  const [configuration, setConfiguration] = useState<AiConfiguration>({ baseUrl: '', model: '', hasApiKey: false, maxModelCalls: AI_DEFAULT_MAX_MODEL_CALLS, permissionMode: 'read' })
  const [callLimit, setCallLimit] = useState(String(AI_DEFAULT_MAX_MODEL_CALLS))
  const validLimit = Number.isSafeInteger(Number(callLimit)) && Number(callLimit) >= 1 && Number(callLimit) <= AI_MAX_MODEL_CALLS
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  useEffect(() => {
    let active = true
    const refresh = () => { void window.omnidesk.ai.configuration().then(result => {
      if (!active) return
      if (result.ok) { setConfiguration(result.data); setCallLimit(String(result.data.maxModelCalls)); setLoaded(true); setKey(''); setClearKey(false) }
      else setMessage({ text: result.message, error: true })
    }) }
    const restored = (event: Event) => { const sections = (event as CustomEvent<string[]>).detail; if (sections?.some(section => ['aiSettings', 'serviceCredentials'].includes(section))) refresh() }
    refresh(); window.addEventListener('omnidesk:backup-restored', restored)
    return () => { active = false; window.removeEventListener('omnidesk:backup-restored', restored) }
  }, [])
  const save = async (test: boolean) => {
    setBusy(true); setMessage(null)
    try {
      const result = await window.omnidesk.ai.saveConfiguration({ baseUrl: configuration.baseUrl, model: configuration.model, apiKey: key || undefined, clearApiKey: clearKey, maxModelCalls: Number(callLimit), permissionMode: configuration.permissionMode })
      if (!result.ok) { setMessage({ text: result.message, error: true }); return }
      setConfiguration(result.data); setCallLimit(String(result.data.maxModelCalls)); setKey(''); setClearKey(false); onSaved?.(result.data)
      if (test) {
        const probe = await window.omnidesk.ai.test()
        setMessage({ text: probe.ok ? probe.data : probe.message, error: !probe.ok })
      } else setMessage({ text: 'AI 配置已保存。' })
    } finally { setBusy(false) }
  }
  return <section className="card ai-settings" aria-label="AI 模型配置">
    <div className="ai-settings-heading">{!embedded && <Icon name="assistant" size={20} />}<div>{!embedded && <div className="card-title">AI 模型配置</div>}<p className="card-desc">填写支持工具调用的 OpenAI 兼容接口，也支持内网 HTTP 服务。</p></div></div>
    <div className="ai-settings-fields">
      <label className="field"><span className="field-label">接口地址</span><input aria-label="AI 接口地址" placeholder="https://your-provider.example/v1" value={configuration.baseUrl} disabled={busy || !loaded} onChange={event => setConfiguration({ ...configuration, baseUrl: event.target.value })} spellCheck={false} /></label>
      <label className="field"><span className="field-label">模型名称</span><input aria-label="AI 模型名称" placeholder="填写服务商提供的模型名称" value={configuration.model} disabled={busy || !loaded} onChange={event => setConfiguration({ ...configuration, model: event.target.value })} spellCheck={false} /></label>
      <label className="field ai-key-field"><span className="field-label">API Key <small>{configuration.hasApiKey && !clearKey ? '已安全保存 · 留空保留' : '本地接口可留空'}</small></span><input aria-label="AI API Key" type="password" autoComplete="new-password" placeholder={configuration.hasApiKey ? '输入新 Key 以替换' : '按服务商要求填写'} value={key} disabled={busy || !loaded || clearKey} onChange={event => setKey(event.target.value)} /></label>
    </div>
    <div className="ai-settings-policy"><label className="field"><span className="field-label">单轮模型调用上限</span><input aria-label="单轮模型调用上限" type="number" min={1} max={AI_MAX_MODEL_CALLS} step={1} value={callLimit} disabled={busy || !loaded} onChange={event => setCallLimit(event.target.value)} /><small>默认 200 次，可设 1–{AI_MAX_MODEL_CALLS} 次；最后一次请求用于整理结果。</small></label><div className="ai-permission-settings"><span className="field-label">新对话默认权限</span><div className="ai-permission-options">{aiPermissionModes.map(mode => <label key={mode.value} data-selected={configuration.permissionMode === mode.value}><input type="radio" name="ai-default-permission" aria-label={`默认${mode.label}`} value={mode.value} checked={configuration.permissionMode === mode.value} disabled={busy || !loaded} onChange={() => setConfiguration({ ...configuration, permissionMode: mode.value })} /><strong>{mode.label}</strong><span>{mode.description}</span></label>)}</div></div></div>
    {configuration.hasApiKey && <label className="ai-clear-key"><input type="checkbox" checked={clearKey} disabled={busy} onChange={event => setClearKey(event.target.checked)} />保存时清除已有 API Key</label>}
    <p className="ai-settings-note"><Icon name="shield" size={14} />API Key 加密保存在本机保险箱。服务器密码、私钥不会作为连接资料发送给模型。</p>
    <div className="ai-settings-actions"><button className="btn btn-primary" disabled={busy || !loaded || !validLimit || !configuration.baseUrl.trim() || !configuration.model.trim()} onClick={() => void save(false)}>{busy ? '处理中…' : '保存 AI 配置'}</button><button className="btn" disabled={busy || !loaded || !validLimit || !configuration.baseUrl.trim() || !configuration.model.trim()} onClick={() => void save(true)}>保存并测试</button></div>
    {message && <p className={`ai-feedback ${message.error ? 'is-error' : ''}`} role="status">{message.text}</p>}
  </section>
}
