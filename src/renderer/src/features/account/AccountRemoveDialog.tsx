import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OfficialAccountStatus } from '@shared/account'

type SavedAccount = NonNullable<OfficialAccountStatus['accounts']>[number]

export default function AccountRemoveDialog({ account, onClose, onRemoved }: {
  account: SavedAccount
  onClose: () => void
  onRemoved: (status: OfficialAccountStatus) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  const remove = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      const result = await window.omnidesk.account.removeAccount(account.id)
      if (!result.ok) { setError(result.message); return }
      onRemoved(result.data)
    } catch (error) { setError(error instanceof Error ? error.message : '移除失败，请重试') }
    finally { running.current = false; setBusy(false) }
  }
  return createPortal(<div className="modal-backdrop account-remove-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="account-remove-title" aria-describedby="account-remove-description" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() }
      if (event.key === 'Tab') {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const target = event.shiftKey ? buttons.at(-1) : buttons[0]
        if (!buttons.length || document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) { event.preventDefault(); target?.focus() }
      }
    }}>
      <header className="modal-header"><h2 className="modal-title" id="account-remove-title">移除本机账号</h2></header>
      <div className="modal-body">
        <p>确定从本机移除「{account.user.username}」？</p>
        <p className="account-remove-server">{account.serverUrl}</p>
        <p className="field-hint" id="account-remove-description">将清除这台电脑保存的账号记录和登录凭据。云端账号、同步数据、监控节点及历史保留，本机 SSH、RDP、公共凭据和 WebDAV 也会保留。以后可重新添加并登录。</p>
        {error && <p className="alert alert-danger" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer"><button ref={cancel} className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{busy ? '正在移除…' : '确认从本机移除'}</button></footer>
    </section>
  </div>, document.body)
}
