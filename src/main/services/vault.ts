/**
 * 凭据保险箱（Vault）
 *
 * 【核心设计】
 *   数据用随机 DEK（数据加密密钥）以 AES-256-GCM 加密。
 *   DEK 本身再被 KEK（密钥加密密钥）包裹后与密文一同存储。
 *
 *   这样做的好处：换密钥只需重新包裹 DEK，不必重新加密全部数据。
 *   所以「改主密码」和「切换保护模式」都是瞬间完成的。
 *
 * 【两种保护模式，用户可自选，可随时切换】
 *
 *   masterPassword —— KEK 由主密码经 scrypt 派生。每次启动需输入密码。
 *                     安全性最高：文件被拷走也解不开。
 *
 *   deviceKey      —— KEK 是本机随机生成的密钥文件（device.key，权限 0600）。
 *                     启动免输入。安全性定位要如实说明：
 *                       ✅ 能挡住「配置文件被拷到别的机器」「被顺手看一眼」
 *                       ❌ 挡不住「能读你硬盘的攻击者」或「能读你用户目录的程序」
 *                     所以它适合「我不想每次输密码，且我信任本机」的场景。
 *
 * 存储格式
 *   vault.enc : { v: 2, mode, kdf?, wrapped, data }
 *               kdf 仅在 masterPassword 模式下存在
 *   device.key: 32 字节随机数（仅 deviceKey 模式）
 *
 *   兼容：v1 文件（无 mode 字段）视为 masterPassword 模式。
 */
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { CRYPTO, VAULT_FILE } from '@shared/constants.js'
import type { VaultMode, VaultStatus } from '@shared/types.js'

const DEVICE_KEY_FILE = 'device.key'

interface VaultFile {
  v: 2
  mode: VaultMode
  /** 仅主密码模式存在 */
  kdf?: { salt: string; N: number; r: number; p: number }
  wrapped: { iv: string; tag: string; data: string }
  data: { iv: string; tag: string; data: string }
}

/** 保险箱里实际存的内容 */
interface VaultPayload {
  credentials: Record<string, { secret: string; passphrase?: string }>
  sentinel: string
}

/* ------------------------------------------------------------------ */
/* 加解密原语                                                          */
/* ------------------------------------------------------------------ */

function deriveKekFromPassword(password: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  // maxmem 要放宽，否则 scrypt 会因默认 32MB 上限报错
  return scryptSync(password, salt, CRYPTO.keyLength, { N, r, p, maxmem: 256 * 1024 * 1024 })
}

function seal(key: Buffer, plaintext: Buffer): { iv: string; tag: string; data: string } {
  const iv = randomBytes(CRYPTO.ivLength)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: CRYPTO.tagLength })
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

function open(key: Buffer, box: { iv: string; tag: string; data: string }): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'), {
    authTagLength: CRYPTO.tagLength
  })
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
  // 密钥不对时 final() 抛错（GCM 认证标签校验失败）
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()])
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

export class VaultService {
  private path: string
  private deviceKeyPath: string
  private dek: Buffer | null = null
  private payload: VaultPayload = { credentials: {}, sentinel: '' }
  /** 当前文件的模式（未初始化时为 null） */
  private currentMode: VaultMode | null = null

  constructor(userDataDir: string) {
    this.path = join(userDataDir, VAULT_FILE)
    this.deviceKeyPath = join(userDataDir, DEVICE_KEY_FILE)
    mkdirSync(dirname(this.path), { recursive: true })
  }

  /* ---------------- 状态 ---------------- */

  status(): VaultStatus {
    if (!existsSync(this.path)) return 'uninitialized'
    return this.dek ? 'unlocked' : 'locked'
  }

  /** 当前保护模式。未初始化返回 null */
  mode(): VaultMode | null {
    if (this.currentMode) return this.currentMode
    const file = this.readFile()
    return file?.mode ?? null
  }

  private readFile(): VaultFile | null {
    try {
      if (!existsSync(this.path)) return null
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<VaultFile> & { v?: number }
      // v1 兼容：没有 mode 字段的一律视为主密码模式
      const mode: VaultMode = raw.mode === 'deviceKey' ? 'deviceKey' : 'masterPassword'
      return { ...(raw as VaultFile), v: 2, mode }
    } catch {
      return null
    }
  }

  /* ---------------- 设备密钥 ---------------- */

  /** 读取或创建本机密钥文件 */
  private getOrCreateDeviceKey(): Buffer {
    if (existsSync(this.deviceKeyPath)) {
      const key = readFileSync(this.deviceKeyPath)
      if (key.length === CRYPTO.keyLength) return key
      // 长度不对说明文件损坏，重新生成（旧数据将无法解密，属于预期内的降级）
    }
    const key = randomBytes(CRYPTO.keyLength)
    writeFileSync(this.deviceKeyPath, key, { mode: 0o600 })
    try {
      chmodSync(this.deviceKeyPath, 0o600)
    } catch {
      /* Windows 上 chmod 语义有限，忽略 */
    }
    return key
  }

