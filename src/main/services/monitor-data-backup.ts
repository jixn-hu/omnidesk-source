import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
const AAD = Buffer.from('OmniDesk monitor database backup v1')
const LIMIT = 64 * 1024 * 1024
const FORMAT = 'omnidesk-encrypted-monitor-database'
async function key(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('请输入不超过 1024 字符的数据库备份密码')
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)))
}
function database(input: Buffer): void {
  if (input.length > LIMIT || input.subarray(0, 16).toString() !== 'SQLite format 3\0') throw new Error('监控数据库快照格式或大小无效')
}
export async function encryptMonitorData(password: string, snapshot: any): Promise<string> {
  if (!snapshot || snapshot.format !== 'omnidesk-monitor-database' || snapshot.version !== 1 || typeof snapshot.database !== 'string' || snapshot.database.length > 90 * 1024 * 1024) throw new Error('服务端未返回有效快照；请先升级监控服务端')
  const data = Buffer.from(snapshot.database, 'base64')
  database(data)
  const salt = randomBytes(16), iv = randomBytes(12), derived = await key(password, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, iv); cipher.setAAD(AAD)
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
    return JSON.stringify({ format: FORMAT, version: 1, kdf: 'scrypt-32768-8-1', createdAt: snapshot.createdAt, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') })
  } finally { derived.fill(0); data.fill(0) }
}
export async function decryptMonitorData(password: string, contents: string): Promise<Buffer> {
  if (Buffer.byteLength(contents) > 96 * 1024 * 1024) throw new Error('备份文件过大')
  const box = JSON.parse(contents)
  if (box.format !== FORMAT || box.version !== 1 || box.kdf !== 'scrypt-32768-8-1') throw new Error('请选择监控数据库备份 .odmonitor')
  const decode = (value: unknown, length?: number) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('加密备份格式不正确')
    const result = Buffer.from(value, 'base64')
    if (length && result.length !== length) throw new Error('加密参数不正确')
    return result
  }
  const derived = await key(password, decode(box.salt, 16))
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived, decode(box.iv, 12)); decipher.setAAD(AAD); decipher.setAuthTag(decode(box.tag, 16))
    let data: Buffer
    try { data = Buffer.concat([decipher.update(decode(box.data)), decipher.final()]) } catch { throw new Error('备份密码错误或文件被篡改，未恢复数据库') }
    database(data); return data
  } finally { derived.fill(0) }
}
