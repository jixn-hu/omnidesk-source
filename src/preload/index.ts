/**
 * preload —— 渲染进程与主进程之间的唯一通道
 *
 * 安全约束：
 *   - 绝不把 ipcRenderer 本体暴露出去（那等于把整个主进程 API 交出去）
 *   - 只暴露一组语义明确的方法
 *   - 所有返回值统一是 IpcResult 信封，调用方需要判 ok
 */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import { openNativeSocket } from './native-socket'
import { IPC } from '@shared/ipc.js'
import type { MonitoringApi } from '@shared/monitoring'
import type {
  Connection,
  ConnectionCheck,
  ExecOptions,
  ExternalAccessConfig,
  ExternalScope,
  IpcResult,
  LocalSshKey,
  PortForwardRule,
  PortForwardStatus,
  ProxyConfig,
  SessionInfo,
  SharedCredential,
  VaultMode
} from '@shared/types.js'
import type { ConfigurationApi } from '@shared/types.js'
import type { OfficialAccountApi } from '@shared/account.js'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ai: {
    configuration: () => ipcRenderer.invoke(IPC.aiConfiguration),
    saveConfiguration: input => ipcRenderer.invoke(IPC.aiSaveConfiguration, input),
    test: () => ipcRenderer.invoke(IPC.aiTest),
    state: () => ipcRenderer.invoke(IPC.aiState),
    send: (text, ids, conversationId) => ipcRenderer.invoke(IPC.aiSend, text, ids, conversationId),
    confirm: (id, approved, conversationId) => ipcRenderer.invoke(IPC.aiConfirm, id, approved, conversationId),
    cancel: conversationId => ipcRenderer.invoke(IPC.aiCancel, conversationId),
    clear: conversationId => ipcRenderer.invoke(IPC.aiClear, conversationId),
    createConversation: () => ipcRenderer.invoke(IPC.aiCreateConversation),
    selectConversation: id => ipcRenderer.invoke(IPC.aiSelectConversation, id),
    deleteConversation: id => ipcRenderer.invoke(IPC.aiDeleteConversation, id),
    setPermissionMode: (mode, conversationId) => ipcRenderer.invoke(IPC.aiSetPermissionMode, mode, conversationId),
    onChange: callback => on(IPC.push.aiChanged, callback),
    onMetadataChanged: callback => on(IPC.push.aiMetadataChanged, callback)
  } satisfies import('@shared/ai').AiApi,
  updates: {
    status: () => ipcRenderer.invoke(IPC.updatesStatus),
    check: () => ipcRenderer.invoke(IPC.updatesCheck),
    setAutoCheck: enabled => ipcRenderer.invoke(IPC.updatesSetAutoCheck, enabled),
    openRelease: () => ipcRenderer.invoke(IPC.updatesOpenRelease),
    onChange: callback => on(IPC.push.updatesChanged, callback)
  } satisfies import('@shared/updates').AppUpdateApi,
  account: {
    openAdmin: () => ipcRenderer.invoke(IPC.accountOpenAdmin),
    status: () => ipcRenderer.invoke(IPC.accountStatus),
    onChanged: callback => { const listener=(_event:Electron.IpcRendererEvent,status:import('@shared/account').OfficialAccountStatus)=>callback(status); ipcRenderer.on(IPC.accountChanged,listener); return ()=>ipcRenderer.removeListener(IPC.accountChanged,listener) },
    switchAccount: (id: string) => ipcRenderer.invoke(IPC.accountSwitch,id),
    removeAccount: (id: string) => ipcRenderer.invoke(IPC.accountRemove, id),
    configure: (url: string) => ipcRenderer.invoke(IPC.accountConfigure, url),
    authenticate: (action: 'register' | 'login', username: string, password: string) => ipcRenderer.invoke(IPC.accountAuthenticate, action, username, password),
    providers: () => ipcRenderer.invoke(IPC.accountProviders),
    settings: () => ipcRenderer.invoke(IPC.accountSettings),
    saveSettings: (input) => ipcRenderer.invoke(IPC.accountSaveSettings, input),
    startGitlab: (mode) => ipcRenderer.invoke(IPC.accountGitlabStart, mode),
    pollGitlab: (id) => ipcRenderer.invoke(IPC.accountGitlabPoll, id),
    cancelGitlab: (id) => ipcRenderer.invoke(IPC.accountGitlabCancel, id),
    logout: () => ipcRenderer.invoke(IPC.accountLogout),
    upload: (options) => ipcRenderer.invoke(IPC.accountUpload, options),
    download: (options) => ipcRenderer.invoke(IPC.accountDownload, options),
    shares: (search: string, page: number) => ipcRenderer.invoke(IPC.accountShares, search, page),
    users: (search: string, page: number) => ipcRenderer.invoke(IPC.accountUsers, search, page),
    publish: (id: string) => ipcRenderer.invoke(IPC.accountPublish, id),
    publishMany: (ids) => ipcRenderer.invoke(IPC.accountPublishMany, ids),
    unpublish: (id: string) => ipcRenderer.invoke(IPC.accountUnpublish, id),
    unpublishMany: (ids) => ipcRenderer.invoke(IPC.accountUnpublishMany, ids),
    importShare: (id) => ipcRenderer.invoke(IPC.accountImportShare, id),
    connect: (id: string, width: number, height: number) => ipcRenderer.invoke(IPC.accountConnect, id, width, height),
    release: (id: string) => ipcRenderer.invoke(IPC.accountRelease, id)
  } satisfies OfficialAccountApi,
  credentialProbe: {
    start: (connections, credentials) => ipcRenderer.invoke(IPC.credentialProbeStart, connections, credentials),
    next: (id) => ipcRenderer.invoke(IPC.credentialProbeNext, id),
    finishRdp: (id, success) => ipcRenderer.invoke(IPC.credentialProbeFinish, id, success),
    cancel: (id) => ipcRenderer.invoke(IPC.credentialProbeCancel, id),
    apply: (id, connectionId) => ipcRenderer.invoke(IPC.credentialProbeApply, id, connectionId)
  } satisfies import('@shared/credential-probe').CredentialProbeApi,
  configuration: {
    onRestored: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, summary: import('@shared/types').ConfigurationSummary) => callback(summary)
      ipcRenderer.on(IPC.configurationRestored, listener)
      return () => ipcRenderer.removeListener(IPC.configurationRestored, listener)
    },
    exportMonitorData: (password) => ipcRenderer.invoke(IPC.configurationMonitorExport, password),
    decryptMonitorData: (password) => ipcRenderer.invoke(IPC.configurationMonitorDecrypt, password),
    passwordStatus: () => ipcRenderer.invoke(IPC.configurationPasswordStatus),
    savePassword: (password) => ipcRenderer.invoke(IPC.configurationSavePassword, password),
    exportFile: (password, options) => ipcRenderer.invoke(IPC.configurationExport, password, options),
    importFile: (password, options) => ipcRenderer.invoke(IPC.configurationImport, password, options),
    webdav: () => ipcRenderer.invoke(IPC.webdavConfiguration),
    saveWebdav: (configuration) => ipcRenderer.invoke(IPC.webdavSave, configuration),
    testWebdav: () => ipcRenderer.invoke(IPC.webdavTest),
    uploadWebdav: (password, options) => ipcRenderer.invoke(IPC.webdavUpload, password, options),
    downloadWebdav: (password, options) => ipcRenderer.invoke(IPC.webdavDownload, password, options)
  } satisfies ConfigurationApi,
  /* ---------------------------- 应用 ---------------------------- */
  app: {
    setZoomFactor: (factor: number): void => {
      if (![0.9, 1, 1.1, 1.25].includes(factor)) throw new Error('不支持的界面缩放比例')
      webFrame.setZoomFactor(factor)
    },
    info: () =>
      ipcRenderer.invoke(IPC.appInfo) as Promise<
        IpcResult<{ name: string; version: string; platform: string; electron: string; node: string }>
      >,
    /** 从拖入的 File 对象取出真实磁盘路径（Electron 30+ 起必须走 webUtils） */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    /** 读取本地文本文件（导入私钥用） */
    readTextFile: (filePath: string) =>
      ipcRenderer.invoke(IPC.fsReadText, filePath) as Promise<IpcResult<string>>,
    /** 扫描本机 SSH 私钥，供「一键选择」——省得用户自己去翻 .ssh 目录 */
    scanSshKeys: () =>
      ipcRenderer.invoke(IPC.sshScanLocalKeys) as Promise<IpcResult<LocalSshKey[]>>,
    /** 开一个新窗口。多窗口共享会话，新窗口能直接看到已连的机器 */
    openWindow: () => ipcRenderer.invoke(IPC.appOpenWindow) as Promise<IpcResult<{ id: number }>>,
    windowCount: () => ipcRenderer.invoke(IPC.appWindowCount) as Promise<IpcResult<number>>
  },

  /* ---------------------------- Vault ---------------------------- */
  vault: {
    status: () => ipcRenderer.invoke(IPC.vaultStatus) as Promise<IpcResult<string>>,
    /** 传 password 走主密码模式；不传则创建免密码（设备密钥）保险箱 */
    init: (password?: string) => ipcRenderer.invoke(IPC.vaultInit, password) as Promise<IpcResult<string>>,
    unlock: (password?: string) => ipcRenderer.invoke(IPC.vaultUnlock, password) as Promise<IpcResult<string>>,
    lock: () => ipcRenderer.invoke(IPC.vaultLock) as Promise<IpcResult<string>>,
    changePassword: (oldPw: string, newPw: string) =>
      ipcRenderer.invoke(IPC.vaultChangePassword, oldPw, newPw) as Promise<IpcResult<boolean>>,
    getMode: () => ipcRenderer.invoke(IPC.vaultGetMode) as Promise<IpcResult<VaultMode | null>>,
    /** 尝试免密码解锁；返回是否成功 */
    autoUnlock: () => ipcRenderer.invoke(IPC.vaultAutoUnlock) as Promise<IpcResult<boolean>>,
    /** 切换保护模式（瞬间完成，不会重新加密数据） */
    setMode: (
      target: VaultMode,
      opts: { currentPassword?: string; newPassword?: string } = {}
    ) => ipcRenderer.invoke(IPC.vaultSetMode, target, opts) as Promise<IpcResult<void>>
  },

  /* --------------------------- 连接配置 --------------------------- */
  connections: {
    checks: () => ipcRenderer.invoke(IPC.connChecks) as Promise<IpcResult<Record<string, ConnectionCheck>>>,
    onChecksChanged: (cb: () => void) => on(IPC.push.connectionChecksChanged, cb),
    list: () => ipcRenderer.invoke(IPC.connList) as Promise<IpcResult<Connection[]>>,
    get: (id: string) => ipcRenderer.invoke(IPC.connGet, id) as Promise<IpcResult<Connection | null>>,
    save: (payload: Connection, credential?: { secret: string; passphrase?: string }) =>
      ipcRenderer.invoke(IPC.connSave, payload, credential) as Promise<IpcResult<Connection>>,
    batchMetadata: (request: import('@shared/server-metadata.js').BatchMetadataRequest) => ipcRenderer.invoke(IPC.connBatchMetadata, request) as Promise<IpcResult<Connection[]>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.connDelete, id) as Promise<IpcResult<boolean>>,
    groups: () => ipcRenderer.invoke(IPC.connGroups) as Promise<IpcResult<string[]>>
  },

  /* ----------------------------- SSH ----------------------------- */
  docker: {
    snapshot: (sessionId: string) => ipcRenderer.invoke(IPC.dockerSnapshot, sessionId) as Promise<IpcResult<import('@shared/docker.js').DockerSnapshot>>,
    remove: (sessionId: string, request: import('@shared/docker.js').DockerRemoveRequest) => ipcRenderer.invoke(IPC.dockerRemove, sessionId, request) as Promise<IpcResult<boolean>>
  },

  ssh: {
    connect: (connectionId: string, cols?: number, rows?: number, ownerId?: string) =>
      ipcRenderer.invoke(IPC.sshConnect, connectionId, cols, rows, ownerId) as Promise<IpcResult<SessionInfo>>,
    disconnect: (sessionId: string) =>
      ipcRenderer.invoke(IPC.sshDisconnect, sessionId) as Promise<IpcResult<boolean>>,
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke(IPC.sshWrite, sessionId, data) as Promise<IpcResult<boolean>>,
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.sshResize, sessionId, cols, rows) as Promise<IpcResult<boolean>>,
    list: () => ipcRenderer.invoke(IPC.sshList) as Promise<IpcResult<SessionInfo[]>>,
    exec: (sessionId: string, command: string, opts?: ExecOptions) =>
      ipcRenderer.invoke(IPC.sshExec, sessionId, command, opts),
    resolveHostKey: (sessionId: string, decision: { accept: boolean; remember: boolean }) =>
      ipcRenderer.invoke(IPC.sshHostKeyDecision, sessionId, decision) as Promise<IpcResult<boolean>>,

    onData: (cb: (p: { sessionId: string; data: Uint8Array }) => void) => on(IPC.push.sshData, cb),
    onClose: (cb: (p: { sessionId: string; reason?: string }) => void) => on(IPC.push.sshClose, cb),
    onSessionEvent: (cb: (p: SessionInfo) => void) => on(IPC.push.sessionEvent, cb),
    onHostKeyPrompt: (
      cb: (p: {
        sessionId: string
        host: string
        port: number
        fingerprint: string
        keyType: string
        changed: boolean
        previousFingerprint?: string
      }) => void
    ) => on(IPC.push.hostKeyPrompt, cb)
  },

  /* ----------------------------- SFTP ----------------------------- */
  sftp: {
    list: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.sftpList, sessionId, path),
    readFile: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.sftpReadFile, sessionId, path),
    writeFile: (sessionId: string, path: string, content: string, expectedContent?: string) =>
      ipcRenderer.invoke(IPC.sftpWriteFile, sessionId, path, content, expectedContent),
    createFile: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.sftpCreateFile, sessionId, path),
    mkdir: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.sftpMkdir, sessionId, path),
    rename: (sessionId: string, from: string, to: string) =>
      ipcRenderer.invoke(IPC.sftpRename, sessionId, from, to),
    remove: (sessionId: string, path: string, isDir: boolean) =>
      ipcRenderer.invoke(IPC.sftpDelete, sessionId, path, isDir),
    download: (sessionId: string, remotePath: string, defaultName: string) =>
      ipcRenderer.invoke(IPC.sftpDownload, sessionId, remotePath, defaultName),
    upload: (sessionId: string, remoteDir: string) => ipcRenderer.invoke(IPC.sftpUpload, sessionId, remoteDir),
    uploadFiles: (sessionId: string, remoteDir: string, files: File[]) => ipcRenderer.invoke(IPC.sftpUploadDropped, sessionId, remoteDir, files.map(file => webUtils.getPathForFile(file))),
    move: (sessionId: string, source: string, directory: string) => ipcRenderer.invoke(IPC.sftpMove, sessionId, source, directory),
    dragToLocal: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.sftpDragToLocal, sessionId, path),
    transfers: (sessionId?: string) => ipcRenderer.invoke(IPC.sftpTransferList, sessionId),
    cancelTransfer: (taskId: string) => ipcRenderer.invoke(IPC.sftpTransferCancel, taskId),
    onProgress: (cb: (p: unknown) => void) => on(IPC.push.transferProgress, cb)
  },

  /* ------------------------------ RDP ----------------------------- */
  rdp: {
    openNativeSocket,
    prepare: (connectionId: string) => ipcRenderer.invoke(IPC.rdpPrepare, connectionId),
    retryLegacy: (connectionId: string, sessionId: string) => ipcRenderer.invoke(IPC.rdpRetryLegacy, connectionId, sessionId),
    nativeStatus: () => ipcRenderer.invoke(IPC.rdpNativeStatus),
    release: (sessionId: string) => ipcRenderer.invoke(IPC.rdpRelease, sessionId),
    getError: (sessionId: string) => ipcRenderer.invoke(IPC.rdpGetError, sessionId) as Promise<IpcResult<string | null>>,
    readClipboard: (sessionId: string) => ipcRenderer.invoke(IPC.rdpClipboardRead, sessionId) as Promise<IpcResult<string>>,
    writeClipboard: (sessionId: string, text: string) => ipcRenderer.invoke(IPC.rdpClipboardWrite, sessionId, text) as Promise<IpcResult<boolean>>,
    clipboardFiles: (sessionId: string, action: 'paste' | 'offer' | 'receive' | 'cancel' | 'cancel-paste' | 'sync-text') => ipcRenderer.invoke(IPC.rdpClipboardFiles, sessionId, action) as Promise<IpcResult<boolean | 'remote'>>,
    launchSystemClient: (connectionId: string) =>
      ipcRenderer.invoke(IPC.rdpLaunchSystemClient, connectionId) as Promise<IpcResult<boolean>>
  },

  /* ------------------------------ 代理 ----------------------------- */
  proxy: {
    /** 经代理连一次目标，验证配置是否正确 */
    test: (proxy: ProxyConfig, host: string, port: number) =>
      ipcRenderer.invoke(IPC.proxyTest, proxy, host, port) as Promise<IpcResult<{ ok: boolean }>>
  },

  /* ---------------------------- 公共凭据 --------------------------- */
  shared: {
    list: () => ipcRenderer.invoke(IPC.sharedList) as Promise<IpcResult<SharedCredential[]>>,
    save: (input: {
      id?: string
      name: string
      kind: SharedCredential['kind']
      username?: string
      domain?: string
      note?: string
      secret?: string
      passphrase?: string
    }) => ipcRenderer.invoke(IPC.sharedSave, input) as Promise<IpcResult<SharedCredential>>,
    remove: (id: string) => ipcRenderer.invoke(IPC.sharedDelete, id) as Promise<IpcResult<boolean>>,
    /** 该凭据被多少连接引用 */
    usage: (id: string) => ipcRenderer.invoke(IPC.sharedUsage, id) as Promise<IpcResult<number>>
  },

  /* ------------------- XTerminal 配置导入 -------------------- */
  rdo: { scan: () => ipcRenderer.invoke(IPC.rdoScan) },
  xt: {
    /** 扫描 XTerminal 配置库。只读，不写入任何东西 */
    scan: () => ipcRenderer.invoke(IPC.xtScan),
    /** 导入用户确认后的连接 */
    apply: (scanId: string, candidates: import('@shared/types').ImportCandidate[], skipDuplicates = true) => ipcRenderer.invoke(IPC.xtApply, scanId, candidates, skipDuplicates)
  },

  /* ---------------------------- 端口转发 --------------------------- */
  forwards: {
    list: (connectionId?: string) =>
      ipcRenderer.invoke(IPC.forwardList, connectionId) as Promise<IpcResult<PortForwardRule[]>>,
    save: (rule: PortForwardRule) =>
      ipcRenderer.invoke(IPC.forwardSave, rule) as Promise<IpcResult<PortForwardRule>>,
    remove: (ruleId: string) =>
      ipcRenderer.invoke(IPC.forwardDelete, ruleId) as Promise<IpcResult<boolean>>,
    start: (ruleId: string) =>
      ipcRenderer.invoke(IPC.forwardStart, ruleId) as Promise<IpcResult<PortForwardStatus>>,
    stop: (ruleId: string) =>
      ipcRenderer.invoke(IPC.forwardStop, ruleId) as Promise<IpcResult<boolean>>,
    status: () => ipcRenderer.invoke(IPC.forwardStatus) as Promise<IpcResult<PortForwardStatus[]>>,
    onStatus: (cb: (p: PortForwardStatus) => void) => on(IPC.push.forwardStatus, cb),
    onError: (cb: (p: { ruleId: string; message: string }) => void) => on(IPC.push.forwardError, cb)
  },

  /* ---------------------------- 监控指标 --------------------------- */
  monitoring: {
    local: () => ipcRenderer.invoke(IPC.monitorLocal),
    windowsInstallCommand: input => ipcRenderer.invoke(IPC.monitorWindowsCommand, input),
    exportWindowsInstaller: input => ipcRenderer.invoke(IPC.monitorWindowsBundle,input),
    configure: input => ipcRenderer.invoke(IPC.monitorConfigure, input),
    saveEntry: entry => ipcRenderer.invoke(IPC.monitorSaveEntry, entry),
    removeEntry: id => ipcRenderer.invoke(IPC.monitorRemoveEntry, id),
    localHistory: id => ipcRenderer.invoke(IPC.monitorLocalHistory, id),
    nodes: () => ipcRenderer.invoke(IPC.monitorNodes),
    requestProbe: id => ipcRenderer.invoke(IPC.monitorProbe,id),
    unclaimed: () => ipcRenderer.invoke(IPC.monitorUnclaimed),
    claim: id => ipcRenderer.invoke(IPC.monitorClaim,id),
    test: () => ipcRenderer.invoke(IPC.monitorTest),
    saveNode: input => ipcRenderer.invoke(IPC.monitorSaveNode, input),
    prepareAgentNode: id => ipcRenderer.invoke(IPC.monitorPrepareAgentNode, id),
    removeNode: id => ipcRenderer.invoke(IPC.monitorRemoveNode, id),
    sessionInfo: id => ipcRenderer.invoke(IPC.monitorSessionInfo, id),
    agentInstallInfo: id => ipcRenderer.invoke(IPC.monitorAgentInstallInfo, id),
    installAgent: input => ipcRenderer.invoke(IPC.monitorInstallAgent, input),
    onAgentInstallProgress: callback => on(IPC.monitorAgentInstallProgress, callback),
    rotateToken: id => ipcRenderer.invoke(IPC.monitorRotateToken, id),
    history: (id, hours) => ipcRenderer.invoke(IPC.monitorHistory, id, hours),
    alerts: () => ipcRenderer.invoke(IPC.monitorAlerts)
  } satisfies MonitoringApi,
  metrics: {
    probe: (connectionId: string) => ipcRenderer.invoke(IPC.metricsProbe, connectionId),
    collect: (sessionId: string, withProcesses?: boolean) =>
      ipcRenderer.invoke(IPC.metricsCollect, sessionId, withProcesses)
  },

  /* --------------------------- 对外能力 --------------------------- */
  external: {
    config: () => ipcRenderer.invoke(IPC.externalGetConfig) as Promise<IpcResult<ExternalAccessConfig>>,
    setEnabled: (which: 'mcp' | 'api', enabled: boolean) =>
      ipcRenderer.invoke(IPC.externalSetEnabled, which, enabled) as Promise<IpcResult<ExternalAccessConfig>>,
    createToken: (which: 'mcp' | 'api', label: string, scopes: ExternalScope[], allowWrite?: boolean) =>
      ipcRenderer.invoke(IPC.externalCreateToken, which, label, scopes, allowWrite),
    revokeToken: (which: 'mcp' | 'api', tokenId: string) =>
      ipcRenderer.invoke(IPC.externalRevokeToken, which, tokenId) as Promise<IpcResult<ExternalAccessConfig>>,
    approve: (requestId: string, approved: boolean) =>
      ipcRenderer.invoke(IPC.externalApproveRequest, requestId, approved) as Promise<IpcResult<boolean>>,
    onApprovalRequest: (cb: (p: { requestId: string; operation: string; detail: string }) => void) =>
      on(IPC.push.externalApprovalRequest, cb)
  }
}

contextBridge.exposeInMainWorld('omnidesk', api)

export type OmniDeskApi = typeof api
