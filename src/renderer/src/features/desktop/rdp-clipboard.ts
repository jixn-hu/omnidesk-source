interface ClipboardOptions {
  canSync(): boolean
  readText(): Promise<string>
  writeText(text: string): Promise<void>
  publishText(text: string): Promise<void>
  preparePaste?(): Promise<boolean | 'remote'>
  cancelPaste?(): void
  onError(message: string): void
}

export function createRdpClipboard(options: ClipboardOptions) {
  let disposed = false
  let lastText: string | undefined
  let lastRemoteText: string | undefined
  let remoteFormats = false
  let revision = 0
  let queue = Promise.resolve()
  const allowed = () => !disposed && options.canSync()
  const enqueue = (action: () => Promise<boolean>) => {
    const result = queue.then(action).catch(() => {
      if (allowed()) options.onError('剪贴板同步未完成，请重新复制后重试；远程会话不受影响。')
      return false
    })
    queue = result.then(() => {})
    return result
  }
  const sync = (force = false) => {
    const started = revision
    return enqueue(async () => {
      if (!allowed() || remoteFormats || started !== revision) return false
      const text = await options.readText()
      if (!allowed() || started !== revision) return false
      if (text.length > 1024 * 1024) { options.onError('剪贴板文本超过 1M 字符，请分段粘贴。'); return false }
      if ((force && text !== lastRemoteText) || text !== lastText) {
        await options.publishText(text)
        if (!allowed() || started !== revision) return false
        lastText = text
        lastRemoteText = undefined
      }
      options.onError('')
      return true
    })
  }
  return {
    sync,
    async paste(sendShortcut: () => void): Promise<void> {
      const started = revision
      try {
        if (!allowed()) return
        if (options.preparePaste) {
          const prepared = await options.preparePaste()
          if (!allowed() || started !== revision) return
          if (prepared) {
            if (prepared === true) { remoteFormats = false; lastText = undefined; lastRemoteText = undefined }
            sendShortcut()
            return
          }
        }
        if (remoteFormats) { remoteFormats = false; lastText = undefined; lastRemoteText = undefined }
        if (await sync(!!options.preparePaste && lastRemoteText === undefined) && allowed() && started === revision) sendShortcut()
      }
      catch (error) { if (allowed()) options.onError(options.preparePaste && error instanceof Error ? `文件粘贴未完成：${error.message}` : '粘贴未完成，请重试；远程会话不受影响。') }
    },
    receive(text: string): Promise<boolean> {
      if (!allowed()) return Promise.resolve(false)
      remoteFormats = false
      const received = ++revision
      return enqueue(async () => {
        if (!allowed() || received !== revision) return false
        if (text.length > 1024 * 1024) { options.onError('远程剪贴板文本超过 1M 字符，未写入本机。'); return false }
        await options.writeText(text)
        if (!allowed() || received !== revision) return false
        lastText = text
        lastRemoteText = text
        options.onError('')
        return true
      })
    },
    receiveFormats(): void { revision++; remoteFormats = true; lastText = undefined; lastRemoteText = undefined; options.cancelPaste?.() },
    cancelPending(): void { revision++; options.cancelPaste?.() },
    dispose(): void { disposed = true; lastText = undefined; lastRemoteText = undefined; revision++; options.cancelPaste?.() }
  }
}

export type RdpClipboard = ReturnType<typeof createRdpClipboard>
