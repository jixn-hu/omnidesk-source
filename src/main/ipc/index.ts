import { windowsMonitorBundle, windowsMonitorCommand } from '../services/monitor-windows-installer.js'
import { encryptMonitorData, decryptMonitorData } from '../services/monitor-data-backup.js'
import type { BackupOptions } from '@shared/backup.js'
/**
 * IPC 路由
 *
 * 统一约定：每个 handler 都包在 safe() 里，异常转成 { ok: false, code, message }
 * 返回给渲染进程，而不是让异常穿透进程边界（那样在渲染侧只会看到一个
 * 无意义的 "Error invoking remote method"）。
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { app, shell, dialog, screen, clipboard, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc.js'
import type { MonitorEntry, MonitorNode, MonitorPoint, MonitorAlert } from '@shared/monitoring'
import type { Connection, ExecOptions, IpcResult, SshConnection } from '@shared/types.js'
import { services } from '../services/index.js'
import { broadcast, getPrimaryWindow } from '../windows.js'
import { newCredentialRef } from '../services/vault.js'
import { resolveConnectionCredential } from '../services/credential-resolver.js'
import { checkConnection } from '../services/connection-check.js'
import { rdpAddress } from '../services/rdp-protocol.js'
import { launchSystemRdp } from '../services/rdp-system-client.js'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { writeConfigurationFile } from '../services/config-backup.js'
import type { WebDavConfigurationInput } from '@shared/types.js'
import { connectionKey, parseConnectionAddress } from '@shared/connection-identity.js'
import { join } from 'node:path'

/** 包装 handler，统一错误信封 */
function safe<A extends unknown[], R>(
  fn: (...args: A) => Promise<R> | R
): (event: IpcMainInvokeEvent, ...args: A) => Promise<IpcResult<R>> {
  return async (_event, ...args: A) => {
    try {
      const data = await fn(...args)
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, code: 'E_HANDLER', message }
    }
  }
}

/* ------------------------------------------------------------------ */
/* RDP 连通性预检                                                      */
/* ------------------------------------------------------------------ */

/**
 * 在交给 WASM 之前先确认目标端口能不能连上。
 *
 * 为什么必须在这里做：TCP 层的失败原因（拒绝连接 / 超时 / 不可达）跨越 WASM
 * 边界后就丢失了，渲染进程只能拿到一个笼统的「通用错误」，用户完全不知道该查什么。
 * 先探一次，报错才指得清方向。
 *
 * 只做 TCP 握手，连上立刻断开。
 */
async function preflightTarget(
  host: string,
  port: number,
  proxy: import('@shared/types.js').ProxyConfig | undefined
): Promise<void> {
  const { connectViaProxy, connectDirect, ProxyError } = await import('../services/proxy-connector.js')
  const timeoutMs = 8000
  const target = `${host}:${port}`

  let socket: import('node:net').Socket
  try {
    socket =
      proxy && proxy.type !== 'none' && proxy.host
        ? await connectViaProxy(proxy, { host, port }, timeoutMs)
        : await connectDirect({ host, port }, timeoutMs)
  } catch (err) {
    if (err instanceof ProxyError) {
      const stageText: Record<string, string> = {
        connect: '无法连接代理服务器',
        handshake: '代理握手失败',
        auth: '代理认证失败',
        reply: '代理拒绝转发到目标'
      }
      throw new Error(
        `${stageText[err.stage] ?? '代理错误'}：${err.message}\n` +
          `（尚未尝试连接目标，问题出在代理链路上）`
      )
    }

    const msg = err instanceof Error ? err.message : String(err)
    const lower = msg.toLowerCase()

    if (lower.includes('econnrefused') || lower.includes('10061') || lower.includes('拒绝')) {
      throw new Error(
        `无法连接到 ${target} —— 目标拒绝连接。\n\n` +
          `请确认：\n` +
          `· 目标机已开启「远程桌面」（设置 → 系统 → 远程桌面）\n` +
          `· 端口号正确（默认 3389）\n` +
          `· 目标机防火墙允许该端口\n` +
          `· 若目标在内网，确认当前网络能到达它`
      )
    }
    if (lower.includes('etimedout') || lower.includes('timeout') || lower.includes('10060')) {
      throw new Error(
        `连接 ${target} 超时 —— 目标无响应。\n\n` +
          `通常是网络不通，或被防火墙静默丢弃（丢包而非拒绝）。` +
          `建议先用 ping 或 telnet ${host} ${port} 确认可达。`
      )
    }
    if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
      throw new Error(`无法解析主机名 ${host}。请检查拼写，或改用 IP 地址。`)
    }
    if (lower.includes('ehostunreach') || lower.includes('enetunreach')) {
      throw new Error(`网络不可达：${target}。请检查本机网络连接与路由。`)
    }

    throw new Error(`无法连接到 ${target}：${msg}`)
  }

  socket.destroy()
}

