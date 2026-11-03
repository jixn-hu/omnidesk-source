/**
 * window.omnidesk 的类型声明
 *
 * preload 通过 contextBridge 暴露的对象在渲染进程侧的形态。
 * 这里手写声明而不是直接 import preload 的类型，是为了让渲染进程
 * 与 preload 在编译期解耦（构建产物也不互相污染）。
 */
import type { OfficialAccountApi } from '@shared/account'
import type { AppUpdateApi } from '@shared/updates'
import type { RdpLegacyRetryResult } from '@shared/rdp-security'
import type {
  ConfigurationApi,
  Connection,
  ConnectionCheck,
  ExecOptions,
  ExecResult,
  ExternalAccessConfig,
  ExternalScope,
  ImportApplyResult,
  ImportScanResult,
  IpcResult,
  LocalSshKey,
  PortForwardRule,
  PortForwardStatus,
  ProxyConfig,
  RemoteFileEntry,
  ServerMetrics,
  SessionInfo,
  SharedCredential,
  TransferTask,
  VaultMode,
  VaultStatus,
  VpnConnectResult,
  VpnConnection
} from '@shared/types'

interface SessionEventPayload {
  sessionId: string
  data: Uint8Array
}

interface SshClosePayload {
  sessionId: string
  reason?: string
}

interface HostKeyPromptPayload {
  sessionId: string
  host: string
  port: number
  fingerprint: string
  keyType: string
  changed: boolean
  previousFingerprint?: string
}

interface ApprovalPayload {
  requestId: string
  operation: string
  detail: string
}

interface RdpPreparePayload {
  engine?: 'ironrdp' | 'freerdp'
  transport: { wsUrl: string; sessionId: string; token: string }
  username: string
  password: string
  domain: string
  destination: string
  options: Record<string, unknown>
}

type Unsub = () => void

