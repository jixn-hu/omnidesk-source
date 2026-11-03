import type { Connection, ConnectionCheck } from '@shared/types.js'
import { parseConnectionAddress } from '@shared/connection-identity.js'
import type { SharedCredentialStore } from './shared-credentials.js'
import type { VaultService } from './vault.js'

export function checkConnection(connection: Connection, shared: SharedCredentialStore, vault: VaultService): ConnectionCheck {
  const issues: string[] = []
  let credentialLocked = false
  if (!connection.name?.trim()) issues.push('缺少连接名称')
  try { parseConnectionAddress(connection.host, connection.port) }
  catch (error) { issues.push(error instanceof Error ? error.message : '主机地址或端口不正确') }

  const agent = connection.kind === 'ssh' && connection.authMethod === 'agent'
  const publicCredential = !agent && connection.sharedCredentialId ? shared.get(connection.sharedCredentialId) : null
  if (!(publicCredential?.username || connection.username)?.trim()) issues.push('缺少登录账号')
  const checkSecret = (ref: string | undefined, label: string) => {
    if (!ref) issues.push(`未保存${label}`)
    else if (vault.status() !== 'unlocked') credentialLocked = true
    else if (!vault.getCredential(ref)?.secret) issues.push(`${label}缺失，请重新保存`)
  }

  if (!agent) {
    const kind = connection.kind === 'ssh' && connection.authMethod === 'privateKey' ? 'privateKey' : 'password'
    if (connection.kind === 'ssh' && !['password', 'privateKey'].includes(connection.authMethod)) issues.push('请选择 SSH 认证方式')
    if (connection.sharedCredentialId) {
      if (!publicCredential) issues.push('引用的公共凭据不存在')
      else {
        if (publicCredential.kind !== kind) issues.push('公共凭据类型与认证方式不匹配')
        checkSecret(publicCredential.credentialRef, '公共凭据')
      }
    } else checkSecret(connection.credentialRef, kind === 'privateKey' ? '私钥' : '密码')
  }

  if (connection.proxy && connection.proxy.type !== 'none') {
    try { parseConnectionAddress(connection.proxy.host, connection.proxy.port) }
    catch { issues.push('代理地址或端口不完整') }
  }
  if (connection.kind === 'ssh' && connection.jump) {
    try { parseConnectionAddress(connection.jump.host, connection.jump.port) }
    catch { issues.push('跳板机地址或端口不完整') }
    if (!connection.jump.username?.trim()) issues.push('缺少跳板机账号')
    checkSecret(connection.jump.credentialRef, '跳板机凭据')
  }
  return { issues, credentialLocked }
}
