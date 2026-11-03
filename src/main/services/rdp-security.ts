import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { RdpConnection, ProxyConfig } from '@shared/types.js'
import { parseConnectionAddress } from '@shared/connection-identity.js'
import { connectDirect, connectViaProxy } from './proxy-connector.js'
import { exchangeX224, RdpNegotiationError } from './rdp-protocol.js'
import { writeConfigurationFile } from './config-backup.js'

export async function requiresLegacyRdp(host: string, port: number, proxy: ProxyConfig | undefined, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const socket = proxy && proxy.type !== 'none' ? await connectViaProxy(proxy, { host, port }, 8000) : await connectDirect({ host, port }, 8000)
  const cancel = () => socket.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) return false
    await exchangeX224(socket, Buffer.from('030000130ee00000000000010008000b000000', 'hex'))
    return false
  } catch (error) {
    if (signal.aborted) return false
    if (error instanceof RdpNegotiationError && (error.negotiationCode === 2 || error.negotiationCode === 'legacy')) return true
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    socket.destroy()
  }
}

type ConfirmLegacy = (connection: RdpConnection, automatic: boolean, signal: AbortSignal, owner?: BrowserWindow) => Promise<boolean>

export class RdpLegacyConsent {
  private readonly path: string
  private approvals: Record<string, string> = {}

  constructor(directory: string, private readonly confirm: ConfirmLegacy) {
    this.path = join(directory, 'rdp-legacy-consent.json')
    if (existsSync(this.path)) {
      try {
        const stored = JSON.parse(readFileSync(this.path, 'utf8'))
        if (stored.version === 1 && stored.approvals && typeof stored.approvals === 'object') {
          this.approvals = Object.fromEntries(Object.entries(stored.approvals).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[a-f0-9]{64}$/.test(entry[1])))
        }
      } catch {}
    }
  }

  private identity(connection: RdpConnection): string {
    const endpoint = parseConnectionAddress(connection.host, connection.port)
    return createHash('sha256').update(JSON.stringify([endpoint.host, endpoint.port, connection.proxy ?? null, connection.username, connection.domain, connection.credentialRef, connection.sharedCredentialId])).digest('hex')
  }

  async authorize(connection: RdpConnection, signal: AbortSignal, automatic = false, owner?: BrowserWindow): Promise<boolean> {
    if (signal.aborted) return false
    const identity = this.identity(connection)
    if (!automatic && Object.hasOwn(this.approvals, connection.id) && this.approvals[connection.id] === identity) return true
    if (!await this.confirm(connection, automatic, signal, owner) || signal.aborted) return false
    const approvals = { ...this.approvals, [connection.id]: identity }
    writeConfigurationFile(this.path, JSON.stringify({ version: 1, approvals }))
    this.approvals = approvals
    return true
  }
}
