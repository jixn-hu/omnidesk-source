import type { BackupOptions, BackupPreferences, BackupSection } from './backup'
/**
 * 主进程 / 预加载 / 渲染进程共享的类型定义。
 * 这里是唯一的真相来源 —— 任何跨进程的数据结构都必须在此声明。
 */

/* ------------------------------------------------------------------ */
/* 连接                                                                */
/* ------------------------------------------------------------------ */

export type ConnectionKind = 'ssh' | 'rdp'

export type SshAuthMethod = 'password' | 'privateKey' | 'agent'

/* ------------------------------------------------------------------ */
/* 代理（按连接独立配置）                                              */
/* ------------------------------------------------------------------ */

export type ProxyType = 'none' | 'socks5' | 'socks4' | 'http'

/**
 * 代理配置 —— 决定「连这台机器的流量从哪里出去」。
 *
 * 注意这与「以这台机器为出口」是两件事：后者是 SSH 动态转发，
 * 见 PortForward 的 dynamic 类型。
 */
export interface ProxyConfig {
  type: ProxyType
  host: string
  port: number
  username?: string
  password?: string
}

export const DIRECT_PROXY: ProxyConfig = { type: 'none', host: '', port: 0 }

/* ------------------------------------------------------------------ */
/* 端口转发                                                            */
/* ------------------------------------------------------------------ */

export type ForwardKind = 'local' | 'remote' | 'dynamic'

export interface PortForwardRule {
  id: string
  connectionId: string
  kind: ForwardKind
  /** 本地转发：本机监听地址；远程转发：远端监听地址；动态转发：本机 SOCKS 监听地址 */
  listenHost: string
  listenPort: number
  /** 目标地址。动态转发不需要（由 SOCKS 客户端指定） */
  targetHost?: string
  targetPort?: number
  /** 备注 */
  label?: string
  enabled: boolean
}

export interface PortForwardStatus {
  ruleId: string
  /** 是否正在运行 */
  running: boolean
  /** 实际监听端口（端口为 0 时由系统分配，这里回填真实端口） */
  actualPort?: number
  /** 已接受的连接数 */
  connections: number
  /** 累计传输字节 */
  bytesIn: number
  bytesOut: number
  error?: string
  startedAt?: number
}

export interface ConnectionBase {
  id: string
  kind: ConnectionKind
  name: string
  host: string
  port: number
  group?: string
  tags?: string[]
  note?: string
  /** 是否允许外部（MCP / HTTP API）访问。默认 false，需用户显式授权。 */
  exposedToExternal?: boolean
  /**
   * 该连接专用的代理。不填或 type=none 表示直连。
   * 每条连接独立，互不影响。
   */
  proxy?: ProxyConfig
  /**
   * 引用一条公共凭据。设置后优先于本连接自己的 credentialRef ——
   * 这样改一次公共凭据，所有引用它的连接都跟着变。
   */
  sharedCredentialId?: string
  /** @deprecated 仅保留旧配置和备份字段；应用不再管理或检查系统 VPN。 */
  vpn?: { name: string; disconnectAfter?: boolean }
  createdAt: number
  updatedAt: number
}

export interface SshConnection extends ConnectionBase {
  kind: 'ssh'
  username: string
  authMethod: SshAuthMethod
  /** 凭据引用，真正的密钥材料存在 Vault 里，不在这里 */
  credentialRef?: string
  /** 跳板机 */
  jump?: {
    host: string
    port: number
    username: string
    credentialRef?: string
  }
}

export interface RdpConnection extends ConnectionBase {
  kind: 'rdp'
  username: string
  domain?: string
  credentialRef?: string
  /** .rdp 风格配置 */
  options?: RdpOptions
}

export interface RdpOptions {
  engine?: 'ironrdp' | 'freerdp'
  securityMode?: 'auto' | 'legacy'
  performanceMode?: 'smooth' | 'balanced' | 'clear'
  /** 自适应分辨率 */
  dynamicResolution?: boolean
  /** 全屏启动 */
  fullscreen?: boolean
  systemSmartSizing?: boolean
  /** 启用剪贴板重定向 */
  enableClipboard?: boolean
  /** 音频捕获模式 */
  audioCaptureMode?: 'none' | 'local' | 'remote'
  /** 桌面壁纸 */
  showWallpaper?: boolean
  /** 字体平滑 */
  fontSmoothing?: boolean
  /** 桌面合成 */
  desktopComposition?: boolean
  /** 窗口拖动时显示内容 */
  showDraggedWindow?: boolean
  /** 菜单动画 */
  showMenuAnimations?: boolean
  /** 主题 */
  showThemes?: boolean
  /** 光标闪烁 */
  showBlinkingCursor?: boolean
  /** 色彩深度 */
  colorDepth?: 16 | 24 | 32
  /** 忽略证书错误（谨慎使用，默认 true） */
  ignoreCertificate?: boolean
}

export type Connection = SshConnection | RdpConnection