  private readDeviceKey(): Buffer | null {
    try {
      if (!existsSync(this.deviceKeyPath)) return null
      const key = readFileSync(this.deviceKeyPath)
      return key.length === CRYPTO.keyLength ? key : null
    } catch {
      return null
    }
  }

  /* ---------------- 初始化 ---------------- */

  /**
   * 首次创建保险箱。
   * 传 password 走主密码模式；不传则走免密码（设备密钥）模式。
   */
  init(password?: string): void {
    if (existsSync(this.path)) throw new Error('保险箱已存在')

    const mode: VaultMode = password ? 'masterPassword' : 'deviceKey'
    const dek = randomBytes(CRYPTO.keyLength)
    this.payload = { credentials: {}, sentinel: randomBytes(16).toString('hex') }

    const file: VaultFile = {
      v: 2,
      mode,
      wrapped: { iv: '', tag: '', data: '' }, // 占位，下面统一包裹
      data: seal(dek, Buffer.from(JSON.stringify(this.payload), 'utf8'))
    }

    file.wrapped = seal(this.buildKek(mode, password, file), dek)

    writeFileSync(this.path, JSON.stringify(file), { mode: 0o600 })
    this.dek = dek
    this.currentMode = mode
  }

  /**
   * 构造 KEK。
   * 主密码模式：需要 salt 等参数，会写回 file.kdf。
   * 设备模式：直接使用/生成本机密钥文件。
   */
  private buildKek(mode: VaultMode, password: string | undefined, file: VaultFile): Buffer {
    if (mode === 'deviceKey') {
      // 重新包裹时要沿用已有的密钥文件，不能重新生成（否则旧 DEK 解不开）
      return this.readDeviceKey() ?? this.getOrCreateDeviceKey()
    }

    if (!password) throw new Error('主密码模式必须提供密码')

    const salt = randomBytes(CRYPTO.saltLength)
    file.kdf = {
      salt: salt.toString('base64'),
      N: CRYPTO.scryptN,
      r: CRYPTO.scryptR,
      p: CRYPTO.scryptP
    }
    return deriveKekFromPassword(password, salt, CRYPTO.scryptN, CRYPTO.scryptR, CRYPTO.scryptP)
  }

  /* ---------------- 解锁 ---------------- */

  /**
   * 设备模式下无需密码。返回是否成功自动解锁。
   * 应用启动时调用它 —— 主密码模式会返回 false（需要用户输入）。
   */
  tryAutoUnlock(): boolean {
    const file = this.readFile()
    if (!file || file.mode !== 'deviceKey') return false
    try {
      this.unlock()
      return true
    } catch {
      return false
    }
  }

  /**
   * 解锁。设备模式下忽略 password 参数。
   */
  unlock(password?: string): void {
    const file = this.readFile()
    if (!file) throw new Error('保险箱不存在，请先初始化')

    let kek: Buffer
    if (file.mode === 'deviceKey') {
      const key = this.readDeviceKey()
      if (!key) {
        throw new Error(
          '本机密钥文件缺失或损坏（device.key）。如果是从别的机器拷来的配置，' +
            '需要在设置里重新设置主密码，或重新录入凭据。'
        )
      }
      kek = key
    } else {
      if (!password) throw new Error('请输入主密码')
      const kdf = file.kdf
      if (!kdf) throw new Error('保险箱文件缺少密钥派生参数，可能已损坏')
      kek = deriveKekFromPassword(
        password,
        Buffer.from(kdf.salt, 'base64'),
        kdf.N,
        kdf.r,
        kdf.p
      )
    }

    let dek: Buffer
    try {
      dek = open(kek, file.wrapped)
    } catch {
      throw new Error(file.mode === 'deviceKey' ? '本机密钥无法解开保险箱' : '主密码错误')
    }

    this.payload = JSON.parse(open(dek, file.data).toString('utf8')) as VaultPayload
    this.dek = dek
    this.currentMode = file.mode
  }

  lock(): void {
    if (this.dek) this.dek.fill(0)
    this.dek = null
    this.payload = { credentials: {}, sentinel: '' }
  }

  /* ---------------- 换密钥 ---------------- */

