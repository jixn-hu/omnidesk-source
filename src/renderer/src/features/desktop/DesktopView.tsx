import { useEffect, useRef, useState } from 'react'
import { useApp, type Tab } from '../../store/app'
import { scancodeFor, mouseButtonFor, shouldUseUnicode } from './input'
import Icon from '../../components/Icon'
import SessionToolbar from '../../components/SessionToolbar'
import { formatConnectionAddress } from '@shared/connection-identity'
import { rdpDisplaySize } from '@shared/rdp-display'
import { canProbeLegacyRdp } from '@shared/rdp-security'
import type { RdpOptions } from '@shared/types'
import type { RdpFileTransferStatus } from '@shared/freerdp-protocol'
import type { DesktopRuntime, DesktopBuilder, DesktopSession, DesktopEvent } from './desktop-runtime'
import { createRdpClipboard, type RdpClipboard } from './rdp-clipboard'
import FileTransferNotice from './FileTransferNotice'
import { friendlyRdpError } from './rdp-errors'

type Phase = 'idle' | 'preparing' | 'loading' | 'connecting' | 'live' | 'error' | 'ended'

type RdpModule = DesktopRuntime
type RdpSessionBuilder = DesktopBuilder
type RdpSession = DesktopSession
type RdpDeviceEvent = DesktopEvent

async function loadRuntime(engine?: 'ironrdp' | 'freerdp'): Promise<RdpModule> {
  if (engine === 'freerdp') {
    const { createFreeRdpRuntime } = await import('./freerdp-runtime')
    if (!window.omnidesk.rdp.openNativeSocket) throw new Error('本机通信组件版本不匹配，请重新安装完整安装包')
    return createFreeRdpRuntime(window.omnidesk.rdp.openNativeSocket)
  }
  const { createRdpRuntime } = await import('./rdp-runtime')
  return createRdpRuntime()
}