export function registerIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.aiConfiguration, safe(() => services.ai.configuration()))
  ipcMain.handle(IPC.aiSaveConfiguration, safe(input => services.ai.saveConfiguration(input)))
  ipcMain.handle(IPC.aiTest, safe(() => services.ai.test()))
  ipcMain.handle(IPC.aiCreateConversation, safe(() => services.ai.createConversation()))
  ipcMain.handle(IPC.aiSelectConversation, safe(id => services.ai.selectConversation(id)))
  ipcMain.handle(IPC.aiDeleteConversation, safe(id => services.ai.deleteConversation(id)))
  ipcMain.handle(IPC.aiSetPermissionMode, safe((mode, id) => services.ai.setPermissionMode(mode, id)))
  ipcMain.handle(IPC.aiState, safe(() => services.ai.state()))
  ipcMain.handle(IPC.aiSend, safe((text: string, ids: string[], conversationId?: string) => services.ai.send(text, ids, conversationId)))
  ipcMain.handle(IPC.aiConfirm, safe((id: string, approved: boolean, conversationId?: string) => services.ai.confirm(id, approved, conversationId)))
  ipcMain.handle(IPC.aiCancel, safe(conversationId => services.ai.cancel(conversationId)))
  ipcMain.handle(IPC.aiClear, safe(conversationId => services.ai.clear(conversationId)))
  ipcMain.handle(IPC.accountStatus, safe(() => services.account.status()))
  ipcMain.handle(IPC.accountSwitch, safe((id: string) => services.account.switchAccount(id)))
  ipcMain.handle(IPC.accountRemove, safe((id: string) => services.account.removeAccount(id)))
  ipcMain.handle(IPC.accountOpenAdmin, safe(async () => {
    const status = services.account.status()
    if (!status.serverUrl || status.user?.role !== 'admin') throw new Error('请先登录服务管理员账号')
    const address = new URL(status.serverUrl)
    address.pathname = address.pathname.replace(/\/$/, '') + '/admin/'
    address.hash = 'shares'
    await shell.openExternal(address.toString())
    return true
  }))
  ipcMain.handle(IPC.accountConfigure, safe((url: string) => services.account.configure(url)))
  ipcMain.handle(IPC.accountAuthenticate, safe((action: 'register' | 'login', username: string, password: string) => services.account.authenticate(action, username, password)))
  ipcMain.handle(IPC.accountProviders, safe(() => services.account.providers()))
  ipcMain.handle(IPC.accountSettings, safe(() => services.account.settings()))
  ipcMain.handle(IPC.accountSaveSettings, safe((input) => services.account.saveSettings(input)))
  ipcMain.handle(IPC.accountGitlabStart, safe(async (mode: 'login' | 'link') => {
    const attempt = await services.account.startGitlab(mode)
    try { await shell.openExternal(attempt.authorizationUrl) }
    catch { services.account.cancelGitlab(attempt.id); throw new Error('无法打开系统浏览器，请检查默认浏览器后重试') }
    return { id: attempt.id, expiresAt: attempt.expiresAt }
  }))
  ipcMain.handle(IPC.accountGitlabPoll, safe((id: string) => services.account.pollGitlab(id)))
  ipcMain.handle(IPC.accountGitlabCancel, safe((id: string) => services.account.cancelGitlab(id)))
  ipcMain.handle(IPC.accountLogout, safe(() => services.account.logout()))
  ipcMain.handle(IPC.accountUpload, safe((options?: BackupOptions) => services.account.upload(options)))
  ipcMain.handle(IPC.accountDownload, safe((options?: BackupOptions) => services.account.download(options)))
  ipcMain.handle(IPC.accountShares, safe((search: string, page: number) => services.account.shares(search, page)))
  ipcMain.handle(IPC.accountUsers, safe((search: string, page: number) => services.account.users(search, page)))
  ipcMain.handle(IPC.accountPublish, safe(async (id: string) => {
    const connection = services.connections.get(id)
    if (!connection) throw new Error('连接不存在')
    const credential = resolveConnectionCredential(connection, services.sharedCredentials, services.vault)
    if (!credential?.secret || !credential.username.trim()) throw new Error('请先补齐服务器账号和凭据，再发布共享')
    return services.account.publish(connection, credential)
  }))
  ipcMain.handle(IPC.accountUnpublish, safe((id: string) => services.account.unpublish(id)))
  ipcMain.handle(IPC.accountPublishMany, safe((ids: string[]) => {
    const selected = services.account.batchIds(ids)
    return services.account.publishMany(selected.map(id => {
      const connection = services.connections.get(id)
      if (!connection) throw new Error('选择中包含已删除的本机连接，请刷新后重试')
      try { return { connection, credential: resolveConnectionCredential(connection, services.sharedCredentials, services.vault) } }
      catch (error) { return { connection, credential: null, error: error instanceof Error ? error.message : '凭据读取失败' } }
    }))
  }))
  ipcMain.handle(IPC.accountUnpublishMany, safe((ids: string[]) => services.account.unpublishMany(ids)))
  ipcMain.handle(IPC.accountImportShare, safe((id: string) => services.account.importShare(id)))
  ipcMain.handle(IPC.accountConnect, safe((id: string, width: number, height: number) => services.account.connect(id, width, height)))
  ipcMain.handle(IPC.accountRelease, safe((id: string) => services.account.release(id)))
  ipcMain.handle(IPC.credentialProbeStart, safe((connections: string[], credentials: string[]) => services.credentialProbe.start(connections, credentials)))
  ipcMain.handle(IPC.credentialProbeNext, safe((id: string) => services.credentialProbe.next(id)))
  ipcMain.handle(IPC.credentialProbeFinish, safe((id: string, success: boolean) => services.credentialProbe.finishRdp(id, success)))
  ipcMain.handle(IPC.credentialProbeCancel, safe((id: string) => services.credentialProbe.cancel(id)))
  ipcMain.handle(IPC.credentialProbeApply, safe((id: string, connectionId: string) => services.credentialProbe.apply(id, connectionId)))
  ipcMain.handle(IPC.configurationPasswordStatus, safe(() => services.backup.hasSavedPassword()))
  ipcMain.handle(IPC.configurationSavePassword, safe((password: string) => services.backup.savePassword(password)))
  ipcMain.handle(IPC.configurationMonitorExport, safe(async (password: string) => {
    if (services.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱')
    const secret = password || services.vault.getCredential('configuration-backup-password')?.secret || ''
    if (!secret) throw new Error('请先输入数据库备份密码')
    const result = await dialog.showSaveDialog({ title: '导出监控服务端数据（加密）', defaultPath: `OmniDesk-monitor-${new Date().toISOString().slice(0, 10)}.odmonitor`, filters: [{ name: '监控数据库加密备份', extensions: ['odmonitor'] }] })
    if (result.canceled || !result.filePath) return { cancelled: true }
    let snapshot: unknown
    try { snapshot = await services.monitoring.request('/v1/backup') }
    catch (error) {
      if (error instanceof Error && /HTTP 404|HTTP 405/.test(error.message)) throw new Error('当前监控服务端尚不支持数据库快照，请先升级服务端；本机未生成备份')
      throw error
    }
    writeConfigurationFile(result.filePath, await encryptMonitorData(secret, snapshot))
    return { cancelled: false, path: result.filePath }
  }))
  ipcMain.handle(IPC.configurationMonitorDecrypt, safe(async (password: string) => {
    if (services.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱')
    const source = await dialog.showOpenDialog({ title: '选择监控数据库加密备份', properties: ['openFile'], filters: [{ name: '监控数据库加密备份', extensions: ['odmonitor'] }] })
    if (source.canceled || !source.filePaths[0]) return { cancelled: true }
    if (statSync(source.filePaths[0]).size > 96 * 1024 * 1024) throw new Error('数据库备份超过大小限制')
    const secret = password || services.vault.getCredential('configuration-backup-password')?.secret || ''
    const data = await decryptMonitorData(secret, readFileSync(source.filePaths[0], 'utf8'))
    try {
      const result = await dialog.showSaveDialog({ title: '保存解密后的数据库（含节点敏感资料，请妥善保管）', defaultPath: 'omnidesk-monitor-restored.db', filters: [{ name: 'SQLite 数据库', extensions: ['db'] }] })
      if (result.canceled || !result.filePath) return { cancelled: true }
      if (source.filePaths[0].toLowerCase() === result.filePath.toLowerCase()) throw new Error('请另选数据库保存位置，保留原始加密备份')
      writeConfigurationFile(result.filePath, data)
      return { cancelled: false, path: result.filePath }
    } finally { data.fill(0) }
  }))
  ipcMain.handle(IPC.configurationExport, safe(async (password: string, options?: BackupOptions) => {
    const contents = await services.backup.create(password, options)
    const result = await dialog.showSaveDialog({ title: '导出加密配置', defaultPath: `OmniDesk-${new Date().toISOString().slice(0, 10)}.odbackup`, filters: [{ name: 'OmniDesk 加密备份', extensions: ['odbackup'] }] })
    if (result.canceled || !result.filePath) return { cancelled: true }
    writeConfigurationFile(result.filePath, contents)
    return { cancelled: false, path: result.filePath }
  }))
  ipcMain.handle(IPC.configurationImport, safe(async (password: string, options?: BackupOptions) => {
    const result = await dialog.showOpenDialog({ title: '导入加密配置', properties: ['openFile'], filters: [{ name: 'OmniDesk 加密备份', extensions: ['odbackup', 'json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    if (statSync(result.filePaths[0]).size > 16 * 1024 * 1024) throw new Error('配置文件超过 16MB，未导入')
    return await services.backup.restore(readFileSync(result.filePaths[0], 'utf8'), password, options)
  }))
  ipcMain.handle(IPC.webdavConfiguration, safe(() => services.webdav.configuration()))
  ipcMain.handle(IPC.webdavSave, safe((configuration: WebDavConfigurationInput) => services.webdav.save(configuration)))
  ipcMain.handle(IPC.webdavTest, safe(async () => await services.webdav.test()))
  ipcMain.handle(IPC.webdavUpload, safe(async (password: string, options?: BackupOptions) => await services.webdav.upload(password, options)))
  ipcMain.handle(IPC.webdavDownload, safe(async (password: string, options?: BackupOptions) => await services.webdav.download(password, options)))
  /* ---------------------------- 应用 ---------------------------- */

  ipcMain.handle(IPC.updatesStatus, safe(() => services.updates.status()))
  ipcMain.handle(IPC.updatesCheck, safe(() => services.updates.check()))
  ipcMain.handle(IPC.updatesSetAutoCheck, safe((enabled: boolean) => services.updates.setAutoCheck(enabled)))
  ipcMain.handle(IPC.updatesOpenRelease, safe(async () => { await shell.openExternal(services.updates.releaseUrl()); return true }))

  ipcMain.handle(
    IPC.appInfo,
    safe(async () => {
      const os = await import('node:os')

      // 把平台和位数说清楚 —— 用户排障时第一个要确认的就是这个
      const platformName =
        process.platform === 'win32'
          ? 'Windows'
          : process.platform === 'darwin'
            ? 'macOS'
            : 'Linux'

      const archName =
        process.arch === 'x64' ? '64 位 (x64)' : process.arch === 'arm64' ? 'ARM64' : process.arch

      return {
        name: 'OmniDesk',
        version: app.getVersion(),
        platform: process.platform,
        // 显示用：例如 "Windows 64 位 (x64)"
        platformLabel: `${platformName} ${archName}`,
        // 例如 "10.0.26100"（Windows 上对应 Windows 11 24H2 及以后）
        osRelease: `${os.type()} ${os.release()}`,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        // 打包形态，便于判断是安装版还是免安装版
        packaged: app.isPackaged
      }
    })
  )

  /** 扫描本机 SSH 私钥（只读），供「一键选择」使用 */
  ipcMain.handle(
    IPC.sshScanLocalKeys,
    safe(async () => {
      const { scanLocalSshKeys } = await import('../services/ssh-keys.js')
      return scanLocalSshKeys()
    })
  )

  /**
   * 读取本地文本文件（用于导入私钥）。限制大小，避免误选大文件把内存打满
   */
  ipcMain.handle(
    IPC.fsReadText,
    safe(async (filePath: string, maxBytes = 256 * 1024) => {
      const { readFileSync, statSync, writeFileSync } = await import('node:fs')
      const st = statSync(filePath)
      if (!st.isFile()) throw new Error('不是普通文件')
      if (st.size > maxBytes) {
        throw new Error(`文件过大（${Math.round(st.size / 1024)} KB），私钥通常不超过 ${maxBytes / 1024} KB`)
      }
      return readFileSync(filePath, 'utf8')
    })
  )

  /* ---------------------------- Vault ---------------------------- */

  ipcMain.handle(IPC.vaultStatus, safe(() => services.vault.status()))

  ipcMain.handle(
    IPC.vaultInit,
    safe((password: string) => {
      services.vault.init(password)
      return services.vault.status()
    })
  )

  ipcMain.handle(
    IPC.vaultUnlock,
    safe((password: string) => {
      services.vault.unlock(password)
      return services.vault.status()
    })
  )

  ipcMain.handle(
    IPC.vaultLock,
    safe(() => {
      services.ai.cancelAll()
      services.account.releaseAll()
      services.vault.lock()
      return services.vault.status()
    })
  )

  ipcMain.handle(
    IPC.vaultChangePassword,
    safe((oldPw: string, newPw: string) => {
      services.vault.changePassword(oldPw, newPw)
      return true
    })
  )

  /** 当前保护模式 */
  ipcMain.handle(IPC.vaultGetMode, safe(() => services.vault.mode()))

  /**
   * 尝试免密码解锁。
   * 仅「设备密钥」模式会成功；主密码模式返回 false，界面据此决定是否弹解锁框。
   */
  ipcMain.handle(IPC.vaultAutoUnlock, safe(() => services.tryAutoUnlock()))

  /**
   * 切换保护模式。
   * 只是重新包裹数据密钥，与存了多少凭据无关，瞬间完成。
   */
  ipcMain.handle(
    IPC.vaultSetMode,
    safe(
      (
        target: import('@shared/types.js').VaultMode,
        opts: { currentPassword?: string; newPassword?: string }
      ) => services.vault.setMode(target, opts)
    )
  )

  /* --------------------------- 连接配置 --------------------------- */

  ipcMain.handle(IPC.connList, safe(() => services.connections.list()))
  ipcMain.handle(IPC.connChecks, safe(() => Object.fromEntries(services.connections.list().map(connection => [connection.id, checkConnection(connection, services.sharedCredentials, services.vault)]))))
  ipcMain.handle(IPC.connBatchMetadata, safe((request: import('@shared/server-metadata.js').BatchMetadataRequest) => services.connections.batchMetadata(request)))
  ipcMain.handle(IPC.connGet, safe((id: string) => services.connections.get(id)))
  ipcMain.handle(
    IPC.connSave,
    safe(async (payload: Connection, credential?: { secret: string; passphrase?: string }) => {
      parseConnectionAddress(payload.host, payload.port)
      if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) throw new Error('服务端口必须为 1–65535 之间的整数')
      if (!payload.name?.trim() || !['ssh', 'rdp'].includes(payload.kind)) throw new Error('连接名称或协议类型不正确')
      const existingConnection = payload.id ? services.connections.get(payload.id) : null
      if (payload.id && !existingConnection) throw new Error('连接不存在，请刷新后重试')
      const duplicates = services.connections.duplicates(payload)
      let allowDuplicate = false
      if (duplicates.length && (!existingConnection || connectionKey(existingConnection) !== connectionKey(payload))) {
        const answer = await dialog.showMessageBox({ type: 'question', title: '发现重复连接', message: '相同服务器已经存在，是否仍然保存？', detail: duplicates.map((item) => `${item.name} · ${item.kind.toUpperCase()} · ${item.host}:${item.port}`).join('\n'), buttons: ['取消', '仍然保存'], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) throw new Error('已取消，未新增重复连接')
        allowDuplicate = true
      }
      // 有凭据就先写进 Vault，再把引用挂到连接上
      let ref = (payload as { credentialRef?: string }).credentialRef

      // 注意 secret 和 passphrase 要分开考虑：
      // 用户可能只改口令（比如给已有的私钥补一个 passphrase），此时 secret 为空，
      // 必须沿用保险箱里已有的内容，不能把私钥清掉。
      const hasSecret = Boolean(credential?.secret?.length)
      const hasPassphrase = credential?.passphrase !== undefined

      if (hasSecret || hasPassphrase) {
        if (!ref) {
          if (!hasSecret) {
            throw new Error('缺少凭据内容，无法创建')
          }
          ref = newCredentialRef()
          ;(payload as { credentialRef?: string }).credentialRef = ref
        }

        const existing = hasSecret ? null : services.vault.getCredential(ref)
        const secret = hasSecret ? credential!.secret : (existing?.secret ?? '')

        if (!secret) {
          throw new Error('凭据内容为空，请重新填写')
        }

        services.vault.setCredential(
          ref,
          secret,
          hasPassphrase ? credential!.passphrase : existing?.passphrase
        )
      }

      return services.connections.save(payload, allowDuplicate)
    })
  )
  ipcMain.handle(
    IPC.connDelete,
    safe((id: string) => {
      const conn = services.connections.get(id)
      if (conn?.credentialRef) {
        try {
          services.vault.deleteCredential(conn.credentialRef)
        } catch {
          /* 保险箱锁着就不删凭据，仅删配置 */
        }
      }
      return services.connections.delete(id)
    })
  )
  ipcMain.handle(IPC.connGroups, safe(() => services.connections.groups()))

  /* ----------------------------- SSH ----------------------------- */

  ipcMain.handle(
    IPC.sshConnect,
    safe(async (connectionId: string, cols?: number, rows?: number, ownerId?: string) => {
      const conn = services.connections.get(connectionId)
      if (!conn) throw new Error('连接不存在')
      if (conn.kind !== 'ssh') throw new Error('该连接不是 SSH 类型')
      const info = await services.ssh.connect(conn, ownerId)
      if (cols && rows) await services.ssh.openShell(info.id, cols, rows)
      return info
    })
  )

  ipcMain.handle(
    IPC.sshDisconnect,
    safe((sessionId: string) => {
      services.ssh.disconnect(sessionId)
      return true
    })
  )

  ipcMain.handle(
    IPC.sshWrite,
    safe((sessionId: string, data: string) => {
      services.ssh.write(sessionId, data)
      return true
    })
  )

  ipcMain.handle(
    IPC.sshResize,
    safe((sessionId: string, cols: number, rows: number) => {
      services.ssh.resize(sessionId, cols, rows)
      return true
    })
  )

  ipcMain.handle(IPC.dockerSnapshot, safe((sessionId: string) => services.docker.snapshot(sessionId)))
  ipcMain.handle(IPC.dockerRemove, safe((sessionId: string, request: import('@shared/docker.js').DockerRemoveRequest) => services.docker.remove(sessionId, request)))

  ipcMain.handle(IPC.sshList, safe(() => services.ssh.list()))

  ipcMain.handle(
    IPC.sshExec,
    safe((sessionId: string, command: string, opts?: ExecOptions) => services.ssh.exec(sessionId, command, opts))
  )

  ipcMain.handle(
    IPC.sshHostKeyDecision,
    safe((sessionId: string, decision: { accept: boolean; remember: boolean }) => {
      services.ssh.resolveHostKey(sessionId, decision)
      return true
    })
  )

  /* ----------------------------- SFTP ----------------------------- */

  ipcMain.handle(IPC.sftpList, safe((sessionId: string, path: string) => services.sftp.list(sessionId, path)))
  ipcMain.handle(
    IPC.sftpReadFile,
    safe((sessionId: string, path: string) => services.sftp.readFile(sessionId, path))
  )
  ipcMain.handle(
    IPC.sftpWriteFile,
    safe((sessionId: string, path: string, content: string, expectedContent?: string) => services.sftp.writeFile(sessionId, path, content, expectedContent))
  )
  ipcMain.handle(IPC.sftpCreateFile, safe((sessionId: string, path: string) => services.sftp.createFile(sessionId, path)))
  ipcMain.handle(IPC.sftpMkdir, safe((sessionId: string, path: string) => services.sftp.mkdir(sessionId, path)))
  ipcMain.handle(
    IPC.sftpRename,
    safe((sessionId: string, from: string, to: string) => services.sftp.rename(sessionId, from, to))
  )
  ipcMain.handle(
    IPC.sftpDelete,
    safe((sessionId: string, path: string, isDir: boolean) => services.sftp.remove(sessionId, path, isDir))
  )

  ipcMain.handle(
    IPC.sftpDownload,
    safe(async (sessionId: string, remotePath: string, defaultName: string) => {
      const win = getPrimaryWindow()
      const result = await dialog.showSaveDialog(win!, { defaultPath: defaultName })
      if (result.canceled || !result.filePath) return null
      return await services.sftp.download(sessionId, remotePath, result.filePath)
    })
  )

  ipcMain.handle(
    IPC.sftpUpload,
    safe(async (sessionId: string, remoteDir: string) => {
      const win = getPrimaryWindow()
      const result = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
      if (result.canceled || result.filePaths.length === 0) return []
      const tasks = []
      for (const localPath of result.filePaths) {
        const name = localPath.split(/[\\/]/).pop() ?? 'file'
        const remotePath = remoteDir.endsWith('/') ? remoteDir + name : `${remoteDir}/${name}`
        tasks.push(await services.sftp.upload(sessionId, localPath, remotePath))
      }
      return tasks
    })
  )

  ipcMain.handle(IPC.sftpUploadDropped, safe((sessionId: string, directory: string, paths: string[]) => services.sftp.uploadDropped(sessionId, paths, directory)))
  ipcMain.handle(IPC.sftpMove, safe((sessionId: string, source: string, directory: string) => services.sftp.move(sessionId, source, directory)))
  ipcMain.handle(IPC.sftpDragToLocal, safe((sessionId: string, path: string) => services.sftp.dragToLocal(sessionId, path, app.isPackaged ? join(process.resourcesPath, 'freerdp') : join(app.getAppPath(), 'out/native-freerdp'))))

  ipcMain.handle(IPC.sftpTransferList, safe((sessionId?: string) => services.sftp.listTransfers(sessionId)))
  ipcMain.handle(
    IPC.sftpTransferCancel,
    safe((taskId: string) => {
      services.sftp.cancelTransfer(taskId)
      return true
    })
  )

  /* ------------------------------ 代理 ----------------------------- */

  /**
   * 测试代理连通性：经代理连到目标，连上即断开。
   * 有这个才能让用户在保存前就知道"代理配得对不对"。
   */
  ipcMain.handle(
    IPC.proxyTest,
    safe(async (proxy: import('@shared/types.js').ProxyConfig, host: string, port: number) => {
      const { connectViaProxy, ProxyError } = await import('../services/proxy-connector.js')
      try {
        const socket = await connectViaProxy(proxy, { host, port }, 15_000)
        socket.destroy()
        return { ok: true }
      } catch (err) {
        if (err instanceof ProxyError) {
          const stageText: Record<string, string> = {
            connect: '无法连接代理服务器',
            handshake: '代理握手失败',
            auth: '代理认证失败',
            reply: '代理拒绝转发到目标'
          }
          throw new Error(`${stageText[err.stage] ?? '代理错误'}：${err.message}`)
        }
        throw err
      }
    })
  )

  /* --------------------------- 公共凭据 ---------------------------- */

  ipcMain.handle(IPC.sharedList, safe(() => services.sharedCredentials.list()))

  /**
   * 新建或更新公共凭据。
   * 凭据内容写进保险箱，这里只保存名字与引用。
   */
  ipcMain.handle(
    IPC.sharedSave,
    safe(
      (input: {
        id?: string
        name: string
        kind: import('@shared/types.js').SharedCredential['kind']
        username?: string
        domain?: string
        note?: string
        /** 新建或替换内容时提供 */
        secret?: string
        passphrase?: string
      }) => {
        if (!input.name?.trim()) throw new Error('请填写名称')
        if (!['password', 'privateKey'].includes(input.kind)) throw new Error('凭据类型无效')
        const previous = input.id ? services.sharedCredentials.get(input.id) : null
        if (input.id && !previous) throw new Error('公共凭据不存在，请刷新后重试')
        if (previous && previous.kind !== input.kind) throw new Error('已有凭据不能更改类型，请新建另一条凭据')

        let ref: string | undefined
        if (input.id) {
          ref = services.sharedCredentials.get(input.id)?.credentialRef
        }

        // 有内容就（重新）写入保险箱
        if (input.secret?.length) {
          if (!ref) ref = newCredentialRef()
          const existing = previous ? services.vault.getCredential(ref) : null
          services.vault.setCredential(ref, input.secret, input.passphrase ?? existing?.passphrase)
        } else if (input.passphrase !== undefined && ref) {
          // 只改口令：沿用已有内容，避免把凭据清空
          const existing = services.vault.getCredential(ref)
          if (existing?.secret) {
            services.vault.setCredential(ref, existing.secret, input.passphrase)
          }
        }

        if (!ref) throw new Error('请填写凭据内容')

        const saved = services.sharedCredentials.save({
          id: input.id,
          name: input.name,
          kind: input.kind,
          username: input.username,
          domain: input.domain,
          note: input.note,
          credentialRef: ref
        })
        broadcast(IPC.push.connectionChecksChanged, undefined)
        return saved
      }
    )
  )

  ipcMain.handle(
    IPC.sharedDelete,
    safe((id: string) => {
      const usage = services.sharedCredentials.countUsage(id, services.connections.list())
      if (usage) throw new Error(`该凭据仍被 ${usage} 条连接使用，请先更换这些连接的凭据来源再删除`)
      const item = services.sharedCredentials.get(id)
      if (item) {
        try {
          services.vault.deleteCredential(item.credentialRef)
        } catch {
          /* 保险箱锁定时删不掉，仅移除引用 */
        }
      }
      const removed = services.sharedCredentials.delete(id)
      broadcast(IPC.push.connectionChecksChanged, undefined)
      return removed
    })
  )

  /** 某条公共凭据被多少连接引用 —— 删除前提示影响范围 */
  ipcMain.handle(
    IPC.sharedUsage,
    safe((id: string) => services.sharedCredentials.countUsage(id, services.connections.list()))
  )

  /* ---------------------- XTerminal 配置导入 ---------------------- */

  /** 扫描 XTerminal 的本地配置库，返回待导入项（不写入任何东西） */
  ipcMain.handle(IPC.rdoScan, safe(async () => {
    const window = getPrimaryWindow()
    if (!window || window.isDestroyed()) throw new Error('请在主窗口中选择 RDO 文件')
    const choice = await dialog.showOpenDialog(window, { title: '导入 Remote Desktop Organizer 配置', properties: ['openFile'],
      filters: [{ name: 'Remote Desktop Organizer', extensions: ['rdo'] }] })
    if (choice.canceled || !choice.filePaths[0]) return null
    const { scanRdo } = await import('../services/rdo-import.js')
    return scanRdo(choice.filePaths[0], services.connections.list())
  }))

  ipcMain.handle(
    IPC.xtScan,
    safe(async () => {
      const { locateXTerminalDb, scanXTerminal } = await import('../services/xt-import.js')
      const dbPath = locateXTerminalDb()
      if (!dbPath) {
        throw new Error(
          '没有找到 XTerminal 的配置库。请确认 XTerminal 已在本机运行过，' +
            '或它使用了非默认的数据目录。'
        )
      }
      return scanXTerminal(dbPath, services.connections.list())
    })
  )

  /** 执行导入：只写入用户勾选的项 */
  ipcMain.handle(
    IPC.xtApply,
    safe(async (scanId: string, candidates: import('@shared/types.js').ImportCandidate[], skipDuplicates = true) => {
      const { candidateToConnection, takeImportCredential } = await import('../services/xt-import.js')
      if (!Array.isArray(candidates) || candidates.length > 10000) throw new Error('导入记录数量不正确')
      const known = new Set(services.connections.list().map(connectionKey))
      let duplicates = 0
      for (const candidate of candidates) {
        const key = connectionKey(candidate)
        if (known.has(key)) duplicates++
        known.add(key)
      }
      if (duplicates && !skipDuplicates) {
        const answer = await dialog.showMessageBox({ type: 'question', title: '导入重复连接', message: `所选连接包含 ${duplicates} 条重复服务器，确定仍然新增？`, buttons: ['取消', '仍然导入'], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) throw new Error('已取消导入')
      }
      let created = 0, skipped = 0, credentials = 0
      const failed: Array<{ name: string; reason: string }> = []
      for (const candidate of candidates) {
        let ref: string | undefined
        try {
          if (skipDuplicates && services.connections.duplicates(candidate).length) { skipped++; continue }
          const credential = takeImportCredential(scanId, candidate.tempId)
          const connection = candidateToConnection(candidate)
          if (credential) {
            ref = newCredentialRef()
            services.vault.setCredential(ref, credential.secret, credential.passphrase)
            connection.credentialRef = ref
          }
          services.connections.save(connection, !skipDuplicates)
          created++
          if (credential) credentials++
        } catch (error) {
          if (ref) { try { services.vault.deleteCredential(ref) } catch {} }
          failed.push({ name: candidate.name, reason: error instanceof Error ? error.message : '导入失败' })
        }
      }
      return { created, skipped, credentials, failed }
    })
  )

  /* --------------------------- 端口转发 ---------------------------- */

  ipcMain.handle(IPC.forwardList, safe((connectionId?: string) => services.forwards.list(connectionId)))

  ipcMain.handle(
    IPC.forwardSave,
    safe((rule: import('@shared/types.js').PortForwardRule) => services.forwards.save(rule))
  )

  ipcMain.handle(
    IPC.forwardDelete,
    safe(async (ruleId: string) => {
      await services.forwards.remove(ruleId)
      return true
    })
  )

  ipcMain.handle(
    IPC.forwardStart,
    safe((ruleId: string) => services.forwards.start(ruleId))
  )

  ipcMain.handle(
    IPC.forwardStop,
    safe((ruleId: string) => {
      services.forwards.stop(ruleId)
      return true
    })
  )

  ipcMain.handle(IPC.forwardStatus, safe(() => services.forwards.statusAll()))

  /* ------------------------------ RDP ----------------------------- */

  ipcMain.handle(IPC.rdpNativeStatus, safe(() => services.freeRdp.status()))

  ipcMain.handle(
    IPC.rdpPrepare,
    (event, connectionId: string) => safe(async () => {
      const conn = services.connections.get(connectionId)
      if (!conn) throw new Error('连接不存在')
      if (conn.kind !== 'rdp') throw new Error('该连接不是 RDP 类型')

      // 凭据解析：公共凭据优先，其次连接自己的
      const cred = resolveConnectionCredential(conn, services.sharedCredentials, services.vault)
      if (!cred?.secret) throw new Error('此 RDP 连接尚未保存密码，请编辑连接或选择一条公共凭据')

      // ---- 连通性预检 ----
      // 必须在这里做，不能等 WASM 报错。
      // 原因：TCP 层的失败原因（拒绝连接/超时/不可达）跨越 WASM 边界后就丢了，
      // 渲染进程只能拿到一个笼统的「通用错误」，用户完全不知道该查什么。
      // 在进 WASM 之前先探一次，错误信息才说得清。
      const endpoint = parseConnectionAddress(conn.host, conn.port)
      const engine = process.platform === 'win32' && process.arch === 'x64' ? 'freerdp' : conn.options?.engine ?? 'ironrdp'
      const options = { ...conn.options, engine }
      if (options.securityMode === 'legacy') {
        if (engine !== 'freerdp') throw new Error('旧版 RDP 安全层需要 FreeRDP 引擎')
        if (!await services.rdpLegacyConsent.authorize({ ...conn, username: cred.username, domain: cred.domain ?? '' }, new AbortController().signal, false, BrowserWindow.fromWebContents(event.sender) ?? undefined)) throw new Error('已取消旧版 RDP 安全层连接')
        if (JSON.stringify(services.connections.get(connectionId)) !== JSON.stringify(conn)) throw new Error('连接配置已变化，请重新连接')
      }
      await preflightTarget(endpoint.host, endpoint.port, conn.proxy)

      if (engine === 'freerdp') {
        const transport = await services.freeRdp.prepare(endpoint.host, endpoint.port, { username: cred.username, password: cred.secret, domain: cred.domain ?? '' }, options, conn.proxy, conn)
        return { engine: 'freerdp' as const, transport, username: '', password: '', domain: '', destination: rdpAddress(endpoint.host, endpoint.port), options }
      }
      const transport = await services.rdp.prepare(endpoint.host, endpoint.port, conn.options ?? {}, conn.proxy)
      return {
        transport,
        // 凭据只经内存传一次给渲染进程，不落盘
        username: cred.username,
        password: cred?.secret ?? '',
        domain: cred.domain ?? '',
        destination: rdpAddress(endpoint.host, endpoint.port),
        options: conn.options ?? {}
      }
    })(event)
  )

  ipcMain.handle(IPC.rdpRetryLegacy, (event, connectionId: string, sessionId: string) => safe(async () => {
    const connection = services.connections.get(connectionId)
    if (!connection || connection.kind !== 'rdp') throw new Error('连接不存在或类型不符')
    const result = await services.freeRdp.requestLegacyRetry(sessionId, connection, async signal => {
      if (JSON.stringify(services.connections.get(connectionId)) !== JSON.stringify(connection)) return false
      const credential = resolveConnectionCredential(connection, services.sharedCredentials, services.vault)
      if (!credential?.secret) throw new Error('此 RDP 连接尚未保存密码，请编辑连接或选择一条公共凭据')
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || owner.isDestroyed()) return false
      return services.rdpLegacyConsent.authorize({ ...connection, username: credential.username, domain: credential.domain ?? '' }, signal, true, owner)
    })
    if (result !== 'accepted') return result
    if (JSON.stringify(services.connections.get(connectionId)) !== JSON.stringify(connection)) throw new Error('连接配置已变化，未切换安全层，请重新连接')
    services.connections.save({ ...connection, options: { ...connection.options, engine: 'freerdp', securityMode: 'legacy' } })
    return result
  })(event))

  ipcMain.handle(
    IPC.rdpRelease,
    safe((sessionId: string) => {
      services.rdp.release(sessionId)
      services.freeRdp.release(sessionId)
      return true
    })
  )

  ipcMain.handle(IPC.rdpGetError, safe((sessionId: string) => services.freeRdp.getError(sessionId) ?? services.rdp.getError(sessionId)))

  ipcMain.handle(IPC.rdpClipboardRead, (event, sessionId: string) => safe(async () => {
    if (!event.sender.isFocused() || !(services.rdp.allowsClipboard(sessionId) || services.freeRdp.allowsClipboard(sessionId))) throw new Error('请聚焦已开启剪贴板的远程桌面后重试')
    const text = await clipboard.readText()
    if (text.length > 1024 * 1024) throw new Error('剪贴板文本超过 1M 字符，请分段粘贴')
    return text
  })(event))

  ipcMain.handle(IPC.rdpClipboardFiles, (event, sessionId: string, action: 'paste' | 'offer' | 'receive' | 'cancel' | 'cancel-paste' | 'sync-text') => safe(async () => {
    return services.freeRdp.clipboardFiles(sessionId, action, () => !event.sender.isDestroyed() && event.sender.isFocused())
  })(event))

  ipcMain.handle(IPC.rdpClipboardWrite, (event, sessionId: string, text: string) => safe(async () => {
    if (!event.sender.isFocused() || !(services.rdp.allowsClipboard(sessionId) || services.freeRdp.allowsClipboard(sessionId))) throw new Error('请聚焦已开启剪贴板的远程桌面后重试')
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('剪贴板文本格式不正确或超过 1M 字符')
    await clipboard.writeText(text)
    return true
  })(event))

  ipcMain.handle(
    IPC.rdpLaunchSystemClient,
    safe(async (connectionId: string) => {
      const conn = services.connections.get(connectionId)
      if (!conn || conn.kind !== 'rdp') throw new Error('连接不存在或类型不符')

      const credential = resolveConnectionCredential(conn, services.sharedCredentials, services.vault)
      const window = getPrimaryWindow()
      const display = window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay()
      return await launchSystemRdp(conn, credential, screen.dipToScreenRect(null, conn.options?.fullscreen ? display.bounds : display.workArea))
    })
  )

  /* ---------------------------- 监控指标 --------------------------- */

  ipcMain.handle(IPC.metricsProbe, safe(async (connectionId: string) => {
    const connection = services.connections.get(connectionId)
    if (!connection) throw new Error('连接不存在')
    const started = Date.now()
    const endpoint = parseConnectionAddress(connection.host, connection.port)
    await preflightTarget(endpoint.host, endpoint.port, connection.proxy)
    return { latencyMs: Date.now() - started, timestamp: Date.now() }
  }))

  ipcMain.handle(
    IPC.metricsCollect,
    safe(async (sessionId: string, withProcesses?: boolean) => {
      const metrics = await services.metrics.collect(sessionId, withProcesses)
      return metrics
    })
  )

  ipcMain.handle(IPC.monitorWindowsCommand, safe((input: import('@shared/monitoring').MonitorInstallInput) => windowsMonitorCommand(services.monitoring, services.connections, input)))
  ipcMain.handle(IPC.monitorWindowsBundle,safe(async(input:import('@shared/monitoring').MonitorInstallInput)=>{
    const chosen=await dialog.showSaveDialog({title:'保存 Windows 监控安装脚本',defaultPath:'OmniDesk-Monitor-Install.ps1',filters:[{name:'PowerShell 安装脚本',extensions:['ps1']}]})
    if(chosen.canceled||!chosen.filePath)return {cancelled:true}
    const bundle=await windowsMonitorBundle(services.monitoring,services.connections,app.isPackaged?join(process.resourcesPath,'monitor-agent'):join(app.getAppPath(),'out/monitor-agent'),input)
    writeFileSync(chosen.filePath,'\ufeff'+bundle.contents,{encoding:'utf8',mode:0o600})
    return {cancelled:false,path:chosen.filePath,installationId:bundle.installationId}
  }))
  ipcMain.handle(IPC.monitorLocal, safe(() => services.monitoring.local()))
  ipcMain.handle(IPC.monitorConfigure, safe(input => services.monitoring.configure(input)))
  ipcMain.handle(IPC.monitorSaveEntry, safe((input: MonitorEntry) => services.monitoring.saveEntry(input)))
  ipcMain.handle(IPC.monitorRemoveEntry, safe((id: string) => services.monitoring.removeEntry(id)))
  ipcMain.handle(IPC.monitorLocalHistory, safe((id: string) => services.monitoring.localHistory(id)))
  ipcMain.handle(IPC.monitorProbe,safe((id:string)=>{if(!/^[a-f0-9]{24}$/.test(id))throw new Error('无效节点');return services.monitoring.request<{requestId:string}>('/v1/nodes/'+id+'/probe','POST')}))
  ipcMain.handle(IPC.monitorUnclaimed,safe(()=>services.monitoring.request<MonitorNode[]>('/v1/unclaimed')))
  ipcMain.handle(IPC.monitorClaim,safe((id:string)=>{if(!/^[a-f0-9]{24}$/.test(id))throw new Error('无效节点');return services.monitoring.request<{ok:boolean}>('/v1/nodes/'+id+'/claim','POST')}))
  ipcMain.handle(IPC.monitorNodes, safe(() => services.monitoring.request<MonitorNode[]>('/v1/nodes')))
  ipcMain.handle(IPC.monitorTest, safe(async () => {
    await services.monitoring.request<MonitorNode[]>('/v1/nodes')
    return services.monitoring.request<{ service: string; protocol: number }>('/healthz')
  }))
  ipcMain.handle(IPC.monitorSaveNode, safe((input: { id?: string; name: string; group: string; asset: MonitorEntry['asset'] }) => {
    if (input.id && !/^[a-f0-9]{24}$/.test(input.id)) throw new Error('无效节点')
    return services.monitoring.saveNode(input)
  }))
  ipcMain.handle(IPC.monitorRotateToken, safe((id: string) => {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('无效节点')
    return services.monitoring.rotateAgentToken(id)
  }))
  ipcMain.handle(IPC.monitorAgentInstallInfo, safe((id: string) => { const info = services.monitoring.agentInstallation(id); return { hasToken: !!info.token, connectionId: info.connectionId } }))
  ipcMain.handle(IPC.monitorPrepareAgentNode, safe((id: string) => services.monitorAgentInstaller.prepareNode(id)))
  ipcMain.handle(IPC.monitorRemoveNode, safe((id: string) => services.monitorAgentInstaller.removeNode(id)))
  ipcMain.handle(IPC.monitorSessionInfo, safe((id: string) => services.monitorAgentInstaller.sessionInfo(id)))
  ipcMain.handle(IPC.monitorInstallAgent, safe((input: import('@shared/monitoring').MonitorInstallInput) => services.monitorAgentInstaller.install(input)))
  ipcMain.handle(IPC.monitorHistory, safe((id: string, hours: number) => {
    if (!/^[a-f0-9]{24}$/.test(id) || ![1, 24, 168, 720].includes(hours)) throw new Error('无效历史查询')
    return services.monitoring.request<MonitorPoint[]>(`/v1/nodes/${id}/history?hours=${hours}`)
  }))
  ipcMain.handle(IPC.monitorAlerts, safe(() => services.monitoring.request<MonitorAlert[]>('/v1/alerts')))

  /* --------------------------- 对外能力 --------------------------- */

  ipcMain.handle(IPC.externalGetConfig, safe(() => services.settings.getExternalConfig()))

  ipcMain.handle(
    IPC.externalSetEnabled,
    safe((which: 'mcp' | 'api', enabled: boolean) => {
      const cfg = services.settings.setEnabled(which, enabled)
      // 启停实际服务
      if (which === 'mcp') {
        void (enabled ? startMcp() : stopMcp())
      } else {
        void (enabled ? startApi() : stopApi())
      }
      return cfg
    })
  )

  // 延迟引入，避免未启用时加载依赖
  const startMcp = async () => (await import('../mcp/server.js')).startMcpServer()
  const stopMcp = async () => (await import('../mcp/server.js')).stopMcpServer()
  const startApi = async () => (await import('../api/server.js')).startApiServer()
  const stopApi = async () => (await import('../api/server.js')).stopApiServer()

  ipcMain.handle(
    IPC.externalCreateToken,
    safe(
      (
        which: 'mcp' | 'api',
        label: string,
        scopes: import('@shared/types.js').ExternalScope[],
        allowWrite?: boolean
      ) => services.settings.createToken(which, label, scopes, allowWrite)
    )
  )

  ipcMain.handle(
    IPC.externalRevokeToken,
    safe((which: 'mcp' | 'api', tokenId: string) => services.settings.revokeToken(which, tokenId))
  )

  ipcMain.handle(
    IPC.externalApproveRequest,
    safe((requestId: string, approved: boolean) => {
      // 审批由 MCP 服务注册的回调处理
      const handler = (globalThis as { __omniApprovals?: Map<string, (v: boolean) => void> }).__omniApprovals
      const fn = handler?.get(requestId)
      if (fn) {
        fn(approved)
        handler!.delete(requestId)
      }
      return true
    })
  )
}
