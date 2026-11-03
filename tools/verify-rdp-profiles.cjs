const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
fs.mkdirSync(path.resolve('tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/rdp-profiles-'))
const entries = ['src/shared/rdp-display.ts', 'src/shared/shared-configuration.ts', ...['rdp-system-client', 'config-backup', 'vault', 'shared-credentials', 'connection-store'].map(name => 'src/main/services/' + name + '.ts')]
require('esbuild').buildSync({ entryPoints: entries, outdir: directory, outbase: 'src', bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const { rdpDisplaySize, rdpPerformanceOptions } = require(path.join(directory, 'shared/rdp-display.js'))
const { sharedConfiguration } = require(path.join(directory, 'shared/shared-configuration.js'))
const { systemRdpContent } = require(path.join(directory, 'main/services/rdp-system-client.js'))
const { ConfigurationBackupService } = require(path.join(directory, 'main/services/config-backup.js'))
const { VaultService } = require(path.join(directory, 'main/services/vault.js'))
const { SharedCredentialStore } = require(path.join(directory, 'main/services/shared-credentials.js'))
const { ConnectionStore } = require(path.join(directory, 'main/services/connection-store.js'))
const profiles = [['smooth', 1600, 900], ['balanced', 1920, 1080], ['clear', 8192, 8192]]
const rectangles = [[3840, 2160], [3440, 1440], [2560, 1080], [1080, 1920], [800, 600], [1001, 701], [200, 200], [NaN, Infinity], [1, 1], [100000, 100000]]
for (const [mode, width, height] of profiles) {
  for (const [inputWidth, inputHeight] of rectangles) for (const ratio of [1, 1.25, 1.5, 2, 3, NaN]) {
    const display = rdpDisplaySize(inputWidth, inputHeight, ratio, mode)
    assert(display.width >= 200 && display.width <= width)
    assert(display.height >= 200 && display.height <= height)
    assert.equal(display.width % 2, 0)
    assert(display.scaleFactor >= 100 && display.scaleFactor <= 200 && Number.isInteger(display.scaleFactor))
    if (inputWidth >= 800 && inputHeight >= 600 && inputWidth < 100000) assert(Math.abs(display.width / display.height - inputWidth / inputHeight) < 0.012)
  }
}
assert.deepEqual(rdpDisplaySize(3840, 2160, 1, 'smooth'), { width: 1600, height: 900, scaleFactor: 100 })
assert.deepEqual(rdpDisplaySize(3840, 2160, 1, 'balanced'), { width: 1920, height: 1080, scaleFactor: 100 })
assert.deepEqual(rdpDisplaySize(1920, 1080, 2, 'clear'), { width: 3840, height: 2160, scaleFactor: 200 })
assert.deepEqual(rdpDisplaySize(1001, 701, 1.25), { width: 1250, height: 876, scaleFactor: 125 })
assert.deepEqual(rdpDisplaySize(800, 600, 1, 'smooth'), { width: 800, height: 600, scaleFactor: 100 })
console.log('PASS all profiles: 4K, ultrawide, portrait, HiDPI, small/invalid inputs, aspect ratio, even widths and valid desktop scale')
const legacy = { colorDepth: 24, showWallpaper: true, ignoreCertificate: false, enableClipboard: false }
assert.deepEqual(rdpPerformanceOptions(legacy), legacy)
for (const [mode] of profiles) {
  const options = { ...legacy, performanceMode: mode, fullscreen: true }
  const content = systemRdpContent({ kind: 'rdp', host: '192.0.2.1', port: 3389, username: 'qa', options }, { username: 'qa', secret: 'QA-ONLY-SECRET' }, { x: -3840, y: 0, width: 3840, height: 2160 })
  const properties = Object.fromEntries(content.split('\r\n').filter(Boolean).map(line => { const separator = line.indexOf(':'); return [line.slice(0, separator), line.slice(separator + 1)] }))
  const size = rdpDisplaySize(3840, 2160, 1, mode)
  assert.equal(properties.desktopwidth, 'i:' + size.width)
  assert.equal(properties.desktopheight, 'i:' + size.height)
  assert.equal(properties['screen mode id'], 'i:2')
  assert.equal(properties['dynamic resolution'], mode === 'clear' ? 'i:1' : 'i:0')
  assert.equal(properties['smart sizing'], mode === 'clear' ? 'i:0' : 'i:1')
  assert.equal(properties['session bpp'], mode === 'smooth' ? 'i:16' : 'i:32')
  assert.equal(properties['disable wallpaper'], mode === 'clear' ? 'i:0' : 'i:1')
  assert.equal(properties['allow font smoothing'], mode === 'smooth' ? 'i:0' : 'i:1')
  assert.equal(properties['disable menu anims'], 'i:1')
  assert.equal(properties.redirectclipboard, 'i:0')
  assert.equal(properties['authentication level'], 'i:2')
  assert.equal(properties.enablecredsspsupport, 'i:1')
  assert(!content.includes('QA-ONLY-SECRET'))
  assert.equal(rdpPerformanceOptions({ ...options, systemSmartSizing: false }).systemSmartSizing, false)
}
console.log('PASS system RDP caps cannot be overridden by dynamic resolution, native clear pixels, explicit fit override, valid effect keys, no password in file, NLA/cert/clipboard unchanged')
function fixture() {
  const data = fs.mkdtempSync(path.join(directory, 'data-'))
  const vault = new VaultService(data)
  vault.init()
  const connections = new ConnectionStore(data)
  const shared = new SharedCredentialStore(data)
  return { connections, backup: new ConfigurationBackupService(data, connections, shared, vault, async () => true) }
}
async function main() {
  const source = fixture()
  for (const [index, [mode]] of profiles.entries()) {
    const configuration = { kind: 'rdp', name: 'QA-' + mode, host: '192.0.2.' + (index + 1), port: 3389, username: 'qa', options: { engine: 'freerdp', securityMode: index === 0 ? 'legacy' : 'auto', performanceMode: mode, ignoreCertificate: false, fullscreen: true, systemSmartSizing: false, colorDepth: 24 } }
    const sanitized = sharedConfiguration(configuration)
    assert.deepEqual(sanitized.options, configuration.options)
    source.connections.save(configuration)
  }
  assert.throws(() => sharedConfiguration({ kind: 'rdp', name: 'QA', host: '192.0.2.9', port: 3389, username: 'qa', options: { performanceMode: 'invalid' } }), /画质模式/)
  const destination = fixture()
  await destination.backup.restore(await source.backup.create('QA-SYNTHETIC-BACKUP'), 'QA-SYNTHETIC-BACKUP')
  for (const record of source.connections.list()) assert.deepEqual(destination.connections.get(record.id).options, record.options)
  console.log('PASS encrypted backup round-trip and cloud sharing sanitizer preserve all profiles and explicit options; invalid modes rejected')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
