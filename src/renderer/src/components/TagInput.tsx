import { forwardRef, useId, useImperativeHandle, useRef, useState } from 'react'

export interface TagInputHandle { read: () => string[] }
export function tagTone(tag: string): number {
  return Array.from(tag).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 5
}
export function TagPill({ tag }: { tag: string }) {
  return <span className="tag-pill" data-tone={tagTone(tag)} title={tag}>{tag}</span>
}

const TagInput = forwardRef<TagInputHandle, { value: string[]; onChange: (value: string[]) => void; suggestions?: string[]; label?: string }>(({ value, onChange, suggestions = [], label = '标签' }, ref) => {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const read = (text = draft) => {
    const next = [...new Set([...value, ...text.split(/[,，;；\r\n]+/).map(item => item.trim()).filter(Boolean)])]
    if (next.length > 100 || next.some(item => item.length > 128 || item.includes('\0'))) throw new Error('最多 100 个标签，每个最多 128 字')
    return next
  }
  useImperativeHandle(ref, () => ({ read: () => { setError(''); return read() } }))
  const commit = (text = draft) => {
    try { onChange(read(text)); setDraft(''); setError(''); return true }
    catch (error) { setError((error as Error).message); return false }
  }
  const candidates = [...new Set(suggestions)].filter(tag => !value.includes(tag) && (!draft || tag.toLowerCase().includes(draft.toLowerCase()))).slice(0, 8)
  return <div className="tag-field">
    <label className="field-label" htmlFor={id}>{label}</label>
    <div className="tag-editor" onClick={() => input.current?.focus()}>
      {value.map((tag, index) => <span className="tag-pill" data-tone={tagTone(tag)} key={tag}>{tag}<button type="button" aria-label={`移除标签 ${tag}`} onClick={event => { event.stopPropagation(); onChange(value.filter((_, i) => i !== index)) }}>×</button></span>)}
      <input id={id} ref={input} value={draft} aria-describedby={id + '-hint'} aria-invalid={!!error} placeholder={value.length ? '继续添加…' : '输入标签，按 Enter 添加'} onChange={event => { setDraft(event.target.value); setError('') }} onBlur={() => { if (draft.trim()) commit() }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); commit() }
        if (event.key === 'Backspace' && !draft) onChange(value.slice(0, -1))
      }} onPaste={event => { const text = event.clipboardData.getData('text'); if (/[,，;；\r\n]/.test(text)) { event.preventDefault(); commit(draft + text) } }} />
      <button type="button" className="tag-add" aria-label="添加标签" onClick={event => { event.stopPropagation(); if (commit()) input.current?.focus() }}>＋</button>
    </div>
    <div id={id + '-hint'} className="field-hint">Enter 添加 · × 移除 · 支持粘贴多个标签</div>
    {candidates.length > 0 && <div className="tag-suggestions"><span>已有标签</span>{candidates.map(tag => <button type="button" key={tag} onMouseDown={event => event.preventDefault()} onClick={() => commit(tag)}>{tag}</button>)}</div>}
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
  </div>
})
TagInput.displayName = 'TagInput'
export default TagInput
