import { useEffect, useRef, useState } from 'react'
import type { IpcResult, SharedCredential } from '@shared/types'
import type { CredentialProbeResult, CredentialProbeStep } from '@shared/credential-probe'
import { useApp } from '../../store/app'

function unwrap<Value>(result: IpcResult<Value>): Value {
  if (!result.ok) throw new Error(result.message)
  return result.data
}

async function testRdp(payload: NonNullable<CredentialProbeStep['rdp']>, canvas: HTMLCanvasElement, signal: AbortSignal): Promise<boolean> {
  const { createRdpRuntime } = await import('../desktop/rdp-runtime')
  const runtime = await createRdpRuntime()
  const builder = new runtime.SessionBuilder()
  let session: import('ironrdp-wasm').Session | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abandoned = false
  const abort = () => { abandoned = true; void window.omnidesk.rdp.release(payload.transport.sessionId) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) return false
    builder.username(payload.username).password(payload.password).destination(payload.destination)
      .proxyAddress(payload.transport.wsUrl).authToken(payload.transport.token).renderCanvas(canvas)
      .setCursorStyleCallbackContext(canvas).setCursorStyleCallback(() => {})
    if (payload.domain) builder.serverDomain(payload.domain)
    builder.extension(runtime.enableCredssp(true))
    builder.extension(runtime.displayControl(false))
    builder.desktopSize(new runtime.DesktopSize(800, 600))
    const pending = builder.connect()
    void pending.then(connected => { if (abandoned) { connected.shutdown(); connected.free() } }).catch(() => {})
    session = await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => { abort(); reject(new Error('RDP 测试超时')) }, 90_000) })])
    if (abandoned || signal.aborted) { session = undefined; return false }
    return true
  } catch { return false }
  finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    session?.shutdown()
    session?.free()
    builder.free()
    runtime.runtime.dispose()
    await window.omnidesk.rdp.release(payload.transport.sessionId)
  }
}

export default function CredentialTest({ connectionIds, onClose }: { connectionIds: string[]; onClose: () => void }) {
  const connections = useApp(state => state.connections)
  const [credentials, setCredentials] = useState<SharedCredential[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [results, setResults] = useState<CredentialProbeResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  const [applied, setApplied] = useState<string[]>([])
  const job = useRef('')
  const mounted = useRef(true)
  const controller = useRef<AbortController>()
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    mounted.current = true
    void window.omnidesk.shared.list().then(response => { if (mounted.current) { if (response.ok) setCredentials(response.data); else setError(response.message) } })
    return () => { mounted.current = false; controller.current?.abort(); if (job.current) void window.omnidesk.credentialProbe.cancel(job.current) }
  }, [])
  const start = async () => {
    setBusy(true); setError(''); setResults([]); setApplied([])
    controller.current = new AbortController()
    const signal = controller.current.signal
    try {
      job.current = unwrap(await window.omnidesk.credentialProbe.start(connectionIds, selected))
      if (signal.aborted) { await window.omnidesk.credentialProbe.cancel(job.current); return }
      while (!signal.aborted) {
        if (mounted.current) setProgress('正在认证；首次连接请核对主机指纹或服务器证书…')
        const step = unwrap(await window.omnidesk.credentialProbe.next(job.current))
        if (step.done || signal.aborted) break
        let result = step.result
        if (step.rdp) {
          if (mounted.current) setProgress(`正在测试 RDP：${connections.find(item => item.id === step.rdp!.connectionId)?.name ?? ''}`)
          const success = await testRdp(step.rdp, canvas.current!, signal)
          if (signal.aborted) break
          result = unwrap(await window.omnidesk.credentialProbe.finishRdp(job.current, success))
        }
        if (result && mounted.current) setResults(current => [...current, result!])
      }
      if (mounted.current) setProgress(signal.aborted ? '已停止；可以应用已验证成功的凭据。' : '测试完成。成功项可应用为该服务器的公共凭据。')
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '测试失败') }
    finally { if (mounted.current) setBusy(false) }
  }
  const stop = () => { controller.current?.abort(); if (job.current) void window.omnidesk.credentialProbe.cancel(job.current); setProgress('正在停止并释放测试连接…') }
  const apply = async (connectionId: string) => {
    try {
      unwrap(await window.omnidesk.credentialProbe.apply(job.current, connectionId))
      useApp.getState().setConnections(unwrap(await window.omnidesk.connections.list()))
      setApplied(current => [...current, connectionId])
    } catch (error) { setError(error instanceof Error ? error.message : '应用失败') }
  }
  return <div className="modal-backdrop"><div className="modal modal-lg credential-test" role="dialog" aria-modal="true" aria-label="批量测试公共凭据">
    <div className="modal-header"><h2>测试公共凭据</h2><button className="btn btn-ghost" onClick={() => { stop(); onClose() }}>关闭</button></div>
    <div className="modal-body"><p>已选 {connectionIds.length} 台服务器。选择最多 3 条已有公共凭据，按勾选顺序逐个认证，成功即停止该服务器的后续尝试。</p><div className="alert alert-warning">失败登录可能触发服务器账号锁定，请按服务器策略控制次数。RDP 测试会实际登录，可能影响已有桌面会话。不会执行远端命令或自动修改连接凭据。</div>
      <div className="probe-choices">{credentials.map(credential => <label className="configuration-choice" key={credential.id}><input type="checkbox" disabled={busy || (selected.length >= 3 && !selected.includes(credential.id))} checked={selected.includes(credential.id)} onChange={event => setSelected(current => event.target.checked ? [...current, credential.id] : current.filter(id => id !== credential.id))} /><span>{credential.name}<small>{credential.kind === 'privateKey' ? '私钥' : '密码'} · {credential.username || '使用服务器原账号'}{selected.includes(credential.id) ? ` · 顺序 ${selected.indexOf(credential.id) + 1}` : ''}</small></span></label>)}</div>
      {!credentials.length && <p className="field-hint">请先在「公共凭据」创建账号密码或私钥。</p>}
      <div className="probe-results"><table className="table"><thead><tr><th>服务器</th><th>公共凭据</th><th>结果</th><th /></tr></thead><tbody>{results.map((result, index) => <tr key={index}><td>{connections.find(item => item.id === result.connectionId)?.name}</td><td>{credentials.find(item => item.id === result.credentialId)?.name}</td><td><span className={`badge ${result.success ? 'badge-success' : 'badge-warning'}`}>{result.message}</span></td><td>{result.success && <button className="btn btn-sm" disabled={applied.includes(result.connectionId)} onClick={() => void apply(result.connectionId)}>{applied.includes(result.connectionId) ? '已应用' : '应用凭据'}</button>}</td></tr>)}</tbody></table></div>
      <div role="status" className="field-hint">{progress}</div>{error && <div role="alert" className="alert alert-danger">{error}</div>}
      <canvas ref={canvas} width={800} height={600} hidden />
    </div><div className="modal-footer"><span className="field-hint">串行测试 · 每次间隔至少 1.5 秒 · 最长 10 分钟</span>{busy ? <button className="btn" onClick={stop}>停止测试</button> : <button className="btn btn-primary" disabled={!selected.length || connectionIds.length > 100} onClick={() => void start()}>开始测试所选服务器</button>}</div>
  </div></div>
}
