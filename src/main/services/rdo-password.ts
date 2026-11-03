import { createDecipheriv, createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

const formatPassword = 'swevA2t62We?5Cr+he4Tac?_E!redafa?re5+2huv*$rU9eS8Ub4?W!!R+s7uthU'
const salt = Buffer.from('Ivan Medvedev', 'ascii')
const sha1 = (value: Buffer) => createHash('sha1').update(value).digest()
let base = sha1(Buffer.concat([Buffer.from(formatPassword, 'utf8'), salt]))
for (let iteration = 1; iteration < 99; iteration++) base = sha1(base)
const blocks = [base, Buffer.concat([Buffer.from('1'), base]), Buffer.concat([Buffer.from('2'), base])].map(sha1)
const key = Buffer.concat(blocks.slice(0, 2)).subarray(0, 32)
const iv = Buffer.concat([blocks[0]!.subarray(8, 16), blocks[2]!.subarray(0, 8)])
const unicode = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true })

export function decryptRdoPassword(value: string): string | undefined {
  if (!value || value.length > 16384 || value.length % 32 || !/^[\da-f]+$/i.test(value)) return undefined
  let plaintext: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    plaintext = Buffer.concat([decipher.update(Buffer.from(value, 'hex')), decipher.final()])
    if (plaintext.length % 2) return undefined
    const result = unicode.decode(plaintext)
    return result && !result.includes('\0') ? result : undefined
  } catch {
    return undefined
  } finally {
    plaintext?.fill(0)
  }
}