  /**
   * 切换保护模式。
   *
   * 无论哪个方向都只是「解开 DEK → 用新 KEK 重新包裹」，
   * 与数据量无关，所以哪怕存了几百条凭据也是瞬间完成。
   *
   * @param target        目标模式
   * @param password      转为主密码模式时必填；当前是主密码模式时也需填（用于解开）
   */
  setMode(target: VaultMode, opts: { currentPassword?: string; newPassword?: string } = {}): void {
    // 先用当前模式解锁（若已解锁则跳过）
    if (!this.dek) {
      this.unlock(opts.currentPassword)
    }
    const dek = this.dek!

    const oldFile = this.readFile()
    if (!oldFile) throw new Error('保险箱文件读取失败')
    if (oldFile.mode === target) return // 已是目标模式，无需操作

    const file: VaultFile = {
      v: 2,
      mode: target,
      wrapped: { iv: '', tag: '', data: '' },
      data: seal(dek, Buffer.from(JSON.stringify(this.payload), 'utf8'))
    }

    if (target === 'masterPassword') {
      if (!opts.newPassword) throw new Error('请设置主密码')
      if (opts.newPassword.length < 8) throw new Error('主密码至少 8 位')
      file.wrapped = seal(this.buildKek(target, opts.newPassword, file), dek)
    } else {
      // 降级为设备密钥
      file.wrapped = seal(this.getOrCreateDeviceKey(), dek)
    }

    writeFileSync(this.path, JSON.stringify(file), { mode: 0o600 })
    this.currentMode = target

    // 从主密码降级后，旧的主密码参数不再需要，但文件已整体重写，无需额外清理
  }

  /** 修改主密码（仅主密码模式下有意义，实为换 KEK） */
  changePassword(oldPassword: string, newPassword: string): void {
    const file = this.readFile()
    if (!file) throw new Error('保险箱不存在')
    if (file.mode === 'deviceKey') {
      throw new Error('当前是免密码模式，请先设置主密码')
    }
    if (newPassword.length < 8) throw new Error('新主密码至少 8 位')

    this.unlock(oldPassword)
    const dek = this.dek!

    const updated: VaultFile = {
      v: 2,
      mode: 'masterPassword',
      wrapped: { iv: '', tag: '', data: '' },
      data: seal(dek, Buffer.from(JSON.stringify(this.payload), 'utf8'))
    }
    updated.wrapped = seal(this.buildKek('masterPassword', newPassword, updated), dek)

    writeFileSync(this.path, JSON.stringify(updated), { mode: 0o600 })
  }

  /* ---------------- 凭据读写 ---------------- */

  private requireUnlocked(): Buffer {
    if (!this.dek) throw new Error('保险箱已锁定')
    return this.dek
  }

  sealLocalData(plaintext: string, purpose: string): string {
    const key = this.requireUnlocked(), iv = randomBytes(CRYPTO.ivLength)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: CRYPTO.tagLength })
    cipher.setAAD(Buffer.from(purpose))
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
  }

  openLocalData(contents: string, purpose: string): string {
    const key = this.requireUnlocked(), box = JSON.parse(contents)
    if (box.v !== 1 || ['iv', 'tag', 'data'].some(name => typeof box[name] !== 'string')) throw new Error('本机加密记录格式不正确')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'), { authTagLength: CRYPTO.tagLength })
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
  }

  setCredential(ref: string, secret: string, passphrase?: string | null): void {
    const dek = this.requireUnlocked()
    if (typeof secret !== 'string' || (passphrase != null && typeof passphrase !== 'string')) throw new Error('凭据格式不正确')
    this.payload.credentials[ref] = { secret, passphrase: passphrase ?? undefined }
    this.persist(dek)
  }

  getCredential(ref: string): { secret: string; passphrase?: string } | null {
    this.requireUnlocked()
    const credential = this.payload.credentials[ref]
    return credential ? { ...credential, passphrase: credential.passphrase ?? undefined } : null
  }

  deleteCredential(ref: string): void {
    const dek = this.requireUnlocked()
    delete this.payload.credentials[ref]
    this.persist(dek)
  }

  listCredentialRefs(): string[] {
    this.requireUnlocked()
    return Object.keys(this.payload.credentials)
  }

  prepareCredentialImport(credentials: Record<string, { secret: string; passphrase?: string }>, removeRefs: string[] = []): { contents: string; commit: () => void } {
    const dek = this.requireUnlocked()
    const file = this.readFile()
    if (!file) throw new Error('无法读取当前保险箱，未导入配置')
    const next = { ...this.payload, credentials: { ...this.payload.credentials, ...credentials } }
    for (const ref of removeRefs) delete next.credentials[ref]
    const contents = JSON.stringify({ ...file, data: seal(dek, Buffer.from(JSON.stringify(next), 'utf8')) })
    return { contents, commit: () => { this.payload = next } }
  }

  private persist(dek: Buffer): void {
    const file = this.readFile()
    if (!file) return
    file.data = seal(dek, Buffer.from(JSON.stringify(this.payload), 'utf8'))
    writeFileSync(this.path, JSON.stringify(file), { mode: 0o600 })
  }
}

/** 生成一个不冲突的凭据引用 id */
export function newCredentialRef(): string {
  return 'cred_' + randomBytes(8).toString('hex')
}

/** 常量时间比较，用于 token 校验 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
