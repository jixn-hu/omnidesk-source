import { useEffect, useRef, useState } from 'react'
import Guacamole from 'guacamole-common-js'
import { useApp, type Tab } from '../../store/app'
import Icon from '../../components/Icon'
import SessionToolbar from '../../components/SessionToolbar'

export default function SharedSessionView({ tab, active }: { tab: Tab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const clientRef = useRef<InstanceType<typeof Guacamole.Client> | null>(null)
  const activeRef = useRef(active)
  const releaseInputRef = useRef<() => void>(() => {})
  const [retry, setRetry] = useState(0)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [clipboardOpen, setClipboardOpen] = useState(false)
  const [clipboard, setClipboard] = useState('')
  const [clipboardNotice, setClipboardNotice] = useState('')
  activeRef.current = active

  useEffect(() => { if (!active) releaseInputRef.current() }, [active])

  useEffect(() => {
    const container = host.current!
    let cancelled = false
    let sessionId: string | undefined
    let client: InstanceType<typeof Guacamole.Client> | undefined
    let keyboard: InstanceType<typeof Guacamole.Keyboard> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let resizeObserver: ResizeObserver | undefined
    let failure = ''
    const update = (patch: Partial<Tab>) => useApp.getState().updateTab(tab.id, patch)
    const fail = (message: string) => { if (!cancelled && !failure) { failure = message; setError(message); setConnected(false); update({ status: 'error', error: message }) } }
    const releaseInput = () => {
      keyboard?.reset()
      client?.sendMouseState({ x: 0, y: 0, left: false, middle: false, right: false, up: false, down: false })
    }
    releaseInputRef.current = releaseInput
    const resize = () => {
      if (cancelled || !client || !activeRef.current || !container.clientWidth || !container.clientHeight) return
      const display = client.getDisplay()
      if (display.getWidth() && display.getHeight()) display.scale(Math.min(1, container.clientWidth / display.getWidth(), container.clientHeight / display.getHeight()))
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!cancelled && activeRef.current) client?.sendSize(Math.max(320, Math.min(4096, container.clientWidth)), Math.max(240, Math.min(2160, container.clientHeight)))
      }, 200)
    }
    setError(''); setConnected(false); update({ status: 'connecting', error: undefined })
    void (async () => {
      if (!tab.shareId) throw new Error('共享服务器标识缺失')
      const result = await window.omnidesk.account.connect(tab.shareId, container.clientWidth || 1280, container.clientHeight || 800)
      if (!result.ok) throw new Error(result.message)
      sessionId = result.data.sessionId
      if (cancelled) { await window.omnidesk.account.release(sessionId); return }
      update({ sessionId })
      const tunnel = new Guacamole.WebSocketTunnel(result.data.url)
      tunnel.onerror = status => fail(status.message || '共享网关连接中断，请检查官方服务后重试')
      tunnel.onstatechange = state => { if (state === Guacamole.Tunnel.State.CLOSED && !cancelled) { fail('共享会话已断开。可能是共享已撤销、账号已退出，或官方网关不可用。'); client?.disconnect() } }
      client = new Guacamole.Client(tunnel)
      clientRef.current = client
      const display = client.getDisplay()
      const element = display.getElement()
      element.tabIndex = 0
      element.setAttribute('aria-label', '共享服务器远程画面')
      container.replaceChildren(element)
      display.showCursor(true)
      display.onresize = resize
      const mouse = new Guacamole.Mouse(element)
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = state => { if (activeRef.current) client?.sendMouseState(state, true) }
      keyboard = new Guacamole.Keyboard(element)
      keyboard.onkeydown = keysym => { if (activeRef.current) client?.sendKeyEvent(1, keysym); return false }
      keyboard.onkeyup = keysym => client?.sendKeyEvent(0, keysym)
      client.onerror = status => fail(status.message || '共享连接中断，请检查官方服务和远程网关')
      client.onstatechange = state => {
        if (cancelled) return
        if (state === 3) { setConnected(true); update({ status: 'connected', error: undefined }); resize(); if (activeRef.current) element.focus() }
        if (state === 5) fail('共享会话已断开。可能是共享已撤销、账号已退出，或官方网关不可用。')
      }
      client.onclipboard = (stream, mimetype) => {
        if (mimetype !== 'text/plain') { stream.sendAck('Only plain text is supported', 256); return }
        const reader = new Guacamole.StringReader(stream)
        let contents = ''
        let oversized = false
        reader.ontext = text => { if (contents.length + text.length > 65536) oversized = true; else contents += text }
        reader.onend = () => { if (!cancelled && !oversized) { setClipboard(contents); setClipboardNotice('已接收远程剪贴板，可在此复制文本。') } }
      }
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(container)
      client.connect('')
    })().catch(error => fail(error instanceof Error ? error.message : String(error)))
    window.addEventListener('blur', releaseInput)
    container.addEventListener('focusout', releaseInput)
    return () => {
      cancelled = true
      releaseInputRef.current = () => {}
      clearTimeout(timer)
      resizeObserver?.disconnect()
      releaseInput()
      client?.disconnect()
      clientRef.current = null
      container.replaceChildren()
      window.removeEventListener('blur', releaseInput)
      container.removeEventListener('focusout', releaseInput)
      if (sessionId) void window.omnidesk.account.release(sessionId)
    }
  }, [tab.id, tab.shareId, retry])

  return <div className="account-remote-workspace"><SessionToolbar active={active}><div className="toolbar session-toolbar account-remote-toolbar"><span className={`dot ${connected ? 'dot-connected' : error ? 'dot-error' : 'dot-connecting'}`} /><strong>{tab.shareKind?.toUpperCase()} · 官方共享会话</strong><span className="muted">凭据由官方服务保管</span><button className="btn btn-ghost btn-sm" disabled={!connected} onClick={() => setClipboardOpen(current => !current)}><Icon name="copy" size={14} />文本剪贴板</button><button className="btn btn-ghost btn-sm" onClick={() => setRetry(current => current + 1)}><Icon name="refresh" size={14} />重新连接</button></div></SessionToolbar>{clipboardOpen && <div className="account-remote-clipboard"><label className="field">文本剪贴板<textarea aria-label="共享会话文本剪贴板" rows={3} maxLength={65536} value={clipboard} onChange={event => setClipboard(event.target.value)} /></label><button className="btn btn-sm" disabled={!connected} onClick={() => { if (!clientRef.current) return; const writer = new Guacamole.StringWriter(clientRef.current.createClipboardStream('text/plain')); writer.sendText(clipboard); writer.sendEnd(); setClipboardNotice('已写入远程剪贴板，请在远端按 Ctrl+V 粘贴。') }}>写入远程剪贴板</button><span className="field-hint">{clipboardNotice || '最多 64K 字符；不会自动读取或覆盖本机剪贴板。'}</span></div>}<div className="account-remote-surface"><div className="account-remote-display" ref={host} onPointerDown={() => (host.current?.firstElementChild as HTMLElement | null)?.focus()} />{!connected && <div className="account-remote-overlay"><Icon name={error ? 'shield' : 'cloud'} size={32} /><h2>{error ? '共享会话未连接' : '正在通过官方服务连接…'}</h2><p>{error || '连接由服务端网关建立，不会获取服务器密码。'}</p>{error && <button className="btn" onClick={() => setRetry(current => current + 1)}>重试连接</button>}</div>}</div></div>
}
