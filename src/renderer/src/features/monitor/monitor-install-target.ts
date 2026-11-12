import type { MonitorNode } from '@shared/monitoring'
import type { Connection } from '@shared/types'

// Suggest only an unambiguous saved target; never select the first server.
export function monitorInstallTarget(node: MonitorNode | undefined, connections: Connection[]): string | undefined {
  if (!node) return
  const os = node.metrics?.system.os?.toLowerCase()
  const candidates = connections.filter(item => (item.kind === 'ssh' || item.kind === 'rdp') && (!os || (os.includes('windows') ? item.kind === 'rdp' : item.kind === 'ssh')))
  const normalize = (value: string) => value.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const addresses = [node.metrics?.publicIP?.ipv4, node.metrics?.publicIP?.ipv6, node.metrics?.discovered?.ip, node.metrics?.system.hostname].filter((value): value is string => !!value).map(normalize)
  const byAddress = candidates.filter(item => addresses.includes(normalize(item.host)))
  if (byAddress.length === 1) return byAddress[0].id
  const byName = (byAddress.length ? byAddress : candidates).filter(item => item.name === node.name)
  if (byName.length === 1) return byName[0].id
}