export interface ConnectionCheck {
  issues: string[]
  credentialLocked: boolean
}

/* ------------------------------------------------------------------ */
/* 凭据                                                                */
/* ------------------------------------------------------------------ */

export interface Credential {
  /** 密码或私钥内容 */
  secret: string
  /** 私钥口令 */
  passphrase?: string
}

export interface ConfigurationSummary {
  sections?: BackupSection[]
  preferences?: BackupPreferences
  skipped?: number
  warning?: string
  connections: number
  sharedCredentials: number
}

export interface WebDavConfiguration {
  url: string
  serverUrl?: string
  username: string
  allowInsecureHttp: boolean
  hasPassword: boolean
  lastSync?: number
}

export type WebDavConfigurationInput = Omit<WebDavConfiguration, 'hasPassword' | 'lastSync'> & { password?: string; clearPassword?: boolean }

export interface ConfigurationApi {
  onRestored: (callback: (summary: ConfigurationSummary) => void) => () => void
  passwordStatus: () => Promise<IpcResult<boolean>>
  savePassword: (password: string) => Promise<IpcResult<boolean>>
  exportFile: (password: string, options?: BackupOptions) => Promise<IpcResult<{ cancelled: boolean; path?: string }>>
  importFile: (password: string, options?: BackupOptions) => Promise<IpcResult<ConfigurationSummary | null>>
  decryptMonitorData: (password: string) => Promise<IpcResult<{ cancelled: boolean; path?: string }>>
  exportMonitorData: (password: string) => Promise<IpcResult<{ cancelled: boolean; path?: string }>>
  webdav: () => Promise<IpcResult<WebDavConfiguration>>
  saveWebdav: (configuration: WebDavConfigurationInput) => Promise<IpcResult<WebDavConfiguration>>
  testWebdav: () => Promise<IpcResult<string>>
  uploadWebdav: (password: string, options?: BackupOptions) => Promise<IpcResult<string>>
  downloadWebdav: (password: string, options?: BackupOptions) => Promise<IpcResult<ConfigurationSummary | null>>
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface SessionInfo {
  ownerId?: string
  id: string
  connectionId: string
  kind: ConnectionKind
  name: string
  username?: string
  status: SessionStatus
  /** 建立连接的时间戳 */
  startedAt: number
  /** 最近一次错误 */
  lastError?: string
}

/* ------------------------------------------------------------------ */
/* SFTP                                                                */
/* ------------------------------------------------------------------ */

export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  /** unix 权限位，如 0o644 */
  mode: number
  /** 权限的符号表示，如 rw-r--r-- */
  modeText: string
  mtime: number
  uid?: number
  gid?: number
  owner?: string
  group?: string
}

export interface TransferTask {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  size: number
  transferred: number
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  error?: string
}

/* ------------------------------------------------------------------ */
/* 监控指标                                                            */
/* ------------------------------------------------------------------ */

export interface CpuMetrics {
  steal?: number
  iowait?: number
  /** 总体使用率 0-100 */
  usage: number
  /** 分核使用率 */
  perCore: number[]
  /** 逻辑核心数 */
  cores: number
  /** 1/5/15 分钟负载 */
  loadAvg: [number, number, number]
  /** 型号 */
  model?: string
}

export interface MemoryMetrics {
  total: number
  used: number
  free: number
  available: number
  cached?: number
  buffers?: number
  swapTotal: number
  swapUsed: number
  /** 使用率 0-100 */
  usagePercent: number
}

export interface DiskMetrics {
  inodeUsagePercent?: number
  mount: string
  device: string
  fsType: string
  total: number
  used: number
  available: number
  usagePercent: number
}

export interface NetworkInterfaceMetrics {
  name: string
  rxBytes: number
  txBytes: number
  rxRate?: number
  txRate?: number
}

export interface ProcessMetrics {
  pid: number
  user: string
  cpu: number
  mem: number
  command: string
}

export interface SystemInfo {
  hostname: string
  os: string
  kernel: string
  arch: string
  uptime: number
  bootTime?: number
  virtualization?: string
}

export interface ServerMetrics {
  installationId?: string
  discoveryDisabled?: boolean
  publicIP?: {refreshId?:string;ipv4?:string;ipv6?:string;ipv4At?:number;ipv6At?:number;attemptedAt:number;ipv4Failed:boolean;ipv6Failed:boolean}
  intervalSeconds?: number
  unavailable?: string[]
  discovered?: import('./monitoring').MonitorDiscovery
  diskIO?: { readRate: number; writeRate: number }
  latencyMs?: number
  connectionId: string
  /** 采集时间戳（毫秒） */
  timestamp: number
  /** 采集耗时（毫秒） */
  durationMs: number
  system: SystemInfo
  cpu: CpuMetrics
  memory: MemoryMetrics
  disks: DiskMetrics[]
  network: NetworkInterfaceMetrics[]
  processes?: ProcessMetrics[]
}

