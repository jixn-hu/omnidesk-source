const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
function load(file) {
  const result = esbuild.buildSync({ entryPoints: [path.join(root, file)], bundle: true, write: false, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root, 'src/shared') } })
  const mod = new Module(path.join(root, file), module); mod.paths = module.paths; mod._compile(result.outputFiles[0].text, file); return mod.exports
}
const { MonitoringService } = load('src/main/services/monitoring.ts')
const { EMPTY_ASSET, renewedDate, trafficUsed } = load('src/shared/monitoring.ts')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-monitor-test-'))
const secrets = new Map(), vault = { status: () => 'unlocked', getCredential: id => secrets.get(id), setCredential: (id, secret) => secrets.set(id, { secret }) }
let calls = 0, signal
const fetcher = (url, input) => { calls++; signal = input.signal; return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')))) }
const service = new MonitoringService(directory, vault, { get: id => id === 'fixture' ? { id, kind: 'ssh', name: 'fixture' } : null }, fetcher, () => {})
async function main() {
  assert.equal(service.local().config.enabled, false)
  await assert.rejects(() => service.request('/v1/nodes'), /未开启/)
  assert.equal(calls, 0)
  assert.throws(() => service.configure({ enabled: true, url: 'http://example.com' }), /HTTPS/)
  assert.throws(() => service.configure({ enabled: true, url: 'https://user:secret@example.com' }), /不含/)
  service.configure({ enabled: true, url: 'http://127.0.0.1:18088', token: 'synthetic-admin-token-only-for-testing' })
  const pending = service.request('/v1/nodes')
  const rejected = assert.rejects(pending, /配置已变更/)
  service.configure({ enabled: false })
  assert(signal.aborted, 'disabling must abort an in-flight request')
  await rejected
  const before = calls
  await assert.rejects(() => service.request('/v1/nodes'), /未开启/)
  assert.equal(calls, before)
  service.saveEntry({ connectionId: 'fixture', source: 'ssh', asset: { ...EMPTY_ASSET, expiresAt: '2026-12-01' } })
  assert.equal(service.local().entries[0].source, 'ssh')
  assert.throws(() => service.saveEntry({ connectionId: 'fixture', source: 'agent', nodeId: '123456789012345678901234', asset: EMPTY_ASSET }), /先启用/)
  assert(!fs.readFileSync(path.join(directory, 'monitoring.json'), 'utf8').includes('synthetic-admin-token'))
  assert.equal(renewedDate('2026-01-31', 'monthly'), '2026-02-28')
  assert.equal(renewedDate('2028-01-31', 'monthly'), '2028-02-29')
  assert.equal(renewedDate('2026-12-31', 'yearly'), '2027-12-31')
  assert.equal(trafficUsed({ trafficMode: 'up' }, 100, 200), 100)
  assert.equal(trafficUsed({ trafficMode: 'sum' }, 100, 200), 300)
  const restored = new MonitoringService(directory, vault, { get: () => ({ kind: 'ssh' }) }, fetcher, () => {})
  assert.equal(restored.local().config.enabled, false)
  assert.equal(restored.local().entries[0].asset.expiresAt, '2026-12-01')
  const sensitive = 'synthetic-secret-must-never-be-in-errors'
  let failure
  const failing = new MonitoringService(fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-monitor-errors-')), vault, { get: () => null }, async () => { throw failure }, () => {})
  failing.configure({ enabled: true, url: 'https://monitor.example.com' })
  for (const [message, expected] of [
    ['net::ERR_CERT_DATE_INVALID ' + sensitive, /证书或 TLS 校验失败（ERR_CERT_DATE_INVALID）/],
    ['net::ERR_PROXY_CONNECTION_FAILED ' + sensitive, /代理连接失败（ERR_PROXY_CONNECTION_FAILED）/],
    ['getaddrinfo ENOTFOUND ' + sensitive, /域名解析失败（ENOTFOUND）/],
    ['Attempted to redirect, but redirect policy was error ' + sensitive, /发生重定向/]
  ]) {
    failure = new TypeError('fetch failed', { cause: new Error(message) })
    await assert.rejects(() => failing.request('/v1/nodes'), error => expected.test(error.message) && !error.message.includes(sensitive))
  }
  fs.writeFileSync(path.join(directory, 'monitoring.json'), '{broken')
  const damaged = new MonitoringService(directory, vault, { get: () => ({ kind: 'ssh' }) }, fetcher, () => {})
  assert.throws(() => damaged.local(), /原文件已保留/)
  assert.throws(() => damaged.configure({ enabled: false }), /原文件已保留/)
  assert.equal(fs.readFileSync(path.join(directory, 'monitoring.json'), 'utf8'), '{broken')
  console.log('Monitoring unit checks passed: opt-in, abort, persistence, vault, calendar renewal and traffic modes')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
