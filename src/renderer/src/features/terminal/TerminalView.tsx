import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { useApp, type Tab } from '../../store/app'
import Icon from '../../components/Icon'
import SessionToolbar from '../../components/SessionToolbar'
import { formatConnectionAddress } from '@shared/connection-identity'
import TerminalSidebar from './TerminalSidebar'
import { REMOTE_PATH_MIME, remotePathArgument } from '../files/remote-path-drag'
import { TERMINAL_FONTS, terminalTheme, useAppearance } from '../../store/appearance'

const pendingShells = new Map<string, ReturnType<typeof window.omnidesk.ssh.connect>>()

export default function TerminalView({ tab, active = true }: { tab: Tab; active?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sessionIdRef = useRef<string | null>(tab.sessionId ?? null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pathDrag, setPathDrag] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState('')
  const fontSize = useAppearance(state => state.terminalFontSize)
  const fontFamily = useAppearance(state => state.terminalFont)
  const colorScheme = useAppearance(state => state.terminalTheme)
  const setPreferences = useAppearance(state => state.setPreferences)
  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 })
  const updateTab = useApp((state) => state.updateTab)
  const connection = useApp((state) => state.connections.find((item) => item.id === tab.connectionId))
  const session = useApp((state) => state.sessions.find((item) => item.id === tab.sessionId))
  const account = session?.username || (connection?.sharedCredentialId ? '共享账号' : connection?.username)

  const fitTerminal = () => {
    const element = containerRef.current
    if (!element || element.clientWidth < 40 || element.clientHeight < 40) return
    try { fitRef.current?.fit() } catch {}
  }

  const copy = async () => {
    const selected = termRef.current?.getSelection()
    if (!selected) { setNotice('先选中要复制的终端文本'); return }
    try { await navigator.clipboard.writeText(selected); setNotice('已复制选中文本') }
    catch { setNotice('无法访问剪贴板，请使用右键菜单或系统复制快捷键') }
  }

  const paste = async () => {
    if (status !== 'connected') return
    try {
      const text = await navigator.clipboard.readText()
      if (/\r?\n/.test(text.trim()) && !confirm('即将向远程终端粘贴多行内容，可能执行多条命令。确认粘贴？')) return
      termRef.current?.paste(text)
      termRef.current?.focus()
    } catch { setNotice('无法读取剪贴板，请使用系统粘贴快捷键') }
  }
  const actionsRef = useRef({ copy, paste })
  actionsRef.current = { copy, paste }

  const dropPath = (event: DragEvent) => {
    event.preventDefault()
    setPathDrag(false)
    if (!active || status !== 'connected' || !sessionIdRef.current) return
    if (!event.dataTransfer.types.includes(REMOTE_PATH_MIME)) {
      if (event.dataTransfer.files.length) setNotice('本地文件请使用上传；拖入终端仅支持远程文件路径')
      return
    }
    try {
      const text = remotePathArgument(event.dataTransfer.getData(REMOTE_PATH_MIME), sessionIdRef.current)
      termRef.current?.paste(text)
      termRef.current?.focus()
      setNotice('已插入远程路径，未执行命令')
    } catch (error) { setNotice(error instanceof Error ? error.message : '无法插入远程路径') }
  }

  useEffect(() => { setPathDrag(false) }, [active, status])

  useEffect(() => {
    if (!pathDrag) return
    const clear = () => setPathDrag(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [pathDrag])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!containerRef.current || !tab.connectionId) return
    let disposed = false
    let frame = 0
    const api = window.omnidesk
    const pendingOutput = new Map<string, Uint8Array[]>()
    let pendingBytes = 0
    const term = new Terminal({
      fontFamily: TERMINAL_FONTS[fontFamily].family,
      fontSize, lineHeight: 1.3, letterSpacing: 0, cursorBlink: false, cursorStyle: 'bar',
      scrollback: 10000, allowProposedApi: true, theme: terminalTheme()
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(search)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    const onParsed = term.onWriteParsed(() => {
      if (term.options.cursorBlink) term.options.cursorBlink = false
    })

    const offData = api.ssh.onData(({ sessionId, data }) => {
      if (sessionIdRef.current && sessionId !== sessionIdRef.current) return
      if (!sessionIdRef.current && pendingBytes >= 512 * 1024) return
      if (sessionId === sessionIdRef.current) term.write(data)
      else if (!sessionIdRef.current && pendingBytes < 512 * 1024) {
        const queued = pendingOutput.get(sessionId) ?? []
        queued.push(data)
        pendingOutput.set(sessionId, queued)
        pendingBytes += data.length
      }
    })
    const offClose = api.ssh.onClose(({ sessionId, reason }) => {
      if (sessionId !== sessionIdRef.current) return
      sessionIdRef.current = null
      term.write(`\r\n\x1b[38;5;244m连接已断开${reason ? `：${reason}` : ''}\x1b[0m\r\n`)
      setStatus('disconnected')
      updateTab(tab.id, { status: 'idle', sessionId: undefined })
    })
    const onData = term.onData((data) => {
      if (sessionIdRef.current) void api.ssh.write(sessionIdRef.current, data)
    })
    const onResize = term.onResize(({ cols, rows }) => {
      setDimensions({ cols, rows })
      if (sessionIdRef.current) void api.ssh.resize(sessionIdRef.current, cols, rows)
    })
    const onSearch = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResult(resultCount ? `${resultIndex + 1} / ${resultCount}` : '无匹配')
    })
    term.attachCustomKeyEventHandler((event) => {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && event.shiftKey && ['k', 'n'].includes(event.key.toLowerCase())) return false
      if (modifier && event.shiftKey && ['c', 'v', 'f'].includes(event.key.toLowerCase())) {
        if (event.type === 'keydown') {
          if (event.key.toLowerCase() === 'c') void actionsRef.current.copy()
          if (event.key.toLowerCase() === 'v') void actionsRef.current.paste()
          if (event.key.toLowerCase() === 'f') setSearchOpen(true)
        }
        event.preventDefault()
        return false
      }
      return true
    })
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (!disposed) fitTerminal() })
    })
    resize.observe(containerRef.current)
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    frame = requestAnimationFrame(() => {
      if (disposed) return
      fitTerminal()
      if (sessionIdRef.current) {
        setStatus('connected')
        if (activeRef.current) term.focus()
        return
      }
      setStatus('connecting')
      setError('')
      updateTab(tab.id, { status: 'connecting', error: undefined })
      let pending = pendingShells.get(tab.id)
      if (!pending) {
        pending = api.ssh.connect(tab.connectionId!, term.cols, term.rows, tab.id)
        pendingShells.set(tab.id, pending)
      }
      void pending.then((result) => {
        pendingShells.delete(tab.id)
        if (!useApp.getState().tabs.some((item) => item.id === tab.id)) {
          if (result.ok) void api.ssh.disconnect(result.data.id)
          return
        }
        if (disposed) return
        if (!result.ok) {
          setStatus('error')
          setError(result.message)
          updateTab(tab.id, { status: 'error', error: result.message })
          return
        }
        sessionIdRef.current = result.data.id
        for (const bytes of pendingOutput.get(result.data.id) ?? []) term.write(bytes)
        pendingOutput.clear()
        setStatus('connected')
        updateTab(tab.id, { status: 'connected', sessionId: result.data.id })
        void api.ssh.resize(result.data.id, term.cols, term.rows)
        if (activeRef.current) term.focus()
      }).catch((caught) => {
        pendingShells.delete(tab.id)
        if (disposed) return
        const message = caught instanceof Error ? caught.message : 'SSH 会话建立失败'
        setError(message)
        setStatus('error')
        updateTab(tab.id, { status: 'error', error: message })
      })
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      offData(); offClose(); onData.dispose(); onResize.dispose(); onSearch.dispose(); onParsed.dispose()
      resize.disconnect(); themeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [tab.id, tab.connectionId, attempt, updateTab])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => { fitTerminal(); if (!searchOpen) termRef.current?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [active, searchOpen])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize
      termRef.current.options.fontFamily = TERMINAL_FONTS[fontFamily].family
      termRef.current.options.theme = terminalTheme()
    }
    fitTerminal()
  }, [fontSize, fontFamily, colorScheme])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
    else searchRef.current?.clearDecorations()
  }, [searchOpen])

  const find = (value: string, previous = false) => {
    setQuery(value)
    if (!value) { searchRef.current?.clearDecorations(); setSearchResult(''); return }
    const options = { decorations: { matchBackground: '#35525b', matchBorder: '#6b9ba8', matchOverviewRuler: '#6b9ba8', activeMatchBackground: '#486e55', activeMatchBorder: '#89d6aa', activeMatchColorOverviewRuler: '#89d6aa' } }
    const found = previous ? searchRef.current?.findPrevious(value, options) : searchRef.current?.findNext(value, options)
    if (!found) setSearchResult('无匹配')
  }
  const reconnect = async () => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    if (sessionId) await window.omnidesk.ssh.disconnect(sessionId)
    updateTab(tab.id, { sessionId: undefined, status: 'idle', error: undefined })
    setAttempt((value) => value + 1)
  }

  return <div className="terminal-workspace">
    <SessionToolbar active={active}><div className="toolbar session-toolbar"><span className="session-protocol"><Icon name="terminal" size={16} />SSH</span>
      <div className="session-address"><strong title={connection?.name}>{connection?.name}</strong><span className="mono" title={connection && `${account}@${formatConnectionAddress(connection.host, connection.port)}`}>{account}@{connection && formatConnectionAddress(connection.host, connection.port)}</span></div>
      <span className={`session-state ${status === 'connected' ? 'is-connected' : ''}`}><span className={`dot ${status === 'connected' ? 'dot-connected' : status === 'connecting' ? 'dot-connecting' : status === 'error' ? 'dot-error' : 'dot-idle'}`} />{status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : status === 'error' ? '连接失败' : '已断开'}</span>
      <span className="toolbar-spacer" />
      <button className="btn btn-ghost btn-icon" title="搜索终端 (Ctrl+Shift+F)" aria-label="搜索终端" onClick={() => setSearchOpen((value) => !value)}><Icon name="search" size={16} /></button>
      <button className="btn btn-ghost btn-icon" title="复制选中内容 (Ctrl+Shift+C)" aria-label="复制选中内容" onClick={() => void copy()}><Icon name="copy" size={16} /></button>
      <button className="btn btn-ghost btn-sm" disabled={status !== 'connected'} title="粘贴 (Ctrl+Shift+V)" onClick={() => void paste()}>粘贴</button>
      <span className="toolbar-divider" /><div className="terminal-zoom"><button aria-label="缩小终端字号" disabled={fontSize <= 10} onClick={() => setPreferences({ terminalFontSize: fontSize - 1 })}>−</button><span>{fontSize}</span><button aria-label="放大终端字号" disabled={fontSize >= 24} onClick={() => setPreferences({ terminalFontSize: fontSize + 1 })}>＋</button></div>
      <button className="btn btn-ghost btn-sm" title="只清理本地终端显示，不向远端发送命令" onClick={() => termRef.current?.clear()}>清屏</button>
      <button className="btn btn-ghost btn-icon" disabled={status === 'connecting'} title="重新连接此终端" aria-label="重新连接此终端" onClick={() => void reconnect()}><Icon name="refresh" size={16} /></button>
    </div></SessionToolbar>
    {searchOpen && <div className="terminal-search"><Icon name="search" size={15} /><input ref={searchInputRef} aria-label="终端搜索内容" value={query} onChange={(event) => find(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false); if (event.key === 'Enter') { event.preventDefault(); find(query, event.shiftKey) } }} placeholder="搜索终端输出…" /><span>{searchResult}</span><button className="btn btn-ghost btn-sm" aria-label="上一个匹配" onClick={() => find(query, true)}>↑</button><button className="btn btn-ghost btn-sm" aria-label="下一个匹配" onClick={() => find(query)}>↓</button><button className="btn btn-ghost btn-icon" aria-label="关闭终端搜索" onClick={() => setSearchOpen(false)}><Icon name="close" size={14} /></button></div>}
    <div className="terminal-content"><div className={`terminal-body${pathDrag ? ' is-path-drop' : ''}`} onDragOver={event => {
      if (!event.dataTransfer.types.includes(REMOTE_PATH_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = active && status === 'connected' ? 'copy' : 'none'
      setPathDrag(active && status === 'connected')
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPathDrag(false) }} onDrop={dropPath}><div ref={containerRef} className="terminal-wrap" />
      {pathDrag && <div className="terminal-path-drop-hint"><Icon name="folder" size={18} /><strong>松开插入远程路径</strong><span>自动转义特殊字符 · 不执行命令</span></div>}
      {status === 'connecting' && <div className="pane-overlay"><div className="spinner" /><strong>正在建立安全会话</strong><span className="mono">{connection?.host}:{connection?.port}</span></div>}
      {status === 'error' && <div className="pane-overlay"><div className="feature-icon"><Icon name="terminal" size={26} /></div><strong>SSH 连接失败</strong><div className="session-error">{error}</div><button className="btn btn-primary" onClick={() => void reconnect()}>重新连接</button></div>}
    </div><TerminalSidebar tab={tab} active={active} connected={status === 'connected'} /></div>
    <div className="terminal-footer"><span className="mono">xterm-256color</span><span>UTF-8</span><span>{dimensions.cols} × {dimensions.rows}</span><span className="toolbar-spacer" /><span role="status">{notice || (status === 'disconnected' ? '连接已断开，点击右上方重新连接' : 'Ctrl+Shift+F 搜索 · Ctrl+Shift+C / V 复制粘贴')}</span></div>
  </div>
}
