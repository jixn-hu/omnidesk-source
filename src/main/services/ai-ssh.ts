import { randomUUID } from 'node:crypto'
import type { SessionInfo, SshConnection, ExecResult } from '@shared/types.js'
import type { SshService } from './ssh.js'
import type { VaultService } from './vault.js'
import type { SharedCredentialStore } from './shared-credentials.js'
import type { VpnService } from './vpn.js'
import { resolveConnectionCredential } from './credential-resolver.js'
import { redactAiText } from './ai-tools.js'

export async function executeAiSsh(ssh: SshService, vault: VaultService, shared: SharedCredentialStore, vpn: VpnService,
  connection: SshConnection, command: string, signal: AbortSignal, beforeExecute?: (username: string) => void, conversationId?: string): Promise<ExecResult> {
  if (vault.status() !== 'unlocked') throw new Error('请先解锁本机保险箱')
  signal.throwIfAborted()
  if (connection.vpn?.name && !await vpn.isConnected(connection.vpn.name)) throw new Error('请先连接该服务器要求的系统 VPN，再重试')
  signal.throwIfAborted()
  const credential = resolveConnectionCredential(connection, shared, vault)
  const jump = connection.jump?.credentialRef ? vault.getCredential(connection.jump.credentialRef) : null
  const secrets = [credential?.secret, credential?.passphrase, jump?.secret, jump?.passphrase, connection.proxy?.password].filter((value): value is string => !!value)
  const ownerId = 'ai-' + (conversationId ? conversationId + '-' : '') + randomUUID()
  let sessionId: string | undefined
  const track = (info: SessionInfo) => { if (info.ownerId === ownerId) sessionId = info.id }
  const stop = () => { if (sessionId) ssh.disconnect(sessionId) }
  ssh.on('sessionEvent', track)
  signal.addEventListener('abort', stop, { once: true })
  try {
    const session = await ssh.connect(connection, ownerId)
    sessionId = session.id
    signal.throwIfAborted()
    beforeExecute?.(session.username || connection.username)
    const result = await ssh.exec(session.id, command, { timeoutMs: 30000, maxBytes: 32768 })
    signal.throwIfAborted()
    return { ...result, stdout: redactAiText(result.stdout, secrets), stderr: redactAiText(result.stderr, secrets) }
  } catch (error) {
    throw new Error(redactAiText(error instanceof Error ? error.message : 'SSH 执行失败', secrets))
  } finally {
    signal.removeEventListener('abort', stop)
    ssh.off('sessionEvent', track)
    stop()
  }
}
