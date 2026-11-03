const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
fs.mkdirSync(path.resolve('tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/updates-qa-'))
require('esbuild').buildSync({ entryPoints: ['src/main/services/app-updates.ts'], outfile: path.join(directory, 'app-updates.cjs'), bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const { AppUpdateService, compareVersions } = require(path.join(directory, 'app-updates.cjs'))
const payload = (tag = 'v0.6.0') => ({ tag_name: tag, name: 'QA Release', body: '<script>QA</script>\n更新说明', published_at: '2026-10-19T00:00:00Z', draft: false, prerelease: false, html_url: 'https://attacker.invalid', assets: [{ browser_download_url: 'https://attacker.invalid/install.exe' }] })
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
const services = []
const fixture = (fetcher, version = '0.5.0', location = fs.mkdtempSync(path.join(directory, 'data-'))) => {
  const service = new AppUpdateService(location, version, fetcher)
  services.push(service)
  return { service, location }
}
async function main() {
  const publishing = require('../package.json').build.publish
  assert.equal(publishing.provider, 'github')
  assert.equal(`${publishing.owner}/${publishing.repo}`, 'jixn-hu/omnidesk-releases')
  assert.equal(publishing.releaseType, 'draft')
  for (const [left, right, expected] of [['1.10.0', '1.2.0', 1], ['v1.2.3', '1.2.3', 0], ['1.2.3+one', '1.2.3+two', 0], ['1.2.3', '1.2.3-rc.2', 1], ['1.2.3-rc.10', '1.2.3-rc.2', 1], ['1.2.3-alpha', '1.2.3-alpha.1', -1], ['1.2.3-2', '1.2.3-beta', -1], ['1.0.0', '2.0.0', -1]]) assert.equal(compareVersions(left, right), expected)
  for (const version of ['1.2', '01.2.3', '1.2.3-01', '../1.2.3', '1.2.3/' ]) assert.throws(() => compareVersions(version, '0.5.0'))
  let requests = 0
  let mode = 'new'
  const { service, location } = fixture(async (url, options) => {
    requests++
    assert.equal(url, 'https://api.github.com/repos/jixn-hu/omnidesk-releases/releases/latest')
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert(!Object.keys(options.headers).some(key => key.toLowerCase() === 'authorization'))
    return mode === 'private' ? response({}, 404) : response(payload(mode === 'new' ? 'v0.6.0+build.1' : 'v0.5.0'))
  })
  const notifications = []
  service.on('changed', status => notifications.push(status))
  const first = service.check()
  assert.equal(service.check(), first)
  let status = await first
  assert(status.available && !status.error && !status.checking)
  assert.equal(status.release.url, 'https://github.com/jixn-hu/omnidesk-releases/releases/tag/v0.6.0%2Bbuild.1')
  assert.equal(service.releaseUrl(), status.release.url)
  status.release.url = 'https://tampered.invalid'
  assert(!service.status().release.url.includes('tampered'))
  assert(notifications[0].checking && !notifications.at(-1).checking)
  await service.check(false)
  assert.equal(requests, 1)
  const restored = fixture(async () => { throw new Error('unexpected fetch') }, '0.5.0', location).service
  assert(restored.status().available)
  assert.equal(restored.releaseUrl(), service.releaseUrl())
  const upgraded = fixture(async () => response(payload()), '1.0.0', location).service
  assert(!upgraded.status().available)
  assert.throws(() => upgraded.releaseUrl(), /尚未发现/)
  service.setAutoCheck(false)
  await service.check(false)
  assert.equal(requests, 1)
  assert.equal(fixture(async () => response(payload()), '0.5.0', location).service.status().autoCheck, false)
  assert.throws(() => service.setAutoCheck('yes'), /格式/)
  mode = 'private'
  status = await service.check()
  assert(status.error.includes('私有') && status.available)
  assert(status.lastCheckedAt && !status.checking)
  assert.equal(status.release.version, '0.6.0+build.1')
  mode = 'equal'
  status = await service.check()
  assert(!status.available && !status.error)
  console.log('PASS semantic version ordering, concurrent coalescing, change events, daily throttle, persistent opt-out/cache, upgrade recomputation, safe original-tag URL, stale update retained on network failure')
  for (const code of [404, 403, 429, 500]) {
    const result = await fixture(async () => response({}, code)).service.check()
    assert(result.error && !result.available && !result.lastCheckedAt && !result.checking)
  }
  for (const data of [{ ...payload(), prerelease: true }, { ...payload(), draft: true }, payload('v0.6.0-rc.1'), payload('not-a-version'), { ...payload(), published_at: 'invalid' }, null]) {
    const result = await fixture(async () => response(data)).service.check()
    assert(result.error && !result.lastCheckedAt && !result.available)
  }
  for (const fetcher of [async () => new Response('{invalid'), async () => new Response('x'.repeat(1024 * 1024 + 1)), async () => { throw new Error('TLS error with sensitive-detail') }]) {
    const result = await fixture(fetcher).service.check()
    assert(result.error && !result.lastCheckedAt && !result.error.includes('sensitive-detail'))
  }
  const old = await fixture(async () => response(payload('v0.1.7'))).service.check()
  assert(!old.available && !old.error && old.lastCheckedAt)
  const prerelease = await fixture(async () => response(payload('v0.5.0')), '0.5.0-rc.1').service.check()
  assert(prerelease.available)
  const notes = await fixture(async () => response({ ...payload(), body: 'a'.repeat(15000) })).service.check()
  assert.equal(notes.release.notes.length, 12000)
  console.log('PASS private/404, rate limit, HTTP/TLS/network, malformed JSON, drafts/prereleases, oversize, invalid versions/dates never report latest; downgrade ignored and release notes bounded')
  const tamperedLocation = fs.mkdtempSync(path.join(directory, 'cache-'))
  fs.writeFileSync(path.join(tamperedLocation, 'app-updates.json'), JSON.stringify({ release: { ...payload(), url: 'https://attacker.invalid' } }))
  assert.equal(fixture(async () => response(payload()), '0.5.0', tamperedLocation).service.releaseUrl(), 'https://github.com/jixn-hu/omnidesk-releases/releases/tag/v0.6.0')
  const legacyLocation = fs.mkdtempSync(path.join(directory, 'legacy-source-'))
  fs.writeFileSync(path.join(legacyLocation, 'app-updates.json'), JSON.stringify({ autoCheck: false, release: { ...payload(), html_url: 'https://github.com/jixn-hu/omnidesk/releases/tag/v0.6.0' } }))
  const migrated = fixture(async () => { throw new Error('unexpected fetch') }, '0.5.0', legacyLocation).service
  assert.equal(migrated.status().autoCheck, false)
  assert.equal(migrated.releaseUrl(), 'https://github.com/jixn-hu/omnidesk-releases/releases/tag/v0.6.0')
  console.log('PASS public distribution source and packaging metadata agree; old cached source URLs are replaced without changing auto-check preference')
  let abortObserved = false
  const stopped = fixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { abortObserved = true; reject(new Error('abort')) }))).service
  const pending = stopped.check()
  stopped.dispose()
  await pending
  assert(abortObserved && !stopped.status().checking)
  console.log('PASS tampered cache URL discarded; quitting aborts pending request without updating UI or leaking transport details')
  const nativeSetTimeout = global.setTimeout
  let timeoutPending
  try {
    global.setTimeout = (action, milliseconds, ...arguments) => nativeSetTimeout(action, milliseconds === 12000 ? 5 : milliseconds, ...arguments)
    timeoutPending = fixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))))).service.check()
  } finally { global.setTimeout = nativeSetTimeout }
  assert((await timeoutPending).error.includes('超时'))
  console.log('PASS request timeout aborts and reports retryable network error, not up-to-date')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { for (const service of services) service.dispose() })
