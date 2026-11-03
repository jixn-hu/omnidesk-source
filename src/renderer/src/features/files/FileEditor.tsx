import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../../components/Icon'

export default function FileEditor({ sessionId, path, active, onClose, onSaved }: { sessionId: string; path: string; active: boolean; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const source = useRef('')
  const crlf = useRef(false)
  const mounted = useRef(false)
  const savingRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dirty = content !== original

  useEffect(() => {
    let cancelled = false
    mounted.current = true
    void (async () => {
      try {
        const result = await window.omnidesk.sftp.readFile(sessionId, path)
        if (cancelled) return
        if (!result.ok) throw new Error(result.message)
        source.current = result.data
        crlf.current = result.data.includes('\r\n')
        const text = result.data.replace(/\r\n/g, '\n')
        setContent(text)
        setOriginal(text)
        setLoaded(true)
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : '读取文件失败') }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true; mounted.current = false }
  }, [sessionId, path])

  useEffect(() => {
    if (!active) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => { if (loaded) textareaRef.current?.focus(); else dialogRef.current?.focus() })
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus() }
  }, [active, loaded])

  const close = () => {
    if (savingRef.current) return
    if (dirty && !confirm('文件有未保存的修改，确定放弃修改并关闭？')) return
    onClose()
  }
  const save = async () => {
    if (!loaded || !dirty || savingRef.current) return
    const value = crlf.current ? content.replace(/\n/g, '\r\n') : content
    if (new TextEncoder().encode(value).length > 2 * 1024 * 1024) { setError('内容超过 2 MB 编辑上限，请下载后在本地编辑'); return }
    savingRef.current = true
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const result = await window.omnidesk.sftp.writeFile(sessionId, path, value, source.current)
      if (!mounted.current) return
      if (!result.ok) throw new Error(result.message)
      source.current = value
      setOriginal(content)
      setSaved(true)
      onSaved()
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '保存文件失败') }
    finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }

  if (!active) return null
  return createPortal(<div className="modal-backdrop file-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="编辑远程文件" tabIndex={-1} className="modal file-editor-dialog" onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const controls = [...dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)')]
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header className="file-editor-header"><Icon name="file" size={18} /><div><strong>{path.split('/').pop()}{dirty && <span className="file-editor-dirty">未保存</span>}</strong><span className="mono" title={path}>{path}</span></div><button className="btn btn-ghost btn-icon" aria-label="关闭文件编辑器" disabled={saving} onClick={close}><Icon name="close" size={17} /></button></header>
      <div className="file-editor-toolbar"><span>远程文本编辑 · UTF-8 · {crlf.current ? 'CRLF' : 'LF'}</span><button className="btn btn-primary btn-sm" disabled={!loaded || !dirty || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存文件'}<kbd>Ctrl+S</kbd></button></div>
      {error && <div className="alert alert-danger file-editor-error" role="alert">{error}</div>}
      {loading ? <div className="empty"><div className="spinner" /><span>正在读取文件…</span></div> : loaded ? <textarea ref={textareaRef} className="file-editor-text" aria-label="文件内容" value={content} readOnly={saving} spellCheck={false} wrap="off" onChange={event => { setContent(event.target.value); setSaved(false) }} onKeyDown={event => {
        if (saving || event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        const start = event.currentTarget.selectionStart
        const end = event.currentTarget.selectionEnd
        setContent(value => value.slice(0, start) + '\t' + value.slice(end))
        setSaved(false)
        requestAnimationFrame(() => textareaRef.current?.setSelectionRange(start + 1, start + 1))
      }} /> : <div className="empty"><span>文件未写入，可关闭后下载查看。</span></div>}
      <footer className="file-editor-footer"><span role="status">{loading ? '正在读取…' : !loaded ? '尚未加载文件，未作任何修改' : saving ? '正在保存到服务器…' : saved ? '已保存到服务器' : dirty ? '有未保存的修改' : '文件内容与服务器一致'}</span><span>{content.split('\n').length} 行 · 最大 2 MB</span><button className="btn btn-sm" disabled={saving} onClick={close}>关闭</button></footer>
    </div>
  </div>, document.body)
}