export interface OmniDeskApi {
  account: OfficialAccountApi
  ai: import('@shared/ai').AiApi
  updates: AppUpdateApi
  credentialProbe: import('@shared/credential-probe').CredentialProbeApi
  configuration: ConfigurationApi
  app: {
    setZoomFactor: (factor: number) => void
    info: () => Promise<
      IpcResult<{ name: string; version: string; platform: string; electron: string; node: string }>
    >
    pathForFile: (file: File) => string
    readTextFile: (filePath: string) => Promise<IpcResult<string>>
    /** 扫描本机 SSH 私钥 */
    scanSshKeys: () => Promise<IpcResult<LocalSshKey[]>>
    openWindow: () => Promise<IpcResult<{ id: number }>>
    windowCount: () => Promise<IpcResult<number>>
  }
  vault: {
    status: () => Promise<IpcResult<VaultStatus>>
    init: (password?: string) => Promise<IpcResult<VaultStatus>>
    unlock: (password?: string) => Promise<IpcResult<VaultStatus>>
    lock: () => Promise<IpcResult<VaultStatus>>
    changePassword: (oldPw: string, newPw: string) => Promise<IpcResult<boolean>>
    getMode: () => Promise<IpcResult<VaultMode | null>>
    autoUnlock: () => Promise<IpcResult<boolean>>
    setMode: (
      target: VaultMode,
      opts?: { currentPassword?: string; newPassword?: string }
    ) => Promise<IpcResult<void>>
  }
  connections: {
    checks: () => Promise<IpcResult<Record<string, ConnectionCheck>>>
    onChecksChanged: (cb: () => void) => () => void
    list: () => Promise<IpcResult<Connection[]>>
    get: (id: string) => Promise<IpcResult<Connection | null>>
    save: (
      payload: Connection,
      credential?: { secret: string; passphrase?: string }
    ) => Promise<IpcResult<Connection>>
    batchMetadata: (request: import('@shared/server-metadata').BatchMetadataRequest) => Promise<IpcResult<Connection[]>>
    remove: (id: string) => Promise<IpcResult<boolean>>
    groups: () => Promise<IpcResult<string[]>>
  }
  ssh: {
    connect: (connectionId: string, cols?: number, rows?: number, ownerId?: string) => Promise<IpcResult<SessionInfo>>
    disconnect: (sessionId: string) => Promise<IpcResult<boolean>>
    write: (sessionId: string, data: string) => Promise<IpcResult<boolean>>
    resize: (sessionId: string, cols: number, rows: number) => Promise<IpcResult<boolean>>
    list: () => Promise<IpcResult<SessionInfo[]>>
    exec: (sessionId: string, command: string, opts?: ExecOptions) => Promise<IpcResult<ExecResult>>
    resolveHostKey: (
      sessionId: string,
      decision: { accept: boolean; remember: boolean }
    ) => Promise<IpcResult<boolean>>
    onData: (cb: (p: SessionEventPayload) => void) => Unsub
    onClose: (cb: (p: SshClosePayload) => void) => Unsub
    onSessionEvent: (cb: (p: SessionInfo) => void) => Unsub
    onHostKeyPrompt: (cb: (p: HostKeyPromptPayload) => void) => Unsub
  }
  sftp: {
    list: (
      sessionId: string,
      path: string
    ) => Promise<IpcResult<{ path: string; entries: RemoteFileEntry[] }>>
    readFile: (sessionId: string, path: string) => Promise<IpcResult<string>>
    writeFile: (sessionId: string, path: string, content: string, expectedContent?: string) => Promise<IpcResult<void>>
    createFile: (sessionId: string, path: string) => Promise<IpcResult<void>>
    mkdir: (sessionId: string, path: string) => Promise<IpcResult<void>>
    rename: (sessionId: string, from: string, to: string) => Promise<IpcResult<void>>
    remove: (sessionId: string, path: string, isDir: boolean) => Promise<IpcResult<void>>
    download: (sessionId: string, remotePath: string, defaultName: string) => Promise<IpcResult<TransferTask | null>>
    upload: (sessionId: string, remoteDir: string) => Promise<IpcResult<TransferTask[]>>
    uploadFiles: (sessionId: string, remoteDir: string, files: File[]) => Promise<IpcResult<TransferTask[]>>
    move: (sessionId: string, source: string, directory: string) => Promise<IpcResult<void>>
    dragToLocal: (sessionId: string, path: string) => Promise<IpcResult<void>>
    transfers: (sessionId?: string) => Promise<IpcResult<TransferTask[]>>
    cancelTransfer: (taskId: string) => Promise<IpcResult<boolean>>
    onProgress: (cb: (p: TransferTask) => void) => Unsub
  }
  rdp: {
    openNativeSocket: import('@shared/native-socket').OpenNativeSocket
    nativeStatus: () => Promise<IpcResult<{ available: boolean; version?: string; message: string }>>
    prepare: (connectionId: string) => Promise<IpcResult<RdpPreparePayload>>
    retryLegacy: (connectionId: string, sessionId: string) => Promise<IpcResult<RdpLegacyRetryResult>>
    release: (sessionId: string) => Promise<IpcResult<boolean>>
    getError: (sessionId: string) => Promise<IpcResult<string | null>>
    readClipboard: (sessionId: string) => Promise<IpcResult<string>>
    writeClipboard: (sessionId: string, text: string) => Promise<IpcResult<boolean>>
    clipboardFiles: (sessionId: string, action: 'paste' | 'offer' | 'receive' | 'cancel' | 'cancel-paste') => Promise<IpcResult<boolean | 'remote'>>
    launchSystemClient: (connectionId: string) => Promise<IpcResult<boolean>>
  }
  proxy: {
    test: (
      proxy: ProxyConfig,
      host: string,
      port: number
    ) => Promise<IpcResult<{ ok: boolean }>>
  }
  /* ---------------------------- 公共凭据 --------------------------- */
  shared: {
    list: () => Promise<IpcResult<SharedCredential[]>>
    save: (input: {
      id?: string
      name: string
      kind: SharedCredential['kind']
      username?: string
      domain?: string
      note?: string
      secret?: string
      passphrase?: string
    }) => Promise<IpcResult<SharedCredential>>
    remove: (id: string) => Promise<IpcResult<boolean>>
    usage: (id: string) => Promise<IpcResult<number>>
  }
  /* ---------------------------- 系统 VPN --------------------------- */
  vpn: {
    list: () => Promise<IpcResult<VpnConnection[]>>
    connect: (
      name: string,
      credentials?: { username: string; password: string }
    ) => Promise<IpcResult<VpnConnectResult>>
    disconnect: (name: string) => Promise<IpcResult<VpnConnectResult>>
  }
  /* ------------------- XTerminal 配置导入 -------------------- */
  rdo: { scan: () => Promise<IpcResult<ImportScanResult | null>> }
  xt: {
    scan: () => Promise<IpcResult<ImportScanResult>>
    apply: (scanId: string, candidates: import('@shared/types').ImportCandidate[], skipDuplicates?: boolean) => Promise<IpcResult<ImportApplyResult>>
  }
  forwards: {
    list: (connectionId?: string) => Promise<IpcResult<PortForwardRule[]>>
    save: (rule: PortForwardRule) => Promise<IpcResult<PortForwardRule>>
    remove: (ruleId: string) => Promise<IpcResult<boolean>>
    start: (ruleId: string) => Promise<IpcResult<PortForwardStatus>>
    stop: (ruleId: string) => Promise<IpcResult<boolean>>
    status: () => Promise<IpcResult<PortForwardStatus[]>>
    onStatus: (cb: (p: PortForwardStatus) => void) => Unsub
    onError: (cb: (p: { ruleId: string; message: string }) => void) => Unsub
  }
  metrics: {
    probe: (connectionId: string) => Promise<IpcResult<{ latencyMs: number; timestamp: number }>>,
    collect: (sessionId: string, withProcesses?: boolean) => Promise<IpcResult<ServerMetrics>>
  }
  external: {
    config: () => Promise<IpcResult<ExternalAccessConfig>>
    setEnabled: (which: 'mcp' | 'api', enabled: boolean) => Promise<IpcResult<ExternalAccessConfig>>
    createToken: (
      which: 'mcp' | 'api',
      label: string,
      scopes: ExternalScope[],
      allowWrite?: boolean
    ) => Promise<IpcResult<{ token: unknown; plaintext: string }>>
    revokeToken: (which: 'mcp' | 'api', tokenId: string) => Promise<IpcResult<ExternalAccessConfig>>
    approve: (requestId: string, approved: boolean) => Promise<IpcResult<boolean>>
    onApprovalRequest: (cb: (p: ApprovalPayload) => void) => Unsub
  }
}

declare global {
  interface Window {
    omnidesk: OmniDeskApi
  }
}

export {}
