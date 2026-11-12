import { createBackupModules } from './backup-modules.js'
/**
 * 服务容器
 *
 * 所有服务在这里实例化并串起来。主进程只依赖这个容器，
 * 不直接 new 具体服务 —— 保证依赖关系集中可查。
 */
import { app, dialog, net, Notification } from 'electron'
import { MonitoringService } from './monitoring.js'
import { MonitorAgentInstaller } from './monitor-agent-installer.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { VaultService } from './vault.js'
import { ConnectionStore } from './connection-store.js'
import { SshService } from './ssh.js'
import { DockerService } from './docker.js'
import { SftpService } from './sftp.js'
import { RdpProxyService } from './rdp-proxy.js'
import { FreeRdpService } from './freerdp.js'
import { RdpCertificateVerifier } from './rdp-certificates.js'
import { RdpLegacyConsent } from './rdp-security.js'
import { parseConnectionAddress } from '@shared/connection-identity.js'
import { ConfigurationBackupService, recoverConfigurationImport, type ConfirmConfiguration } from './config-backup.js'
import { WebDavSyncService } from './webdav-sync.js'
import { OfficialAccountService } from './official-account.js'
import { AiService } from './ai.js'
import { executeAiSsh } from './ai-ssh.js'
import { inspectAiWindows, windowsUsername } from './ai-windows.js'
import { IPC } from '@shared/ipc.js'
import { AppUpdateService } from './app-updates.js'
import { broadcast, getPrimaryWindow } from '../windows.js'
import { CredentialProbeService } from './credential-probe.js'
import { MetricsService } from './metrics.js'
import { SettingsService } from './settings.js'
import { PortForwardService } from './port-forward.js'
import { SharedCredentialStore } from './shared-credentials.js'
import { resolveConnectionCredential } from './credential-resolver.js'
import { SETTINGS_FILE } from '@shared/constants.js'
import type { ExternalAccessConfig, PortForwardRule } from '@shared/types.js'

class ServiceContainer {
  private ready = false

  vault!: VaultService
  connections!: ConnectionStore
  ssh!: SshService
  sftp!: SftpService
  docker!: DockerService
  rdp!: RdpProxyService
  freeRdp!: FreeRdpService
  rdpLegacyConsent!: RdpLegacyConsent
  credentialProbe!: CredentialProbeService
  monitorAgentInstaller!: MonitorAgentInstaller
  monitoring!: MonitoringService
  metrics!: MetricsService
  settings!: SettingsService
  forwards!: PortForwardService
  sharedCredentials!: SharedCredentialStore
  backup!: ConfigurationBackupService
  webdav!: WebDavSyncService
  account!: OfficialAccountService
  updates!: AppUpdateService
  ai!: AiService

  private knownHostsPath = ''
  private forwardsPath = ''