/* ------------------------------------------------------------------ */
/* Vault（凭据保险箱）                                                 */
/* ------------------------------------------------------------------ */

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

/**
 * 凭据保护模式 —— 用户可自选，可随时切换
 *
 *  masterPassword：主密码经 scrypt 派生密钥。每次启动需输入，安全性最高。
 *  deviceKey     ：本机随机密钥文件。启动免输入，能防拷贝但不防本机读取。
 */
export type VaultMode = 'masterPassword' | 'deviceKey'

/* ------------------------------------------------------------------ */
/* 对外能力（MCP / HTTP API）                                          */
/* ------------------------------------------------------------------ */

export interface ExternalAccessConfig {
  mcp: {
    enabled: boolean
    port: number
    host: string
    tokens: AccessToken[]
  }
  api: {
    enabled: boolean
    port: number
    host: string
    tokens: AccessToken[]
  }
}

export interface AccessToken {
  id: string
  label: string
  /** 只存哈希，不存明文 */
  tokenHash: string
  /** 明文只在创建时返回一次 */
  scopes: ExternalScope[]
  createdAt: number
  lastUsedAt?: number
  /** 是否允许免审批执行写操作 */
  allowWriteWithoutApproval?: boolean
}

export type ExternalScope =
  | 'ssh:read'
  | 'ssh:exec'
  | 'sftp:read'
  | 'sftp:write'
  | 'metrics:read'

/* ------------------------------------------------------------------ */
/* 配置导入（从同类工具迁移）                                          */
/* ------------------------------------------------------------------ */

/** 一条待导入项 —— 带来源信息与「推断」标记，供预览界面展示 */
export interface ImportCandidate {
  credentialName?: string
  requiresReview?: boolean
  reviewReason?: string
  rdpOptions?: RdpOptions
  credentialAvailable?: boolean
  authMethod?: 'password' | 'privateKey'
  domain?: string
  /** 临时 id，仅用于界面勾选 */
  tempId: string
  kind: ConnectionKind
  name: string
  host: string
  port: number
  username: string
  group?: string
  note?: string
  /** 地址是从原标题推断出来的，需用户确认 */
  hostInferred: boolean
  /** 用户名缺失，需补充 */
  usernameMissing: boolean
  /** 来源记录的原始标题，便于对照 */
  sourceTitle: string
  /** 与现有连接重复 */
  duplicate: boolean
}

export interface ImportScanResult {
  source?: 'xterminal' | 'rdo'
  scanId: string
  /** 找到的数据目录 */
  dataDir: string
  /** 数据文件路径 */
  dbPath: string
  /** 数据文件最后修改时间 —— 让用户确认读的是不是最新数据 */
  modifiedAt: number
  candidates: ImportCandidate[]
  summary: {
    sshTotal: number
    rdpTotal: number
    groups: number
    /** 处于加密状态、无法读取的凭据数量 */
    encryptedCredentials: number
    duplicates: number
  }
  /** 需要告知用户的注意事项 */
  warnings: string[]
}

export interface ImportApplyResult {
  created: number
  skipped: number
  credentials: number
  failed: Array<{ name: string; reason: string }>
}

/* ------------------------------------------------------------------ */
/* 公共凭据（共享密码 / 共享私钥）                                      */
/* ------------------------------------------------------------------ */

/**
 * 命名凭据，可被多条连接引用。
 *
 * 典型场景：几十台机器用同一个密码。抽出来命名一次，
 * 多条连接引用它 —— 改一次全部生效，不用逐台改。
 *
 * 存放位置与普通凭据相同（保险箱里的 credentialRef），
 * 所以加密强度没有区别，只是多了「有名字、可共用」这一层。
 */
export interface SharedCredential {
  id: string
  /** 展示名，如「测试环境统一密码」 */
  name: string
  kind: 'password' | 'privateKey'
  username?: string
  domain?: string
  /** 指向保险箱里的条目 */
  credentialRef: string
  note?: string
  createdAt: number
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* 本地 SSH 私钥                                                       */
/* ------------------------------------------------------------------ */

/** 扫描到的本机私钥，用于「一键选择」而不是让用户自己去翻目录 */
export interface LocalSshKey {
  /** 绝对路径 */
  path: string
  /** 文件名，用于展示 */
  name: string
  /** 密钥类型，如 OpenSSH / RSA (PEM) / PuTTY */
  type: string
  /** 是否带口令 */
  encrypted: boolean
  /** 是否成功识别为私钥 */
  readable: boolean
}

/* ------------------------------------------------------------------ */
/* IPC 契约                                                            */
/* ------------------------------------------------------------------ */

/** 统一的 IPC 响应信封 —— 参考 XTerminal 的设计，避免异常穿透进程边界 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  signal?: string
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 是否被截断 */
  truncated: boolean
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  /** 最大输出字节数，超出截断 */
  maxBytes?: number
  /** 以 sudo 执行 */
  sudo?: boolean
  sudoPassword?: string
}
