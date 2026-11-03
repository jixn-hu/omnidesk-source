/**
 * 应用级常量。
 */

export const APP_NAME = 'OmniDesk'

/** 主密码派生的加密参数 */
export const CRYPTO = {
  /** scrypt 参数 —— N=2^15, r=8, p=1，约 32MB 内存，对交互式登录足够 */
  scryptN: 32768,
  scryptR: 8,
  scryptP: 1,
  keyLength: 32,
  ivLength: 12,
  tagLength: 16,
  saltLength: 32
} as const

/** 默认端口 */
export const DEFAULT_PORTS = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  mcp: 3927,
  api: 3928
} as const

/** 凭据保险箱文件名 */
export const VAULT_FILE = 'vault.enc'
export const CONNECTIONS_FILE = 'connections.json'
export const SETTINGS_FILE = 'settings.json'

/** 远端采集脚本安装目录 */
export const REMOTE_AGENT_DIR = '.omnidesk'

/** 执行命令的默认限制 */
export const EXEC_LIMITS = {
  timeoutMs: 30_000,
  maxBytes: 4 * 1024 * 1024
} as const
