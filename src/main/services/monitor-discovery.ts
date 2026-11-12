import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { MonitorDiscovery } from '@shared/monitoring'

const excluded = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) excluded.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2001:10::', 28], ['2001:20::', 28], ['2001:2::', 48]] as const) excluded.addSubnet(address, prefix, 'ipv6')
export function publicMonitorIP(ip: string): boolean {
  return isIP(ip) === 4 ? !excluded.check(ip, 'ipv4') : isIP(ip) === 6 && globalV6.check(ip, 'ipv6') && !excluded.check(ip, 'ipv6')
}
const normalizedIP = (ip: string) => isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip
const text = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : ''
export function parseMonitorDiscovery(value: unknown, expectedIP?: string): MonitorDiscovery | undefined {
  if (!value || typeof value !== 'object') return
  const v = value as Record<string, any>, ip = text(v.ip)
  if (v.success !== true || !publicMonitorIP(ip) || expectedIP && normalizedIP(ip) !== normalizedIP(expectedIP)) return
  const country = text(v.country), region = text(v.region), city = text(v.city)
  let timezone = text(v.timezone?.id)
  if (timezone) { try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { timezone = '' } }
  return { ip, provider: text(v.connection?.org) || text(v.connection?.isp), region: [...new Set([country, region, city].filter(Boolean))].join(' / '), country, city, timezone, asn: Number.isSafeInteger(v.connection?.asn) && v.connection.asn > 0 ? 'AS' + v.connection.asn : '', source: 'ipwho.is', detectedAt: Date.now() }
}

export class MonitorDiscoveryService {
  private pending = new Map<string, Promise<MonitorDiscovery | undefined>>()
  private values = new Map<string, MonitorDiscovery>()
  private retry = new Map<string, number>()
  private limitedUntil = 0
  constructor(private fetcher: typeof fetch, private resolve: typeof lookup = lookup) {}
  lookup(host: string): Promise<MonitorDiscovery | undefined> {
    if (!host || typeof host !== 'string' || host.length > 253) return Promise.resolve(undefined)
    const saved = this.values.get(host); if (saved && saved.detectedAt > Date.now() - 86400000) return Promise.resolve(saved)
    const existing = this.pending.get(host); if (existing) return existing
    if (Date.now() < Math.max(this.retry.get(host) ?? 0, this.limitedUntil) || this.pending.size >= 3) return Promise.resolve(undefined)
    const operation = this.query(host).catch(() => undefined).finally(() => this.pending.delete(host))
    this.pending.set(host, operation); return operation
  }
  private async query(host: string): Promise<MonitorDiscovery | undefined> {
    this.retry.set(host, Date.now() + 3600000)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000)
    try {
      const address = host.replace(/^\[|\]$/g, '')
      // Private hostnames and resolved private addresses never leave this machine.
      const resolved = isIP(address) ? address : await Promise.race([
        this.resolve(address).then(result => result.address),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
      ])
      if (!publicMonitorIP(resolved) || controller.signal.aborted) return
      const response = await this.fetcher('https://ipwho.is/' + encodeURIComponent(resolved) + '?fields=success,ip,country,region,city,connection,timezone.id', { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } })
      if (response.status === 429) { this.limitedUntil = Date.now() + 86400000; return }
      if (!response.ok) return
      const reader = response.body?.getReader(); if (!reader) return
      let bytes = 0; const chunks: Uint8Array[] = []
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 16384) { await reader.cancel(); return }; chunks.push(value) } } finally { reader.releaseLock() }
      const result = parseMonitorDiscovery(JSON.parse(Buffer.concat(chunks).toString('utf8')), resolved)
      if (result) this.values.set(host, result)
      return result
    } finally { clearTimeout(timer) }
  }
}
