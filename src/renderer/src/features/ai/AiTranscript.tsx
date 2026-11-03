import { useState } from 'react'
import type { AiMessage, AiState, AiApi } from '@shared/ai'
import Icon from '../../components/Icon'
import AiMarkdown from './AiMarkdown'
import AiConfirmation from './AiConfirmation'

type Row = { kind: 'message'; message: AiMessage } | { kind: 'activities'; messages: AiMessage[] }

function Activity({ message }: { message: AiMessage }) {
  const [heading, ...body] = message.text.split('\n')
  return <details className={`ai-activity ${message.error ? 'is-error' : ''}`}>
    <summary><Icon name={message.error ? 'info' : 'terminal'} size={14} /><span>{message.error && body[0] ? `${heading}：${body[0]}` : heading}</span><Icon name="chevron" size={13} /></summary>
    <pre tabIndex={0}>{body.length ? body.join('\n') : heading}</pre>
  </details>
}

function Reply({ message }: { message: AiMessage }) {
  const [copyState, setCopyState] = useState('')
  const assistant = message.role === 'assistant'
  const copy = async () => {
    try { await navigator.clipboard.writeText(message.text); setCopyState('已复制') }
    catch { setCopyState('复制失败，请选择文本复制') }
  }
  return <article className={`ai-message ai-message-${message.role}`}>
    <div className="ai-message-label"><span>{assistant ? 'AI 助手' : '你'}</span><time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>{assistant && <div className="ai-reply-actions"><span role="status">{copyState}</span><button className="btn btn-ghost" onClick={() => void copy()} aria-label="复制回复"><Icon name="copy" size={13} />复制</button></div>}</div>
    {assistant ? <AiMarkdown text={message.text} /> : <div className="ai-message-text">{message.text}</div>}
  </article>
}

export default function AiTranscript({ messages, status, pendingId, onConfirm }: { messages: AiMessage[]; status: AiState['status']; pendingId?: string; onConfirm: AiApi['confirm'] }) {
  const rows: Row[] = []
  for (const message of messages) {
    const previous = rows[rows.length - 1]
    if (message.role !== 'activity' || message.error) rows.push({ kind: 'message', message })
    else if (previous?.kind === 'activities') previous.messages.push(message)
    else rows.push({ kind: 'activities', messages: [message] })
  }
  return <>{rows.map(row => {
    if (row.kind === 'message' && row.message.approval) return <AiConfirmation approval={row.message.approval} pendingId={pendingId} onConfirm={onConfirm} key={row.message.id} />
    if (row.kind === 'message') return row.message.role === 'activity' ? <Activity key={row.message.id} message={row.message} /> : <Reply key={row.message.id} message={row.message} />
    const first = row.messages[0], last = row.messages[row.messages.length - 1]
    const active = last.id === messages[messages.length - 1]?.id && status !== 'idle'
    const queries = row.messages.filter(message => /^(?:Windows )?只读查询 · /.test(message.text)).length
    return <details className={`ai-activity-group ${active ? 'is-active' : ''}`} key={first.id}>
      <summary><Icon name="terminal" size={15} /><span className="ai-activity-group-title">执行记录</span><span className="ai-activity-count">{queries ? `${queries} 次只读查询 · ` : ''}{row.messages.length} 条记录</span><span className="ai-activity-hint">{active ? status === 'approval' ? '等待确认' : '处理中' : '查看详情'}</span><Icon name="chevron" size={13} />{active && <span className="ai-activity-current" role="status">{last.text.split('\n')[0]}</span>}</summary>
      <div className="ai-activity-items">{row.messages.map(message => <Activity message={message} key={message.id} />)}</div>
    </details>
  })}</>
}
