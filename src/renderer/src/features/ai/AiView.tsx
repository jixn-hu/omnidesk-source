import { useCallback, useEffect, useRef, useState } from 'react'
import { AI_DEFAULT_MAX_MODEL_CALLS, aiPermissionModes, type AiConfiguration, type AiPermissionMode, type AiState } from '@shared/ai'
import { formatConnectionAddress, matchesConnection } from '@shared/connection-identity'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'
import AiSettings from './AiSettings'
import AiTranscript from './AiTranscript'
import AiHostKeyCard from './AiHostKeyCard'

const initial: AiState = { status: 'idle', messages: [], pending: null, selectedIds: [], scopeMode: 'all', scopeCount: 0, permissionMode: 'read', modelCalls: 0, maxModelCalls: AI_DEFAULT_MAX_MODEL_CALLS, revision: 0, conversationId: '', conversations: [] }
type Draft = { text: string; selected: string[]; query: string }
export default function AiView() {
  const connections = useApp(state => state.connections)
  const sessions = useApp(state => state.sessions)
  const hostKeyRequest = useApp(state => state.hostKeyRequest)
  const hostKeyQueue = useApp(state => state.hostKeyQueue)
  const [state, setState] = useState<AiState>(initial)
  const hasHostKey = (id: string) => [hostKeyRequest, ...hostKeyQueue].some(request => request && sessions.some(session => session.id === request.sessionId && session.ownerId?.startsWith('ai-' + id + '-')))
  const hostKey = [hostKeyRequest, ...hostKeyQueue].find(request => request && sessions.some(session => session.id === request.sessionId && session.ownerId?.startsWith('ai-' + state.conversationId + '-')))
  const [configuration, setConfiguration] = useState<AiConfiguration | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [settings, setSettings] = useState(false)
  const [ready, setReady] = useState(false)
  const [sendingId, setSendingId] = useState('')
  const latestRevision = useRef(-1)
  const drafts = useRef(new Map<string, Draft>())
  const live = useRef({ id: '', text: '', selected: [] as string[], query: '' })
  live.current = { id: state.conversationId, text, selected, query }
  const end = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const busy = state.status !== 'idle' || sendingId === state.conversationId
  const configured = !!configuration?.baseUrl && !!configuration?.model
  const canCreate = state.permissionMode !== 'read'
  const shown = connections.filter(connection => matchesConnection(connection, query))
  const available = selected.filter(id => connections.some(connection => connection.id === id))
  const permission = aiPermissionModes.find(mode => mode.value === state.permissionMode)!
  const examples = canCreate ? ['列出所有服务器，按分组整理给我看', '找到备注里有「代理池」的服务器，添加「已整理」标签', '新增一台 SSH 服务器连接资料'] : ['列出所有服务器，按分组整理给我看', '查找名称或备注中有「代理池」的服务器', '查看指定 IP 服务器的系统和资源状态']
  const acceptState = useCallback((next: AiState) => {
    if (next.revision <= latestRevision.current) return
    latestRevision.current = next.revision
    if (next.conversationId !== live.current.id) {
      if (live.current.id) drafts.current.set(live.current.id, { text: live.current.text, selected: live.current.selected, query: live.current.query })
      const draft = drafts.current.get(next.conversationId)
      setText(draft?.text ?? ''); setQuery(draft?.query ?? '')
      setSelected(next.status === 'idle' ? draft?.selected ?? next.selectedIds : next.selectedIds)
      setError('')
    } else if (next.status !== 'idle') setSelected(next.selectedIds)
    setState(next)
  }, [])
  useEffect(() => {
    let active = true, changed = false
    const unsubscribe = window.omnidesk.ai.onChange(next => {
      changed = true
      if (active) { acceptState(next); setReady(true) }
    })
    void window.omnidesk.ai.state().then(result => {
      if (!active) return
      if (result.ok && !changed) acceptState(result.data)
      else if (!result.ok) setError(result.message)
      setReady(true)
    })
    void window.omnidesk.ai.configuration().then(result => {
      if (active && result.ok) { setConfiguration(result.data); if (!result.data.baseUrl) setSettings(true) }
    })
    return () => { active = false; unsubscribe() }
  }, [acceptState])
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [state.conversationId, state.messages.length, state.status, state.pending?.id, hostKey?.sessionId])
  useEffect(() => {
    const element = transcript.current
    if (!element || !state.pending && !hostKey) return
    const observer = new ResizeObserver(() => { element.scrollTop = element.scrollHeight })
    observer.observe(element)
    return () => observer.disconnect()
  }, [state.pending?.id, hostKey?.sessionId])
  const send = async () => {
    if (busy || !text.trim() || !configured || !ready) return
    const id = state.conversationId
    setError(''); setSendingId(id)
    try {
      const result = await window.omnidesk.ai.send(text, available, id)
      if (result.ok) {
        const draft = drafts.current.get(id)
        if (draft) draft.text = ''
        if (live.current.id === id) { acceptState(result.data); setText('') }
      } else if (live.current.id === id) setError(result.message)
    } finally { setSendingId('') }
  }
  const switchConversation = async (id?: string) => {
    const result = id ? await window.omnidesk.ai.selectConversation(id) : await window.omnidesk.ai.createConversation()
    if (result.ok) acceptState(result.data)
    else setError(result.message)
  }
  const deleteConversation = async (id: string) => {
    const result = await window.omnidesk.ai.deleteConversation(id)
    if (result.ok) {
      acceptState(result.data)
      drafts.current.delete(id)
    } else setError(result.message)
  }
  return <div className="ai-workbench">
    <header className="ai-header"><div className="ai-header-title"><span className="ai-mark"><Icon name="assistant" size={23} /></span><div><h1>AI 助手</h1><p>整理服务器资料，查询 Linux / Windows 状态，协助日常运维。</p></div></div><button className="btn" aria-expanded={settings} onClick={() => setSettings(!settings)}><Icon name="settings" size={15} /><span>{configured ? configuration.model : '配置模型'}</span></button></header>
    {settings && <div className="ai-config-panel"><AiSettings onSaved={setConfiguration} /></div>}
    {state.storageError && <p className="ai-storage-error" role="alert">{state.storageError}</p>}
    <nav className="ai-conversations" aria-label="AI 对话列表"><button className="btn ai-new-conversation" disabled={!ready} onClick={() => void switchConversation()}><Icon name="plus" size={14} />新建对话</button><div className="ai-conversation-tabs">{state.conversations.map(conversation => <div key={conversation.id} className="ai-conversation-entry" data-active={conversation.id === state.conversationId}><button className="ai-conversation-tab" data-conversation-id={conversation.id} aria-current={conversation.id === state.conversationId ? 'page' : undefined} onClick={() => void switchConversation(conversation.id)} title={conversation.title}><span className="ai-conversation-title">{conversation.title}</span><small data-status={hasHostKey(conversation.id) ? 'approval' : conversation.status}>{hasHostKey(conversation.id) ? '待核验' : conversation.status === 'approval' ? '待确认' : conversation.status === 'running' ? '处理中' : conversation.interrupted ? '已中断' : conversation.hasMessages ? '已完成' : '未开始'}</small>{conversation.unread && <i className="ai-unread" aria-label="有新回复" />}</button><button className="ai-conversation-close" aria-label={`删除对话 ${conversation.title}`} title={conversation.status !== 'idle' || sendingId === conversation.id || hasHostKey(conversation.id) ? '请先完成或停止此对话的任务' : '删除对话'} disabled={!ready || conversation.status !== 'idle' || sendingId === conversation.id || hasHostKey(conversation.id)} onClick={() => void deleteConversation(conversation.id)}><Icon name="close" size={12} /></button></div>)}</div></nav>
    <div className="ai-layout">
      <aside className="ai-scope" aria-label="AI 可访问的服务器">
        <div className="ai-scope-heading"><span>{available.length ? '已限定服务器' : '全部本机服务器'}</span><strong>{busy ? state.scopeCount : available.length || connections.length}<small> / {connections.length}</small></strong></div>
        <p className="ai-scope-description">无需勾选，直接说名称、IP、标签或分组即可。默认检索全部本机服务器；勾选后仅在所选范围内处理。</p>
        <label className="ai-search"><Icon name="search" size={14} /><input aria-label="搜索 AI 服务器" placeholder="搜索名称、地址、标签" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="ai-scope-actions"><button className="btn btn-ghost" disabled={busy || !ready || !shown.length} onClick={() => setSelected([...new Set([...available, ...shown.map(item => item.id)])].slice(0, 200))}>选择搜索结果</button><button className="btn btn-ghost" disabled={busy || !ready || !selected.length} onClick={() => setSelected([])}>使用全部服务器</button></div>
        <div className="ai-server-list">{shown.map(connection => <label className="ai-server" key={connection.id} data-selected={available.includes(connection.id)}>
          <input aria-label={`选择 ${connection.name}`} type="checkbox" disabled={busy || !ready || available.length >= 200 && !available.includes(connection.id)} checked={available.includes(connection.id)} onChange={event => setSelected(event.target.checked ? [...available, connection.id] : available.filter(id => id !== connection.id))} />
          <span className="ai-server-content"><span className="ai-server-title"><Icon name={connection.kind === 'ssh' ? 'terminal' : 'monitor'} size={14} /><strong>{connection.name}</strong><small>{connection.kind.toUpperCase()}</small></span><span className="ai-server-address">{formatConnectionAddress(connection.host, connection.port)}</span>{!!connection.tags?.length && <span className="ai-server-tags">{connection.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</span>}</span>
        </label>)}{!shown.length && <p className="ai-empty-list">{connections.length ? '没有匹配的服务器' : '先添加连接，或切换编辑权限让 AI 新增连接资料。'}</p>}</div>
        <div className="ai-scope-foot"><Icon name="shield" size={15} /><span><strong>{permission.label}</strong><br />{permission.description}</span></div>
      </aside>
      <section className="ai-conversation" aria-label="AI 对话">
        <div className="ai-conversation-toolbar"><span className={`ai-status ${state.status === 'approval' || hostKey ? 'needs-approval' : ''}`}><i />{state.status === 'approval' || hostKey ? '等待你的确认' : busy ? '正在处理任务' : '准备就绪'}</span><span className="ai-call-count">本轮 {state.modelCalls} / {state.maxModelCalls} 次</span><button className="btn btn-ghost" disabled={busy || !ready || !state.messages.length} onClick={async () => { const result = await window.omnidesk.ai.clear(state.conversationId); if (result.ok) { acceptState(result.data); setError('') } else setError(result.message) }}>清空对话</button></div>
        <div className="ai-transcript" aria-label="对话记录" ref={transcript} data-confirming={!!state.pending || !!hostKey}>
          {!state.messages.length && <div className="ai-welcome"><span className="ai-welcome-kicker">OMNIDESK / ASSISTANT</span><h2>从一项具体任务开始。</h2><p>直接告诉我是哪台服务器，或让我先查看全部服务器资料。也可在左侧勾选来限定范围；切换对话后任务继续在后台处理。</p><div className="ai-examples">{examples.map((example, index) => <button key={example} disabled={busy} onClick={() => setText(example)}><span>0{index + 1}</span>{example}<Icon name="arrow" size={15} /></button>)}</div><p className="ai-context-note">Linux / Windows 查询结果会发送给你配置的模型。Windows 通过远程 WMI 查询，需要管理通道可达及账号权限。请勿在对话或命令中填写密码、私钥等敏感内容。</p></div>}
          <AiTranscript key={state.conversationId} messages={state.messages} status={state.status} pendingId={state.pending?.id} onConfirm={(id, approved) => window.omnidesk.ai.confirm(id, approved, state.conversationId)} />
          {hostKey && <AiHostKeyCard request={hostKey} key={hostKey.sessionId} />}
          <div ref={end} />
        </div>
        <div className="ai-composer"><label className="ai-composer-label" htmlFor="ai-task">你的任务 <span>{available.length ? `作用于 ${available.length} 台所选服务器` : '可检索全部本机服务器'}</span></label><textarea id="ai-task" aria-label="AI 任务" maxLength={12000} placeholder={state.pending || hostKey ? '请先在对话卡片中选择确定或取消' : configured ? canCreate ? '例如：找到 192.0.2.10，把备注改为维护中；或先查看所有服务器资料…' : '例如：查看所有服务器资料，或查询 192.0.2.10 的系统状态…' : '请先配置 AI 接口和模型'} value={text} disabled={busy || !ready} onChange={event => setText(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            const input = event.currentTarget
            const start = input.selectionStart, end = input.selectionEnd
            if (input.value.length - (end - start) >= input.maxLength) return
            setText(input.value.slice(0, start) + '\n' + input.value.slice(end))
            requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 1 })
          } else if (!event.shiftKey && !event.altKey) {
            event.preventDefault()
            if (!event.repeat) void send()
          }
        }} /><div className="ai-composer-actions"><div className="ai-composer-options"><label className="ai-permission-select"><Icon name="shield" size={14} /><select aria-label="当前对话权限" disabled={busy || !ready} value={state.permissionMode} onChange={async event => { const result = await window.omnidesk.ai.setPermissionMode(event.target.value as AiPermissionMode, state.conversationId); if (result.ok) acceptState(result.data); else setError(result.message) }}>{aiPermissionModes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label><span className="ai-composer-hint">Enter 发送 · Ctrl + Enter 换行</span></div>{busy ? <button className="btn" onClick={async () => { const result = await window.omnidesk.ai.cancel(state.conversationId); if (!result.ok) setError(result.message) }}>停止任务</button> : <button className="btn btn-primary" disabled={!ready || !configured || !text.trim()} onClick={() => void send()}>发送任务<Icon name="arrow" size={15} /></button>}</div>{error && <p className="ai-feedback is-error" role="alert">{error}</p>}</div>
      </section>
    </div>
  </div>
}
