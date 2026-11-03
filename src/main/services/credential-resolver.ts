import type { Connection } from '@shared/types.js'
import type { SharedCredentialStore } from './shared-credentials.js'
import type { VaultService } from './vault.js'

export function resolveConnectionCredential(connection: Connection, shared: SharedCredentialStore, vault: VaultService): {
  username: string
  domain?: string
  secret: string
  passphrase?: string
} | null {
  if (connection.sharedCredentialId) {
    const item = shared.get(connection.sharedCredentialId)
    if (!item) throw new Error('引用的公共凭据不存在，请在「公共凭据」中检查后重新选择')
    const expected = connection.kind === 'ssh' && connection.authMethod === 'privateKey' ? 'privateKey' : 'password'
    if (item.kind !== expected) throw new Error('公共凭据类型与连接的认证方式不匹配')
    const credential = vault.getCredential(item.credentialRef)
    if (!credential) throw new Error('公共凭据无法读取，请解锁保险箱或重新保存凭据')
    return { ...credential, username: item.username || connection.username,
      domain: item.domain || (connection.kind === 'rdp' ? connection.domain : undefined) }
  }
  if (!connection.credentialRef) return null
  const credential = vault.getCredential(connection.credentialRef)
  return credential ? { ...credential, username: connection.username,
    domain: connection.kind === 'rdp' ? connection.domain : undefined } : null
}
