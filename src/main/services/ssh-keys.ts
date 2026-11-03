/**
 * 本地 SSH 私钥扫描
 *
 * 目的：省掉用户「去文件管理器里翻 ~/.ssh 目录、还要记得文件名」的麻烦。
 * 直接列出本机常见的私钥供选择，并识别类型与是否加密。
 *
 * 只读，不修改任何文件。
 */
import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, extname } from 'node:path'
import type { LocalSshKey } from '@shared/types.js'

/** 常见私钥文件名（OpenSSH 默认命名 + 常见变体） */
const COMMON_NAMES = [
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'id_xmss',
  'identity',
  'id_rsa_github',
  'id_ed25519_github'
]

/** 这些后缀是公钥或已知的非私钥文件，跳过 */
const SKIP_EXT = new Set(['.pub', '.ppk', '.txt', '.md', '.json', '.log'])

/** 已知的私钥文件开头 */
const KEY_HEADERS: Array<{ match: RegExp; type: string; encrypted: boolean }> = [
  // OpenSSH 新格式（加密时类型里会带 -encrypted 后缀，需单独判断，见下）
  { match: /^-----BEGIN OPENSSH PRIVATE KEY-----/, type: 'OpenSSH', encrypted: false },
  { match: /^-----BEGIN RSA PRIVATE KEY-----/, type: 'RSA (PEM)', encrypted: false },
  { match: /^-----BEGIN DSA PRIVATE KEY-----/, type: 'DSA (PEM)', encrypted: false },
  { match: /^-----BEGIN EC PRIVATE KEY-----/, type: 'ECDSA (PEM)', encrypted: false },
  { match: /^-----BEGIN PRIVATE KEY-----/, type: 'PKCS#8', encrypted: false },
  { match: /^-----BEGIN ENCRYPTED PRIVATE KEY-----/, type: 'PKCS#8', encrypted: true },
  // PuTTY 格式
  { match: /^PuTTY-User-Key-File/, type: 'PuTTY', encrypted: false }
]

/** 判断某个文件是否是私钥，并识别类型 */
function inspectKey(filePath: string): { type: string; encrypted: boolean } | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(2048)
    const n = readSync(fd, buf, 0, 2048, 0)
    if (n <= 0) return null

    const head = buf.subarray(0, n).toString('utf8')
    const firstLine = head.split('\n')[0] ?? ''

    for (const h of KEY_HEADERS) {
      if (h.match.test(firstLine)) {
        // OpenSSH 新格式：加密的会在内容里出现 bcrypt 标识
        const encrypted =
          h.type === 'OpenSSH'
            ? head.includes('bcrypt') || /Proc-Type:\s*4,ENCRYPTED/i.test(head)
            : h.encrypted || /Proc-Type:\s*4,ENCRYPTED/i.test(head)
        return { type: h.type, encrypted }
      }
    }

    // PuTTY 加密判断：有 Encryption: aes... 行
    if (/^PuTTY-User-Key-File/.test(firstLine)) {
      return { type: 'PuTTY', encrypted: /^Encryption:\s*(?!none)/im.test(head) }
    }

    return null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 扫描本机 SSH 私钥。
 * 优先看 ~/.ssh，其次看常见的位置。
 */
export function scanLocalSshKeys(): LocalSshKey[] {
  const home = homedir()
  const dirs = [
    join(home, '.ssh'),
    join(home, '.config', 'ssh'),
    // 部分用户会把密钥放在这些地方
    join(home, 'ssh'),
    join(home, '.ssh', 'keys')
  ]

  const found: LocalSshKey[] = []
  const seen = new Set<string>()

  const add = (filePath: string, fromCommonList: boolean): void => {
    if (seen.has(filePath)) return
    seen.add(filePath)

    const info = inspectKey(filePath)
    if (!info) {
      // 只有在「常见文件名」列表里的才允许识别失败 —— 那种情况提示用户可能是权限问题
      if (!fromCommonList) return
      found.push({
        path: filePath,
        name: basename(filePath),
        type: '未知',
        encrypted: false,
        readable: false
      })
      return
    }

    found.push({
      path: filePath,
      name: basename(filePath),
      type: info.type,
      encrypted: info.encrypted,
      readable: true
    })
  }

  // 1) 按常见文件名找
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of COMMON_NAMES) {
      const p = join(dir, name)
      if (existsSync(p)) add(p, true)
    }
  }

  // 2) 扫 ~/.ssh 下的其他文件，兜住用户自定义命名的私钥
  const sshDir = join(home, '.ssh')
  if (existsSync(sshDir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(sshDir)
    } catch {
      entries = []
    }
    for (const name of entries) {
      const p = join(sshDir, name)
      try {
        if (!statSync(p).isFile()) continue
      } catch {
        continue
      }
      if (SKIP_EXT.has(extname(name).toLowerCase())) continue
      if (name.startsWith('.')) continue
      // known_hosts / config 之类不是私钥，inspectKey 会返回 null 自动跳过
      add(p, false)
    }
  }

  // 有加密信息的排前面一点，便于用户一眼看到需要注意的
  return found.sort((a, b) => {
    if (a.readable !== b.readable) return a.readable ? -1 : 1
    // 未加密的排前面（更常用、更省事）
    if (a.encrypted !== b.encrypted) return a.encrypted ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

/** 读取私钥内容（供选择后直接填入） */
export function readKeyFile(filePath: string, maxBytes = 64 * 1024): string {
  const st = statSync(filePath)
  if (!st.isFile()) throw new Error('不是普通文件')
  if (st.size > maxBytes) {
    throw new Error(`文件过大（${Math.round(st.size / 1024)} KB），看起来不是私钥文件`)
  }
  return readFileSync(filePath, 'utf8')
}
