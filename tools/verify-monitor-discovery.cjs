const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module'), esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
function load(file) {
  const result = esbuild.buildSync({ entryPoints: [path.join(root, file)], bundle: true, write: false, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') } })
  const mod = new Module(path.join(root, file), module); mod.paths = module.paths; mod._compile(result.outputFiles[0].text, file); return mod.exports
}
const { MonitorDiscoveryService, parseMonitorDiscovery, publicMonitorIP } = load('src/main/services/monitor-discovery.ts')
const { MonitoringService } = load('src/main/services/monitoring.ts')
const { EMPTY_ASSET, effectiveMonitorAsset } = load('src/shared/monitoring.ts')
const fixture = ip => ({ success: true, ip, country: 'Japan', region: 'Tokyo', city: 'Tokyo', connection: { org: 'Synthetic Cloud', isp: 'Synthetic Upstream', asn: 64500 }, timezone: { id: 'Asia/Tokyo' } })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function main() {
  for (const ip of ['127.0.0.1', '10.0.0.2', '172.16.0.1', '192.168.1.1', '100.64.1.1', '169.254.169.254', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:8.8.8.8']) assert(!publicMonitorIP(ip), ip)
  assert(publicMonitorIP('8.8.8.8')); assert(publicMonitorIP('2606:4700:4700::1111'))
  const detected = parseMonitorDiscovery(fixture('8.8.8.8'), '8.8.8.8')
  assert.equal(detected.region, 'Japan / Tokyo'); assert.equal(detected.provider, 'Synthetic Cloud'); assert.equal(detected.asn, 'AS64500')
  assert.equal(parseMonitorDiscovery(fixture('8.8.8.8'), '8.8.4.4'), undefined)
  assert.equal(parseMonitorDiscovery({ ...fixture('10.1.2.3') }), undefined)
  assert.equal(parseMonitorDiscovery({ success: false }), undefined)
  assert.equal(parseMonitorDiscovery({ ...fixture('8.8.8.8'), timezone: { id: 'Invalid/Zone' } }).timezone, '')
  assert.equal(parseMonitorDiscovery(fixture('2606:4700:4700::1111'), '2606:4700:4700:0:0:0:0:1111').ip, '2606:4700:4700::1111')
  let calls = 0, release
  const fetcher = async (url, input) => {
    calls++; assert(!Object.keys(input.headers).some(key => key.toLowerCase() === 'authorization')); assert.equal(input.redirect, 'error')
    await new Promise(resolve => { release = resolve })
    return Response.json(fixture('8.8.8.8'))
  }
  const lookup = new MonitorDiscoveryService(fetcher)
  const first = lookup.lookup('8.8.8.8'), second = lookup.lookup('8.8.8.8')
  assert.strictEqual(first, second); assert.equal(calls, 1); release()
  assert.equal((await first).provider, 'Synthetic Cloud'); await lookup.lookup('8.8.8.8'); assert.equal(calls, 1)
  const privateLookup = new MonitorDiscoveryService(() => { throw new Error('private address leaked') }, async () => ({ address: '10.0.0.2', family: 4 }))
  assert.equal(await privateLookup.lookup('internal.example'), undefined)
  assert.equal(await privateLookup.lookup('127.0.0.1'), undefined)
  let failures = 0
  const broken = new MonitorDiscoveryService(async () => { failures++; throw new Error('offline') })
  assert.equal(await broken.lookup('8.8.8.8'), undefined); await broken.lookup('8.8.8.8'); assert.equal(failures, 1)
  let throttled = 0
  const limited = new MonitorDiscoveryService(async () => { throttled++; return new Response('', { status: 429 }) })
  await limited.lookup('8.8.8.8'); await limited.lookup('8.8.4.4'); assert.equal(throttled, 1)
  assert.equal(await new MonitorDiscoveryService(async () => new Response('x'.repeat(17000))).lookup('8.8.8.8'), undefined)
  assert.equal(await new MonitorDiscoveryService(async () => new Response('not json')).lookup('8.8.8.8'), undefined)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-discovery-'))
  const connection = { id: 'fixture', kind: 'ssh', host: '8.8.8.8', name: 'fixture' }
  const vault = { status: () => 'unlocked', getCredential: () => ({ secret: 'synthetic-admin-token-do-not-forward' }) }
  let requestCount = 0, blockedResolve
  const network = async (url, input) => { requestCount++; assert(!input.headers.Authorization); await new Promise(resolve => { blockedResolve = resolve }); return Response.json(fixture(new URL(url).pathname.slice(1))) }
  const service = new MonitoringService(directory, vault, { get: () => connection }, network, () => {})
  service.saveEntry({ connectionId: 'fixture', source: 'ssh', asset: { ...EMPTY_ASSET, provider: 'Manual Seller', region: 'Manual Region', expiresAt: '2099-01-01', price: 99 } })
  const sample = { connectionId: 'fixture', timestamp: Date.now() }
  service.record(sample)
  assert.equal(service.localHistory('fixture').length, 1, 'discovery delayed metrics'); assert.equal(requestCount, 1)
  blockedResolve(); for (let i = 0; i < 20 && !service.local().entries[0].discovered; i++) await tick()
  const entry = service.local().entries[0]
  assert.equal(entry.discovered.provider, 'Synthetic Cloud'); assert.equal(entry.asset.provider, 'Manual Seller'); assert.equal(entry.asset.price, 99); assert.equal(entry.asset.timezone, 'Asia/Shanghai')
  assert.equal(effectiveMonitorAsset(entry.asset, entry.discovered).region, 'Manual Region')
  assert.equal(effectiveMonitorAsset(EMPTY_ASSET, entry.discovered).provider, 'Synthetic Cloud')
  service.saveEntry({ ...entry, asset: { ...entry.asset, provider: '', region: '' } })
  assert.equal(service.local().entries[0].discovered.provider, 'Synthetic Cloud')
  const restored = new MonitoringService(directory, vault, { get: () => connection }, network, () => {})
  restored.record({ ...sample, timestamp: sample.timestamp + 1 }); assert.equal(requestCount, 1, 'restart ignored discovery cache')
  connection.host = '8.8.4.4'
  assert.equal(restored.local().entries[0].discovered, undefined, 'old host location remained visible')
  restored.record({ ...sample, timestamp: sample.timestamp + 2 }); assert.equal(requestCount, 2)
  restored.removeEntry('fixture'); blockedResolve(); for (let i = 0; i < 10; i++) await tick()
  assert.equal(restored.local().entries.length, 0, 'in-flight discovery recreated removed entry')
  console.log('PASS discovery: public IP filtering, IPv6, parsing, daily cache, deduplication, backoff, private DNS, bounded responses, authentication isolation, nonblocking metrics, manual overrides, restart and removal')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
