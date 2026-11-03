import { useRef, useState } from 'react'
import type { Connection } from '@shared/types'
import type { MetadataChanges } from '@shared/server-metadata'
import { useApp } from '../../store/app'
import TagInput, { type TagInputHandle } from '../../components/TagInput'

export default function BatchMetadataEditor({ connections, onClose, onSaved }: { connections: Connection[]; onClose: () => void; onSaved: (count: number) => void }) {
  const allConnections = useApp(state => state.connections)
  const [tagMode, setTagMode] = useState('keep')
  const [noteMode, setNoteMode] = useState('keep')
  const [groupMode, setGroupMode] = useState('keep')
  const [tags, setTags] = useState<string[]>([])
  const tagInput = useRef<TagInputHandle>(null)
  const [note, setNote] = useState('')
  const [group, setGroup] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = [tagMode, noteMode, groupMode].some(mode => mode !== 'keep')
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const changes: MetadataChanges = {}
      if (tagMode !== 'keep') changes.tags = { mode: tagMode as NonNullable<MetadataChanges['tags']>['mode'], values: tagMode === 'clear' ? [] : tagInput.current!.read() }
      if (noteMode !== 'keep') changes.note = { mode: noteMode as NonNullable<MetadataChanges['note']>['mode'], value: note }
      if (groupMode !== 'keep') changes.group = { mode: groupMode as NonNullable<MetadataChanges['group']>['mode'], value: group }
      const result = await window.omnidesk.connections.batchMetadata({ items: connections.map(({ id, updatedAt }) => ({ id, updatedAt })), changes })
      if (!result.ok) throw new Error(result.message)
      useApp.getState().setConnections(result.data)
      onSaved(connections.length)
    } catch (error) {
      setError((error as Error).message)
      const result = await window.omnidesk.connections.list()
      if (result.ok) useApp.getState().setConnections(result.data)
    } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onClick={event => { if (!busy && event.target === event.currentTarget) onClose() }} onKeyDown={event => { if (!busy && event.key === 'Escape') onClose() }}>
    <form className="modal modal-lg batch-metadata" role="dialog" aria-modal="true" aria-labelledby="batch-title" onSubmit={save}>
      <div className="modal-header"><h2 className="modal-title" id="batch-title">批量编辑服务器</h2><button type="button" className="btn btn-ghost btn-icon" disabled={busy} onClick={onClose} aria-label="关闭批量编辑">×</button></div>
      <div className="modal-body">
        <div className="batch-summary"><strong>{connections.length}<small>台服务器</small></strong><p>统一整理标签、备注和分组。<br />每项默认保持原值；追加备注会另起一行。</p></div>
        <div className="batch-targets">{connections.slice(0, 5).map(item => <span key={item.id}>{item.name}</span>)}{connections.length > 5 && <span>另 {connections.length - 5} 台</span>}</div>
        <fieldset disabled={busy}>
          <section className="batch-section"><label className="field-label" htmlFor="batch-tags-mode">标签操作</label><select autoFocus id="batch-tags-mode" value={tagMode} onChange={event => setTagMode(event.target.value)}><option value="keep">保持原标签</option><option value="add">添加标签</option><option value="remove">移除指定标签</option><option value="replace">替换全部标签</option><option value="clear">清空全部标签</option></select>
            {!['keep', 'clear'].includes(tagMode) && <TagInput ref={tagInput} value={tags} onChange={setTags} suggestions={allConnections.flatMap(item => item.tags ?? [])} />}
            {tagMode === 'clear' && <p className="batch-clear">将移除所选服务器的全部标签。</p>}
          </section>
          <section className="batch-section"><label className="field-label" htmlFor="batch-note-mode">备注操作</label><select id="batch-note-mode" value={noteMode} onChange={event => setNoteMode(event.target.value)}><option value="keep">保持原备注</option><option value="append">追加备注（另起一行）</option><option value="replace">替换全部备注</option><option value="clear">清空备注</option></select>
            {!['keep', 'clear'].includes(noteMode) && <textarea aria-label="备注内容" rows={3} maxLength={16384} value={note} onChange={event => setNote(event.target.value)} placeholder="用途、负责人、维护事项…" required />}
            {noteMode === 'clear' && <p className="batch-clear">将清空所选服务器的备注。</p>}
          </section>
          <section className="batch-section"><label className="field-label" htmlFor="batch-group-mode">分组操作</label><select id="batch-group-mode" value={groupMode} onChange={event => setGroupMode(event.target.value)}><option value="keep">保持原分组</option><option value="replace">移入指定分组</option><option value="clear">移出分组</option></select>
            {groupMode === 'replace' && <input aria-label="分组名称" value={group} onChange={event => setGroup(event.target.value)} maxLength={256} required placeholder="输入分组名称" />}
          </section>
        </fieldset>
        {error && <div className="alert alert-danger" role="alert">{error}</div>}
      </div>
      <div className="modal-footer"><button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="btn btn-primary" disabled={busy || !changed}>{busy ? '保存中…' : `应用到 ${connections.length} 台服务器`}</button></div>
    </form>
  </div>
}