  async init(): Promise<void> {
    if (this.ready) return

    const userData = app.getPath('userData')
    mkdirSync(userData, { recursive: true })
    recoverConfigurationImport(userData)

    this.knownHostsPath = join(userData, 'known-hosts.json')

    this.vault = new VaultService(userData)
    this.connections = new ConnectionStore(userData)
    this.settings = new SettingsService(join(userData, SETTINGS_FILE))
    this.updates = new AppUpdateService(userData, app.getVersion(), (input, init) => net.fetch(input instanceof URL ? input.href : input, init))
    this.sharedCredentials = new SharedCredentialStore(userData)
    const confirmConfiguration: ConfirmConfiguration = async (message, detail) => {
      const window = getPrimaryWindow()
      if (!window || window.isDestroyed()) return false
      const result = await dialog.showMessageBox(window, { type: 'warning', title: '配置备份与同步', message, detail, buttons: ['取消', '确认继续'], defaultId: 0, cancelId: 0 })
      return result.response === 1
    }
    this.backup = new ConfigurationBackupService(userData, this.connections, this.sharedCredentials, this.vault, confirmConfiguration)
    this.webdav = new WebDavSyncService(userData, this.vault, this.backup, confirmConfiguration)
    this.account = new OfficialAccountService(userData, this.vault, this.backup, async (message, detail) => {
      const window = getPrimaryWindow()
      if (!window || window.isDestroyed()) return false
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '官方账号 · 共享服务器', message, detail, buttons: ['取消', '确认继续'], defaultId: 0, cancelId: 0 })
      return answer.response === 1
    })

    this.ssh = new SshService(
      // 解析顺序：公共凭据优先 → 连接自己的凭据。
      // 这样把一条连接切到公共凭据后，改公共凭据就能影响所有引用它的连接。
      (conn) => {
        try {
          return resolveConnectionCredential(conn, this.sharedCredentials, this.vault)
        } catch {
          // 保险箱锁定时会抛错，返回 null 让上层给出可读提示
          return null
        }
      },
      () => this.loadKnownHosts(),
      (hosts) => this.saveKnownHosts(hosts)
    )

    this.sftp = new SftpService(this.ssh)
    this.docker = new DockerService(this.ssh)
    const rdpCertificates = new RdpCertificateVerifier(userData, async (certificate, signal) => {
      const window = getPrimaryWindow()
      if (!window || window.isDestroyed() || signal.aborted) return 'reject'
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '验证远程桌面身份',
        message: certificate.previousFingerprint ? '远程桌面证书需要重新确认' : '无法自动验证远程桌面服务器身份',
        detail: `目标：${certificate.host}:${certificate.port}\n\n原因：${certificate.reason}\n\n主体：${certificate.subject}\n颁发者：${certificate.issuer}\n有效期：${certificate.validFrom} — ${certificate.validTo}\n\nSHA-256 指纹：\n${certificate.fingerprint}` +
          (certificate.previousFingerprint ? `\n\n之前信任的指纹：\n${certificate.previousFingerprint}` : '') +
          '\n\n请与服务器管理员核对指纹；未确认前不会发送账号密码。NLA 保持启用。',
        buttons: ['拒绝连接', '信任此证书并连接'],
        defaultId: 0,
        cancelId: 0,
        checkboxLabel: '记住此目标的证书（证书变化时再次确认）',
        checkboxChecked: false,
        signal
      })
      return result.response === 1 ? result.checkboxChecked ? 'remember' : 'once' : 'reject'
    })
    this.rdp = new RdpProxyService(rdpCertificates)
    this.rdpLegacyConsent = new RdpLegacyConsent(userData, async (connection, automatic, signal, owner) => {
      const window = owner ?? getPrimaryWindow()
      if (!window || window.isDestroyed() || signal.aborted) return false
      const endpoint = parseConnectionAddress(connection.host, connection.port)
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '旧版 RDP 安全层',
        message: automatic ? `服务器 ${endpoint.host}:${endpoint.port} 仅接受旧版 RDP 安全层，是否切换？` : `确认以旧版安全层连接 ${endpoint.host}:${endpoint.port}？`,
        detail: '旧版安全层不使用 TLS / NLA，无法提供现代服务器身份验证，安全性较低。仅对可信旧服务器使用；网络中的攻击者也可能伪造协商拒绝，请先确认目标可信。' +
          (automatic ? '\n\n同意后仅将此服务器改为旧版模式并自动重连，以后按此配置连接。取消则保留 TLS / NLA，不会用旧版模式发送账号密码。' : '\n\n同意后记住此服务器的选择；服务器地址或账号配置变化后需重新确认。') +
          '\n\n不会修改服务器策略，也不会关闭服务器 NLA。可随时在连接配置中改回 TLS / NLA。',
        buttons: [automatic ? '保持 TLS / NLA' : '取消', automatic ? '同意切换并记住' : '了解风险，继续连接'],
        defaultId: 0,
        cancelId: 0,
        signal
      })
      return result.response === 1
    })
    this.freeRdp = new FreeRdpService(app.isPackaged ? join(process.resourcesPath, 'freerdp') : join(app.getAppPath(), 'out/native-freerdp'), rdpCertificates, undefined, undefined, join(userData, 'logs'))
    this.credentialProbe = new CredentialProbeService(this.connections, this.sharedCredentials, this.vault, this.ssh, this.rdp)
    this.metrics = new MetricsService(this.ssh)
    this.monitoring = new MonitoringService(userData, this.vault, this.connections, (input, init) => net.fetch(input instanceof URL ? input.href : input, init), message => {
      if (Notification.isSupported()) new Notification({ title: '服务器到期提醒', body: message }).show()
    })
    this.monitoring.setAccountProvider(() => this.account.monitorContext(), <T>(path:string,method?:string,body?:unknown) => this.account.monitorRequest<T>(path,method,body))
    this.account.onContextChanged = (contextChanged = true) => { if (contextChanged) this.monitoring.accountChanged(); broadcast(IPC.accountChanged,this.account.status()) }
    this.monitorAgentInstaller = new MonitorAgentInstaller(this.monitoring, this.connections, this.ssh, app.isPackaged ? join(process.resourcesPath, 'monitor-agent') : join(app.getAppPath(), 'out/monitor-agent'), progress => broadcast(IPC.monitorAgentInstallProgress, progress))
    const aiDestination = (connection: import('@shared/types.js').Connection, actualUsername?: string) => {
      const address = parseConnectionAddress(connection.host, connection.port)
      const credential = resolveConnectionCredential(connection, this.sharedCredentials, this.vault)
      const name = actualUsername ?? (credential?.username || connection.username)
      const username = connection.kind === 'rdp' ? windowsUsername(name, credential?.domain ?? connection.domain) : name
      if (connection.kind === 'rdp') return `${username}@${address.host.includes(':') ? '[' + address.host + ']' : address.host}:135 (WMI/DCOM)`
      return `${username}@${address.host.includes(':') ? '[' + address.host + ']' : address.host}:${address.port}`
    }
    this.ai = new AiService(userData, this.connections, this.vault, {
      execute: (connection, command, signal, beforeExecute, conversationId) => executeAiSsh(this.ssh, this.vault, this.sharedCredentials, connection, command, signal,
        username => beforeExecute(aiDestination(connection, username)), conversationId),
      inspectWindows: (connection, topic, signal, beforeInspect) => inspectAiWindows(this.vault, this.sharedCredentials, connection, topic, signal,
        username => beforeInspect(aiDestination(connection, username))),
      metadataChanged: () => broadcast(IPC.push.aiMetadataChanged, undefined),
      destination: aiDestination
    })
    this.backup.onRestored = summary => broadcast(IPC.configurationRestored, summary)
    this.backup.modules = createBackupModules(userData, this.monitoring, this.ai, this.vault)
    this.ai.on('change', state => broadcast(IPC.push.aiChanged, state))

    // 端口转发：规则持久化到独立文件，应用重启后可恢复
    this.forwardsPath = join(userData, 'port-forwards.json')
    this.forwards = new PortForwardService(
      this.ssh,
      () => this.loadForwards(),
      (rules) => this.saveForwards(rules)
    )

    // SSH 会话断开时，关联的转发必须一起停 —— 否则会留下监听中的死端口
    this.ssh.on('close', (sessionId: string) => {
      this.forwards.onSessionClosed(sessionId)
    })

    this.ready = true
  }

  /**
   * 尝试免密码解锁。
   * 仅在「设备密钥」模式下会成功；主密码模式返回 false，需要界面弹输入框。
   * 应用启动、窗口就绪后调用 —— 这样用户不必看到任何解锁界面。
   */
  tryAutoUnlock(): boolean {
    try {
      return this.vault.tryAutoUnlock()
    } catch {
      return false
    }
  }

  private loadForwards(): PortForwardRule[] {
    try {
      if (!existsSync(this.forwardsPath)) return []
      const raw = JSON.parse(readFileSync(this.forwardsPath, 'utf8'))
      return Array.isArray(raw) ? (raw as PortForwardRule[]) : []
    } catch {
      return []
    }
  }

  private saveForwards(rules: PortForwardRule[]): void {
    try {
      writeFileSync(this.forwardsPath, JSON.stringify(rules, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  private loadKnownHosts(): Record<string, string> {
    try {
      if (!existsSync(this.knownHostsPath)) return {}
      return JSON.parse(readFileSync(this.knownHostsPath, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private saveKnownHosts(hosts: Record<string, string>): void {
    try {
      writeFileSync(this.knownHostsPath, JSON.stringify(hosts, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  /**
   * 确保某连接有一条可用的 SSH 会话。
   * 外部 API 与 MCP 都通过这个方法拿到会话 ——
   * 如果用户在界面上已经连了这台机器，就直接复用那条连接。
   */
  async ensureSession(connectionId: string): Promise<string> {
    const existing = this.ssh.findByConnectionId(connectionId)
    if (existing) return existing

    const conn = this.connections.get(connectionId)
    if (!conn) throw new Error(`连接不存在：${connectionId}`)
    if (conn.kind !== 'ssh') throw new Error('该连接不是 SSH 类型')

    const info = await this.ssh.connect(conn)
    return info.id
  }

  /** 对外访问配置 */
  getExternalConfig(): ExternalAccessConfig {
    return this.settings.getExternalConfig()
  }

  async dispose(): Promise<void> {
    this.ai?.dispose()
    this.updates?.dispose()
    this.account?.dispose()
    this.forwards?.dispose()
    this.ssh?.dispose()
    this.sftp?.dispose()
    await this.rdp?.dispose()
    await this.freeRdp?.dispose()
    this.vault?.lock()
    this.ready = false
  }
}

export const services = new ServiceContainer()