export default function DesktopView({ tab, active = true }: { tab: Tab; active?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<RdpSession | null>(null)
  const [engine, setEngine] = useState<'ironrdp' | 'freerdp'>(navigator.platform.startsWith('Win') ? 'freerdp' : 'ironrdp')
  const [legacySecurity, setLegacySecurity] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [launchingSystem, setLaunchingSystem] = useState(false)
  const [hasConnected, setHasConnected] = useState(false)
  const [clipboardError, setClipboardError] = useState('')
  const [clipboardEnabled, setClipboardEnabled] = useState(false)
  const [fileTransfer, setFileTransfer] = useState<RdpFileTransferStatus | null>(null)
  const transportRef = useRef<string | undefined>(undefined)
  const pasteClipboardRef = useRef<(() => void) | null>(null)
  const activeRef = useRef(active)
  const resumeLegacyCheckRef = useRef<(() => void) | null>(null)
  activeRef.current = active
  useEffect(() => {
    if (active) resumeLegacyCheckRef.current?.()
    if (!active && engine === 'freerdp' && transportRef.current) void window.omnidesk.rdp.clipboardFiles(transportRef.current, 'cancel-paste')
  }, [active, engine])
  const updateTab = useApp((state) => state.updateTab)

  useEffect(() => {
    updateTab(tab.id, { status: phase === 'live' ? 'connected' : phase === 'error' ? 'error' :
      ['preparing', 'loading', 'connecting'].includes(phase) ? 'connecting' : 'idle', error: phase === 'error' ? error : undefined })
  }, [phase, error, tab.id, updateTab])

  const connections = useApp((s) => s.connections)
  const connection = connections.find((c) => c.id === tab.connectionId)

  useEffect(() => {
    if (fileTransfer?.state !== 'complete') return
    const timeout = window.setTimeout(() => {
      setFileTransfer(current => current === fileTransfer ? null : current)
    }, 3000)
    return () => window.clearTimeout(timeout)
  }, [fileTransfer])

  /* ---------------- 建立会话 ---------------- */
  useEffect(() => {
    if (!tab.connectionId || !canvasRef.current) return

    let disposed = false
    let abandoned = false
    let transportId: string | undefined
    let builder: RdpSessionBuilder | undefined
    let ownedSession: RdpSession | undefined
    let ownedRuntime: RdpModule | undefined
    let inputCleanup: (() => void) | undefined
    let sessionEstablished = false
    let clipboardBridge: RdpClipboard | undefined
    const api = window.omnidesk

    const boot = async () => {
      setPhase('preparing')
      setError('')
      setHasConnected(false)
      setClipboardError('')
      setFileTransfer(null)
      setClipboardEnabled(false)
      setHint('正在准备传输通道…')

      // 1) 主进程开通 WS ↔ TCP 代理
      const prepared = await api.rdp.prepare(tab.connectionId!)
      if (disposed) {
        if (prepared.ok) void api.rdp.release(prepared.data.transport.sessionId)
        return
      }
      if (!prepared.ok) {
        setPhase('error')
        setError(prepared.message)
        return
      }
      transportId = prepared.data.transport.sessionId
      transportRef.current = transportId
      setEngine(prepared.data.engine ?? 'ironrdp')
      setLegacySecurity(prepared.data.options.securityMode === 'legacy')
      const { transport, username, password, domain, options, destination } = prepared.data
      setClipboardEnabled(options.enableClipboard !== false)

      // 2) 加载 WASM
      setPhase('loading')
      setHint(prepared.data.engine === 'freerdp' ? '正在准备本机 FreeRDP 引擎…' : '正在加载 RDP 协议栈（首次约 5MB）…')

      let mod: RdpModule
      try {
        mod = await loadRuntime(prepared.data.engine)
        ownedRuntime = mod
      } catch (caught) {
        if (disposed) return
        setPhase('error')
        setError(
          `RDP 协议模块加载失败：${caught instanceof Error ? caught.message : String(caught)}。可重试或使用系统远程桌面客户端。`
        )
        return
      }
      if (disposed) return

      // 3) 建立会话
      setPhase('connecting')
      setHint('正在与远端协商…')

      try {
        const canvas = canvasRef.current!
        builder = new mod.SessionBuilder()
        builder
          .username(username)
          .password(password)
          .destination(destination)
          .proxyAddress(transport.wsUrl)
          .authToken(transport.token)
          .renderCanvas(canvas)
          .setCursorStyleCallbackContext(canvas)
          .setCursorStyleCallback((kind: string, data?: string, x = 0, y = 0) => {
            if (kind === 'url' && data?.startsWith('data:image/png;base64,')) {
              canvas.style.cursor = `url("${data}") ${Math.round(x)} ${Math.round(y)}, default`
            } else canvas.style.cursor = kind === 'hidden' ? 'none' : 'default'
          })

        if (domain) builder.serverDomain(domain)

        /*
         * 扩展启用。
         *
         * 【enable_credssp 是必须的，别删】
         * Windows 11（以及开了 NLA 的 Win10/Server）强制要求 CredSSP 网络级身份验证。
         * 不启用这一项，协商会在认证阶段直接失败，而 IronRDP 只会回报一个
         * 笼统的「通用错误」—— 从界面上完全看不出是缺了这一步。
         * 实测该扩展名来自 WASM 内部标识，拼错不会报错、只会静默不生效。
         */
        builder.extension(mod.enableCredssp(true))

        // 动态分辨率（Display Control 虚拟通道）
        builder.extension(mod.displayControl(options.dynamicResolution !== false))

        const rect = containerRef.current?.getBoundingClientRect()
        const display = rdpDisplaySize(rect?.width ?? 1280, rect?.height ?? 720, window.devicePixelRatio, options.performanceMode as RdpOptions['performanceMode'])
        builder.desktopSize(new mod.DesktopSize(display.width, display.height))

        // 剪贴板：远端 → 本地
        if (options.enableClipboard !== false) {
          builder.forceClipboardUpdateCallback(() => { void clipboardBridge?.sync(true) })
          builder.remoteClipboardChangedCallback((data: unknown) => {
            try {
              const items = (
                data as { items?: () => Array<{ mimeType(): string; value(): unknown }> }
              )?.items?.()
              const textItem = items?.find((i) => i.mimeType().startsWith('text/'))
              const fileItem = items?.find(item => item.mimeType() === 'application/x-omnidesk-file-transfer')
              if (fileItem) {
                const status = fileItem.value() as RdpFileTransferStatus
                if (disposed) return
                if (status.state === 'available' || status.state === 'unavailable') clipboardBridge?.receiveFormats()
                if (status.state === 'available' || status.state === 'unavailable') {
                  setFileTransfer(current => current?.direction === 'upload' && ['ready', 'progress'].includes(current.state) ? current : null)
                  if (status.state === 'available' && activeRef.current && transportId) void api.rdp.clipboardFiles(transportId, 'offer').then(result => { if (!result.ok && !disposed) setClipboardError(result.message) })
                } else setFileTransfer(status)
              }
              if (textItem) {
                const v = textItem.value()
                void clipboardBridge?.receive(typeof v === 'string' ? v : String(v))
              }
            } catch {
              /* 剪贴板失败不影响会话 */
            }
          })
        }

        const pending = builder.connect()
        void pending.then((session) => {
          if (disposed || abandoned) session.shutdown()
          if (abandoned) session.free()
        }).catch(() => {})
        const session = await withTimeout(
          pending,
          120_000,
          '与远端协商超时；如有证书确认窗口，请先核对并确认服务器身份'
        )
        if (disposed) {
          session.shutdown()
          session.free()
          return
        }
        sessionRef.current = session
        ownedSession = session
        if (options.enableClipboard !== false) {
          clipboardBridge = createRdpClipboard({
            canSync: () => !disposed && activeRef.current && sessionRef.current === session && document.hasFocus() && (document.activeElement === canvas || document.activeElement === keyboardRef.current),
            readText: async () => {
              const result = await api.rdp.readClipboard(transport.sessionId)
              if (!result.ok) throw new Error(result.message)
              return result.data
            },
            writeText: async text => {
              const result = await api.rdp.writeClipboard(transport.sessionId, text)
              if (!result.ok) throw new Error(result.message)
            },
            publishText: async text => {
              const content = new mod.ClipboardData()
              try { content.addText('text/plain', text); await session.onClipboardPaste(content) }
              finally { content.free() }
            },
            preparePaste: prepared.data.engine === 'freerdp' ? async () => {
              const result = await api.rdp.clipboardFiles(transport.sessionId, 'paste')
              if (!result.ok) throw new Error(result.message)
              return result.data
            } : undefined,
            cancelPaste: prepared.data.engine === 'freerdp' ? () => { void api.rdp.clipboardFiles(transport.sessionId, 'cancel-paste') } : undefined,
            onError: setClipboardError
          })
        }
        sessionEstablished = true
        setHasConnected(true)
        setPhase('live')
        setHint('')
        requestAnimationFrame(() => { if (activeRef.current && sessionRef.current === session) canvas.focus() })
        attachInput(canvas, session, mod, options.dynamicResolution !== false, options.enableClipboard !== false, options.performanceMode as RdpOptions['performanceMode'], clipboardBridge)
        inputCleanup = cleanupRef.current ?? undefined

        // run() 会一直跑渲染循环，直到会话结束
        const info = await session.run()
        const reason = info.reason()
        info.free()
        inputCleanup?.()
        if (cleanupRef.current === inputCleanup) cleanupRef.current = null
        if (!disposed) {
          setPhase('ended')
          setHint(reason)
        }
      } catch (e) {
        if (disposed) return
        abandoned = true
        const diagnostic = transportId ? await api.rdp.getError(transportId) : null
        if (disposed) return
        const detail = !sessionEstablished && diagnostic?.ok && diagnostic.data ? diagnostic.data : describeRdpError(e)
        let compatibility = ''
        if (!sessionEstablished && prepared.data.engine === 'freerdp' && options.securityMode !== 'legacy' && transportId && canProbeLegacyRdp(detail)) {
          while (!disposed && !activeRef.current) {
            setPhase('error')
            setError(`${detail}\n\n切回此标签后将检测旧版安全层兼容性；不会未经确认降低安全层。`)
            setHint('连接失败，切回此标签后将检测旧版安全层兼容性…')
            await new Promise<void>(resolve => { resumeLegacyCheckRef.current = resolve })
            resumeLegacyCheckRef.current = null
          }
          if (disposed) return
          setPhase('connecting')
          setHint('正在确认服务器是否仅支持旧版安全层…')
          const retry = await api.rdp.retryLegacy(tab.connectionId!, transportId)
          if (disposed) return
          if (retry.ok && retry.data === 'accepted') {
            const refreshed = await api.connections.list()
            if (disposed) return
            if (refreshed.ok) useApp.getState().setConnections(refreshed.data)
            setAttempt(value => value + 1)
            return
          }
          compatibility = !retry.ok ? `兼容检测未确认旧版兼容需求，未切换安全层：\n${retry.message}\n可点击「重试」重新连接并检测。` :
            retry.data === 'not-required' ? '兼容检测：服务器接受 TLS / NLA 协商，未发现仅支持旧版安全层的证据，保留当前安全设置。请继续排查 TLS 握手失败原因。' :
              retry.data === 'declined' ? '已取消切换旧版安全层，保留 TLS / NLA；未使用旧版模式发送登录凭据。' :
                '兼容检测已取消或当前会话不再满足检测条件，未切换安全层；可点击「重试」重新连接。'
        }
        setPhase('error')
        const guidance = friendlyRdpError(detail)
        setError(
          (sessionEstablished ? '远程桌面已成功连接，但在运行过程中中断。\n\n' :
            `目标可达（${connection?.host}:${connection?.port} 已通过连通性检查），但远程桌面会话建立失败。\n\n`) +
            `${detail}\n\n` +
            `${guidance !== detail ? `${guidance}\n\n` : ''}` +
            (compatibility ? `${compatibility}\n\n` : '') +
            (sessionEstablished ? '可以重试连接；运行时显示错误不代表 TLS / NLA 认证失败。' : /SSL_NOT_ALLOWED_BY_SERVER|STANDARD_RDP_SECURITY/.test(detail) ?
              '目标只接受旧版安全层。需同意兼容提示后才能切换；忽略证书错误或修改密码不会解决。也可点击「用系统远程桌面打开」。' :
              'TCP 端口可达不代表 TLS / NLA 认证成功。请按上方具体错误检查；不要为了绕过认证而关闭服务器的 NLA。')
        )
        setHint('')
      } finally {
        clipboardBridge?.dispose()
        inputCleanup?.()
        if (cleanupRef.current === inputCleanup) cleanupRef.current = null
        if (sessionRef.current === ownedSession) sessionRef.current = null
        ownedSession?.free()
        ownedSession = undefined
        builder?.free()
      }
    }

    void boot().catch((caught) => {
      if (!disposed) { setPhase('error'); setError(describeRdpError(caught)); setHint('') }
    }).finally(() => {
      ownedRuntime?.runtime.dispose()
      if (transportId) void api.rdp.release(transportId)
    })

    return () => {
      if (transportRef.current === transportId) transportRef.current = undefined
      disposed = true
      resumeLegacyCheckRef.current?.()
      resumeLegacyCheckRef.current = null
      cleanupRef.current?.()
      cleanupRef.current = null
      try {
        ownedSession?.shutdown()
      } catch {
        /* ignore */
      }
      sessionRef.current = null
      if (transportId) void api.rdp.release(transportId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.connectionId, attempt])

  /* ---------------- 键鼠接线 ---------------- */
  const cleanupRef = useRef<(() => void) | null>(null)

  const attachInput = (canvas: HTMLCanvasElement, session: RdpSession, mod: RdpModule, dynamicResolution: boolean, enableClipboard: boolean, performanceMode?: RdpOptions['performanceMode'], clipboardBridge?: RdpClipboard) => {
    const { DeviceEvent, InputTransaction } = mod

    /** 把一批事件打包成一个事务提交，减少跨 WASM 边界的往返 */
    const commit = (events: RdpDeviceEvent[]) => {
      if (events.length === 0) return
      const tx = new InputTransaction()
      for (const ev of events) tx.addEvent(ev)
      session.applyInputs(tx)
    }

    const suppressedPasteKeys = new Set<string>()
    const heldModifiers = new Set<string>()
    const pressedKeys = new Map<string, number | string>()
    const keyboard = document.createElement('textarea')
    keyboard.className = 'desktop-keyboard-input'
    keyboard.setAttribute('aria-label', '远程桌面键盘输入')
    keyboard.setAttribute('autocomplete', 'off')
    keyboard.setAttribute('autocapitalize', 'off')
    keyboard.spellcheck = false
    keyboard.tabIndex = -1
    canvas.parentElement!.appendChild(keyboard)
    keyboardRef.current = keyboard
    let composing = false
    let compositionEnding = false
    let committedText = ''
    let compositionTimer: ReturnType<typeof setTimeout> | undefined
    const ownsFocus = () => document.activeElement === canvas || document.activeElement === keyboard
    const canType = () => activeRef.current && sessionRef.current === session && ownsFocus() && document.hasFocus()
    const sendText = (text: string) => {
      if (!text || !canType()) return
      for (const character of text.replace(/\r\n?/g, '\n')) {
        const scancode = character === '\n' ? scancodeFor('Enter') : character === '\t' ? scancodeFor('Tab') : null
        commit(scancode === null ? [DeviceEvent.unicodePressed(character), DeviceEvent.unicodeReleased(character)] : [DeviceEvent.keyPressed(scancode), DeviceEvent.keyReleased(scancode)])
      }
    }
    const paste = (preserveShift = false) => {
      keyboard.focus({ preventScroll: true })
      void clipboardBridge?.paste(() => {
        const control = scancodeFor('ControlLeft')!
        const pasteKey = scancodeFor('KeyV')!
        const shifts = [...heldModifiers].filter(code => code.startsWith('Shift')).map(code => scancodeFor(code)!)
        const temporaryShift = preserveShift && !shifts.length ? scancodeFor('ShiftLeft')! : undefined
        const events: RdpDeviceEvent[] = []
        if (!preserveShift) events.push(...shifts.map(code => DeviceEvent.keyReleased(code)))
        if (temporaryShift !== undefined) events.push(DeviceEvent.keyPressed(temporaryShift))
        events.push(DeviceEvent.keyPressed(control), DeviceEvent.keyPressed(pasteKey), DeviceEvent.keyReleased(pasteKey))
        if (!heldModifiers.has('ControlLeft')) events.push(DeviceEvent.keyReleased(control))
        if (temporaryShift !== undefined) events.push(DeviceEvent.keyReleased(temporaryShift))
        if (!preserveShift) events.push(...shifts.map(code => DeviceEvent.keyPressed(code)))
        commit(events)
      })
    }
    if (clipboardBridge) pasteClipboardRef.current = paste

    /* 键盘 */
    const onKeyDown = (e: KeyboardEvent) => {
      if (!canType()) return
      if (composing || e.isComposing || e.keyCode === 229 || e.key === 'Process') return
      compositionEnding = false
      const modifier = /^(Control|Shift|Alt|Meta)/.test(e.code)
      e.preventDefault()
      e.stopPropagation()
      if (enableClipboard && clipboardBridge && !e.altKey && !e.metaKey && ((e.ctrlKey && e.code === 'KeyV') || (e.shiftKey && e.code === 'Insert'))) {
        suppressedPasteKeys.add(e.code)
        if (!e.repeat) paste(e.ctrlKey && e.shiftKey && e.code === 'KeyV')
        return
      }

      if (shouldUseUnicode(e)) {
        commit([DeviceEvent.unicodePressed(e.key)])
        pressedKeys.set(e.code || e.key, e.key)
        return
      }
      const scancode = scancodeFor(e.code)
      if (scancode != null) {
        commit([DeviceEvent.keyPressed(scancode)])
        pressedKeys.set(e.code || e.key, scancode)
        if (modifier) heldModifiers.add(e.code)
      }
    }

    const onKeyUp = (e: KeyboardEvent) => {
      heldModifiers.delete(e.code)
      if (suppressedPasteKeys.delete(e.code)) { e.preventDefault(); return }
      const key = e.code || e.key
      const pressed = pressedKeys.get(key)
      if (pressed === undefined) return
      pressedKeys.delete(key)
      e.preventDefault()
      e.stopPropagation()
      commit([typeof pressed === 'string' ? DeviceEvent.unicodeReleased(pressed) : DeviceEvent.keyReleased(pressed)])
    }

    const onCompositionStart = () => {
      composing = true
      compositionEnding = false
      clearTimeout(compositionTimer)
      commit([...pressedKeys.values()].map(pressed => typeof pressed === 'string' ? DeviceEvent.unicodeReleased(pressed) : DeviceEvent.keyReleased(pressed)))
      pressedKeys.clear()
      heldModifiers.clear()
    }
    const onCompositionEnd = (event: CompositionEvent) => {
      const wasComposing = composing
      composing = false
      compositionEnding = true
      committedText = event.data
      clearTimeout(compositionTimer)
      compositionTimer = setTimeout(() => { compositionEnding = false }, 0)
      if (wasComposing) sendText(event.data)
      keyboard.value = ''
    }
    const onInput = (event: Event) => {
      const input = event as InputEvent
      if (composing || input.isComposing) return
      if (!(compositionEnding && input.data === committedText) && (input.inputType === 'insertText' || input.inputType === 'insertReplacementText')) sendText(input.data ?? '')
      if (input.inputType === 'insertLineBreak' || input.inputType === 'insertParagraph') sendText('\n')
      compositionEnding = false
      keyboard.value = ''
    }
    const onBeforeInput = (event: InputEvent) => {
      if (composing || event.isComposing || !event.cancelable) return
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
        event.preventDefault()
        if (!(compositionEnding && event.data === committedText)) sendText(event.data ?? '')
        keyboard.value = ''
      } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault()
        sendText('\n')
      }
    }

    /* 鼠标 */
    let lastX = -1
    let lastY = -1
    const pressedButtons = new Set<number>()
    let capturedPointer: number | undefined
    const wheelRemainder = { horizontal: 0, vertical: 0 }
    const canPoint = () => activeRef.current && sessionRef.current === session && document.hasFocus()

    /** 把 CSS 坐标换算成远端桌面坐标 */
    const toRemote = (e: MouseEvent): { x: number; y: number; inside: boolean } => {
      const rect = canvas.getBoundingClientRect()
      const width = Math.max(1, canvas.width)
      const height = Math.max(1, canvas.height)
      const fit = Math.min(Math.max(1, rect.width) / width, Math.max(1, rect.height) / height)
      const remoteX = (e.clientX - rect.left - (rect.width - width * fit) / 2) / fit
      const remoteY = (e.clientY - rect.top - (rect.height - height * fit) / 2) / fit
      return { x: Math.max(0, Math.min(width - 1, Math.floor(remoteX))),
        y: Math.max(0, Math.min(height - 1, Math.floor(remoteY))),
        inside: remoteX >= 0 && remoteX < width && remoteY >= 0 && remoteY < height }
    }

    const onMouseMove = (e: PointerEvent) => {
      if (!canPoint()) return
      const { x, y, inside } = toRemote(e)
      if (!inside && !pressedButtons.size) return
      const events: RdpDeviceEvent[] = []
      if (x !== lastX || y !== lastY) events.push(DeviceEvent.mouseMove(x, y))
      lastX = x
      lastY = y
      if (pressedButtons.size) {
        for (const [button, mask] of [1, 4, 2, 8, 16].entries()) {
          const pressed = (e.buttons & mask) !== 0
          if (pressed === pressedButtons.has(button)) continue
          if (pressed) pressedButtons.add(button)
          else pressedButtons.delete(button)
          events.push(pressed ? DeviceEvent.mouseButtonPressed(button) : DeviceEvent.mouseButtonReleased(button))
        }
      }
      commit(events)
    }

    const releaseButtons = () => {
      const events = [...pressedButtons].map((button) => DeviceEvent.mouseButtonReleased(button))
      pressedButtons.clear()
      capturedPointer = undefined
      commit(events)
    }

    const onMouseDown = (e: PointerEvent) => {
      e.preventDefault()
      if (!canPoint()) return
      const bounds = keyboard.parentElement!.getBoundingClientRect()
      keyboard.style.left = `${Math.max(0, Math.min(bounds.width - 2, e.clientX - bounds.left))}px`
      keyboard.style.top = `${Math.max(0, Math.min(bounds.height - 20, e.clientY - bounds.top))}px`
      keyboard.focus({ preventScroll: true })
      const btn = mouseButtonFor(e.button)
      if (btn == null) return
      const { x, y, inside } = toRemote(e)
      if (!inside) return
      try { canvas.setPointerCapture(e.pointerId); capturedPointer = e.pointerId } catch {}
      // 按下前先同步一次位置，避免在旧位置点击
      lastX = x
      lastY = y
      pressedButtons.add(btn)
      commit([DeviceEvent.mouseMove(x, y), DeviceEvent.mouseButtonPressed(btn)])
    }

    const onMouseUp = (e: PointerEvent) => {
      const btn = mouseButtonFor(e.button)
      if (btn == null || !pressedButtons.delete(btn)) return
      e.preventDefault()
      const { x, y } = toRemote(e)
      lastX = x
      lastY = y
      commit([DeviceEvent.mouseMove(x, y), DeviceEvent.mouseButtonReleased(btn)])
      if (!pressedButtons.size && capturedPointer !== undefined) {
        const pointer = capturedPointer
        capturedPointer = undefined
        try { canvas.releasePointerCapture(pointer) } catch {}
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!canPoint() || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return
      const { x, y, inside } = toRemote(event)
      if (!inside) return
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? Math.max(1, canvas.clientHeight) * 1.2 : 1.2
      wheelRemainder.horizontal += Math.max(-12000, Math.min(12000, event.deltaX * scale))
      wheelRemainder.vertical -= Math.max(-12000, Math.min(12000, event.deltaY * scale))
      const events: RdpDeviceEvent[] = []
      for (const axis of ['horizontal', 'vertical'] as const) {
        let amount = Math.trunc(wheelRemainder[axis])
        wheelRemainder[axis] -= amount
        while (amount) {
          const step = Math.max(-240, Math.min(240, amount))
          events.push(DeviceEvent.wheelRotations(axis === 'vertical', step, 0))
          amount -= step
        }
      }
      if (!events.length) return
      lastX = x
      lastY = y
      commit([DeviceEvent.mouseMove(x, y), ...events])
    }

    const onContextMenu = (e: MouseEvent) => e.preventDefault()
    const onAuxClick = (event: MouseEvent) => event.preventDefault()
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault()
      if (!enableClipboard || !clipboardBridge) return
      paste()
    }
    const onFocus = () => {
      if (document.activeElement === canvas) keyboard.focus({ preventScroll: true })
      if (ownsFocus()) void clipboardBridge?.sync()
    }

    // 失焦时释放全部按键，避免远端"按键卡住"
    const onBlur = (event?: FocusEvent) => {
      if (event?.relatedTarget === canvas || event?.relatedTarget === keyboard) return
      clipboardBridge?.cancelPending()
      heldModifiers.clear()
      suppressedPasteKeys.clear()
      pressedKeys.clear()
      composing = false
      compositionEnding = false
      clearTimeout(compositionTimer)
      keyboard.value = ''
      pressedButtons.clear()
      const pointer = capturedPointer
      capturedPointer = undefined
      if (pointer !== undefined) {
        try { canvas.releasePointerCapture(pointer) } catch {}
      }
      lastX = -1
      lastY = -1
      wheelRemainder.horizontal = 0
      wheelRemainder.vertical = 0
      try {
        session.releaseAllInputs()
      } catch {
        /* ignore */
      }
    }

    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('pointermove', onMouseMove)
    canvas.addEventListener('pointerdown', onMouseDown)
    window.addEventListener('pointerup', onMouseUp)
    canvas.addEventListener('pointercancel', releaseButtons)
    canvas.addEventListener('lostpointercapture', releaseButtons)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('auxclick', onAuxClick)
    canvas.addEventListener('paste', onPaste)
    canvas.addEventListener('focus', onFocus)
    window.addEventListener('focus', onFocus)
    canvas.addEventListener('blur', onBlur)
    keyboard.addEventListener('keydown', onKeyDown)
    keyboard.addEventListener('keyup', onKeyUp)
    keyboard.addEventListener('compositionstart', onCompositionStart)
    keyboard.addEventListener('compositionend', onCompositionEnd)
    keyboard.addEventListener('input', onInput)
    keyboard.addEventListener('beforeinput', onBeforeInput)
    keyboard.addEventListener('paste', onPaste)
    keyboard.addEventListener('focus', onFocus)
    keyboard.addEventListener('blur', onBlur)
    window.addEventListener('blur', onBlur)
    canvas.tabIndex = 0

    // 容器尺寸变化 → 通知远端调整分辨率
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let resizeRetryTimer: ReturnType<typeof setTimeout> | undefined
    let lastDisplay = ''
    let resizeAttempts = 0
    const scheduleResize = () => {
      clearTimeout(resizeTimer)
      clearTimeout(resizeRetryTimer)
      if (!dynamicResolution) return
      resizeTimer = setTimeout(() => {
        if (sessionRef.current !== session || !activeRef.current) return
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect || rect.width < 50 || rect.height < 50) return
        const display = rdpDisplaySize(rect.width, rect.height, window.devicePixelRatio, performanceMode)
        const layout = `${display.width}:${display.height}:${display.scaleFactor}`
        if (layout !== lastDisplay) resizeAttempts = 0
        const matchesCanvas = canvas.width === display.width && canvas.height === display.height
        if (layout === lastDisplay && (matchesCanvas || resizeAttempts >= 6)) return
        try {
          session.resize(display.width, display.height, display.scaleFactor)
          lastDisplay = layout
          resizeAttempts++
          if (!matchesCanvas && resizeAttempts < 6) {
            resizeRetryTimer = setTimeout(scheduleResize, Math.min(8000, 500 * 2 ** (resizeAttempts - 1)))
          }
        } catch {}
      }, 120)
    }
    const ro = new ResizeObserver(scheduleResize)
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener('resize', scheduleResize)
    document.addEventListener('fullscreenchange', scheduleResize)

    cleanupRef.current = () => {
      onBlur()
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('pointermove', onMouseMove)
      canvas.removeEventListener('pointerdown', onMouseDown)
      window.removeEventListener('pointerup', onMouseUp)
      canvas.removeEventListener('pointercancel', releaseButtons)
      canvas.removeEventListener('lostpointercapture', releaseButtons)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('auxclick', onAuxClick)
      canvas.removeEventListener('paste', onPaste)
      canvas.removeEventListener('focus', onFocus)
      window.removeEventListener('focus', onFocus)
      clipboardBridge?.dispose()
      if (pasteClipboardRef.current === paste) pasteClipboardRef.current = null
      canvas.removeEventListener('blur', onBlur)
      keyboard.removeEventListener('keydown', onKeyDown)
      keyboard.removeEventListener('keyup', onKeyUp)
      keyboard.removeEventListener('compositionstart', onCompositionStart)
      keyboard.removeEventListener('compositionend', onCompositionEnd)
      keyboard.removeEventListener('input', onInput)
      keyboard.removeEventListener('beforeinput', onBeforeInput)
      keyboard.removeEventListener('paste', onPaste)
      keyboard.removeEventListener('focus', onFocus)
      keyboard.removeEventListener('blur', onBlur)
      keyboard.remove()
      if (keyboardRef.current === keyboard) keyboardRef.current = null
      window.removeEventListener('blur', onBlur)
      ro.disconnect()
      window.removeEventListener('resize', scheduleResize)
      document.removeEventListener('fullscreenchange', scheduleResize)
      clearTimeout(resizeTimer)
      clearTimeout(resizeRetryTimer)
    }
  }

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [])

  const launchSystemClient = async () => {
    if (!tab.connectionId || launchingSystem) return
    setLaunchingSystem(true)
    try {
      const res = await window.omnidesk.rdp.launchSystemClient(tab.connectionId)
      if (!res.ok) throw new Error(res.message)
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法启动系统远程桌面客户端')
      setPhase('error')
    } finally {
      setLaunchingSystem(false)
    }
  }

  const busy = phase === 'preparing' || phase === 'loading' || phase === 'connecting'

  return (
    <div className="desktop-workspace">
      <SessionToolbar active={active}><div className="toolbar session-toolbar"><span className="session-protocol rdp" title={engine === 'freerdp' ? '本机 FreeRDP 独立进程' : 'IronRDP WASM'}><Icon name="monitor" size={16} /> {engine === 'freerdp' ? 'FreeRDP' : 'RDP'}</span>
        <div className="session-address"><strong title={connection?.name}>{connection?.name}</strong><span className="mono" title={connection && formatConnectionAddress(connection.host, connection.port)}>{connection && formatConnectionAddress(connection.host, connection.port)}</span></div>
        {legacySecurity && <span className="session-state" title="此连接已获准使用旧版 RDP 安全层，不使用 TLS / NLA；可在连接配置中改回推荐模式">旧版安全层</span>}
        <span className={`session-state ${phase === 'live' ? 'is-connected' : ''}`}><span className={`dot ${phase === 'live' ? 'dot-connected' : busy ? 'dot-connecting' : 'dot-idle'}`} />{phase === 'live' ? '已连接' : busy ? '连接中' : '未连接'}</span>
        <span className="toolbar-spacer" /><button className="btn btn-ghost btn-sm" disabled={phase !== 'live' || !clipboardEnabled} title={!clipboardEnabled ? '当前会话未开启剪贴板重定向，请在连接配置中开启并重新连接' : engine === 'freerdp' ? '粘贴本机复制的文字、文件或文件夹；也支持 Ctrl+V / Shift+Insert' : '同步本机文本剪贴板，再向远端发送 Ctrl+V；也可以直接按 Ctrl+V 或 Shift+Insert'} onClick={() => pasteClipboardRef.current?.()}>{engine === 'freerdp' ? '粘贴' : '粘贴文本'}</button><button className="btn btn-ghost btn-sm" disabled={launchingSystem} title="使用已保存的连接或公共凭据登录；系统策略可能仍要求确认" onClick={launchSystemClient}>{launchingSystem ? '正在启动…' : '系统客户端 ↗'}</button>
        <button className="btn btn-ghost btn-icon" title="全屏远程桌面" onClick={() => void containerRef.current?.requestFullscreen()}><Icon name="expand" size={16} /></button></div></SessionToolbar>
    <div className="desktop-stage" ref={containerRef}>
      {clipboardError && phase === 'live' && <div className="desktop-clipboard-notice" role="alert">{clipboardError}<button className="btn btn-ghost btn-sm" onClick={() => setClipboardError('')}>关闭</button></div>}
      {fileTransfer && phase === 'live' && !clipboardError && <FileTransferNotice status={fileTransfer} onCancel={() => { if (transportRef.current) void window.omnidesk.rdp.clipboardFiles(transportRef.current, 'cancel') }} onDismiss={() => setFileTransfer(null)} />}
      <canvas
        ref={canvasRef}
        className="desktop-canvas"
        style={{ display: phase === 'live' ? 'block' : 'none' }}
      />

      {phase !== 'live' && (
        <div className="desktop-overlay">
          {busy && (
            <>
              <div className="spinner" />
              <div style={{ fontWeight: 500 }}>
                {phase === 'preparing' && '准备传输通道'}
                {phase === 'loading' && '加载协议栈'}
                {phase === 'connecting' && '协商会话'}
              </div>
              {hint && <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{hint}</div>}
            </>
          )}

          {phase === 'idle' && <div style={{ color: 'var(--text-secondary)' }}>等待开始</div>}

          {phase === 'ended' && (
            <>
              <div style={{ fontSize: 26 }}>⏻</div>
              <div style={{ fontWeight: 500 }}>会话已结束</div>
              {hint && (
                <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }} className="mono">
                  {hint}
                </div>
              )}
              <button className="btn btn-primary" onClick={() => setAttempt((value) => value + 1)}>
                重新连接
              </button>
            </>
          )}

          {phase === 'error' && (
            <>
              <div style={{ fontSize: 26 }}>⚠</div>
              <div style={{ fontWeight: 500 }}>{hasConnected ? '远程桌面会话已中断' : '无法建立远程桌面'}</div>
              <div
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: 12.5,
                  maxWidth: 520,
                  lineHeight: 1.75,
                  // 报错是多行的，保留换行
                  whiteSpace: 'pre-wrap',
                  textAlign: 'left'
                }}
              >
                {error}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn" onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </button>
                <button className="btn btn-primary" disabled={launchingSystem} onClick={launchSystemClient}>
                  {launchingSystem ? '正在同步凭据并启动…' : '用系统远程桌面打开'}
                </button>
              </div>
              {connection && (
                <div className="mono" style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>
                  {formatConnectionAddress(connection.host, connection.port)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div></div>
  )
}

/* ------------------------------------------------------------------ */

/** IronRDP 的错误分类（对应 IronErrorKind 枚举） */
const IRON_ERROR_KIND: Record<number, string> = {
  0: '通用错误',
  1: '密码错误',
  2: '登录失败',
  3: '权限不足，服务器拒绝访问',
  4: '传输层错误（RDCleanPath）',
  5: '无法连接到代理',
  6: '协议协商失败'
}

/** Windows 套接字错误码 → 人话 */
const WSA_TEXT: Record<number, string> = {
  10013: '权限被拒绝',
  10051: '网络不可达',
  10060: '连接超时',
  10061: '目标拒绝连接（端口未开放或服务未启动）',
  10065: '无法路由到主机'
}

/** TLS 警告码 → 人话 */
const TLS_ALERT_TEXT: Record<number, string> = {
  40: '握手失败（可能是协议版本不匹配）',
  42: '证书无效',
  45: '证书已过期',
  48: '未知的证书颁发机构（自签名证书常见）',
  112: '服务器名称不被识别'
}

/**
 * 把 IronRDP 抛出的错误转成人能看懂的文字。
 *
 * 为什么不能直接 String(err)：WASM 抛的是 IronError 包装对象而非 JS Error，
 * 直接转字符串会得到「[object Object]」—— 等于没有报错信息。
 * 它其实提供了 kind() / rdcleanpathDetails() / backtrace()，把这些读出来才有价值。
 */
function describeRdpError(e: unknown): string {
  if (e == null) return '未知错误（错误对象为空）'

  if (typeof e !== 'object') return String(e)

  const o = e as Record<string, unknown>
  const parts: string[] = []

  // 错误分类
  if (typeof o.kind === 'function') {
    try {
      const k = Number((o.kind as () => number)())
      parts.push(`类型：${IRON_ERROR_KIND[k] ?? `未知分类 ${k}`}`)
    } catch {
      /* 忽略 */
    }
  }

  // 传输层细节
  if (typeof o.rdcleanpathDetails === 'function') {
    try {
      const d = (o.rdcleanpathDetails as () => Record<string, unknown> | undefined)()
      if (d) {
        const bits: string[] = []
        if (d.httpStatusCode != null) bits.push(`HTTP ${d.httpStatusCode}`)
        if (d.wsaErrorCode != null) {
          const code = Number(d.wsaErrorCode)
          bits.push(`套接字 ${code}（${WSA_TEXT[code] ?? '未知'}）`)
        }
        if (d.tlsAlertCode != null) {
          const code = Number(d.tlsAlertCode)
          bits.push(`TLS 告警 ${code}（${TLS_ALERT_TEXT[code] ?? '未知'}）`)
        }
        if (bits.length) parts.push(`细节：${bits.join('；')}`)
      }
    } catch {
      /* 忽略 */
    }
  }

  // 普通 message
  if (typeof o.message === 'string' && o.message && o.message !== '[object Object]') {
    parts.push(o.message)
  }

  // 回退：堆栈前几行，至少能看出是哪里出的问题
  if (typeof o.backtrace === 'function') {
    try {
      const bt = String((o.backtrace as () => string)())
      if (bt) parts.push(bt.split('\n').slice(0, 6).join('\n').slice(0, 1400))
    } catch {
      /* 忽略 */
    }
  }

  if (parts.length > 0) return parts.join('\n')

  // 最后兜底：把可枚举属性列出来，总比 [object Object] 强
  try {
    const keys = Object.keys(o)
    if (keys.length) return `错误对象属性：${keys.join(', ')}`
  } catch {
    /* 忽略 */
  }

  return `无法解析的错误对象（${(o.constructor as { name?: string })?.name ?? '未知类型'}）`
}

/** 给 Promise 加超时，避免任何一步挂死导致界面永远转圈 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message}（${ms / 1000} 秒）`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
