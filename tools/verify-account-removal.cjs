const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
process.env.NODE_PATH = path.resolve('node_modules')
require('node:module').Module._initPaths()
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-account-removal-'))
require('esbuild').buildSync({ entryPoints: ['official-account', 'vault', 'monitoring'].map(name => 'src/main/services/' + name + '.ts'), outdir: path.join(directory, 'modules'), bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const { OfficialAccountService } = require(path.join(directory, 'modules/official-account.js'))
const { VaultService } = require(path.join(directory, 'modules/vault.js'))
const { MonitoringService } = require(path.join(directory, 'modules/monitoring.js'))
const vault = new VaultService(directory)
vault.init('synthetic-vault-password')
const backup = { create: async () => null, restore: async () => null }
const service = new OfficialAccountService(directory, vault, backup, async () => true)
let requests = 0, resolvePending, offline = false
service.transport.request = async (url, method, headers, body) => {
  requests++
  if (offline) throw new Error('synthetic offline')
  const target = new URL(url)
  if (target.pathname === '/v1/auth/login') {
    const username = JSON.parse(body).username
    return { status: 200, contents: Buffer.from(JSON.stringify({ user: { id: target.hostname + ':' + username, username, role: 'user' }, token: 'synthetic-token', syncKey: 'synthetic-sync-key', expiresAt: Date.now() + 600000 })) }
  }
  return new Promise(resolve => { resolvePending = () => resolve({ status: 200, contents: Buffer.from('[]') }) })
}
const changes = []
const monitor = new MonitoringService(directory, vault, { get: () => null }, fetch, () => {})
monitor.setAccountProvider(() => service.monitorContext(), (p, m, b) => service.monitorRequest(p, m, b))
service.onContextChanged = (changed = true) => { changes.push(changed); if (changed) monitor.accountChanged() }
const ref = id => 'official-account-session:' + id
const read = name => fs.readFileSync(path.join(directory, name))
async function main() {
  await service.configure('https://first.example.test')
  const a = (await service.authenticate('login', 'same_user', 'qa1234')).activeAccountId
  const c = (await service.authenticate('login', 'other_user', 'qa1234')).activeAccountId
  await service.configure('https://second.example.test')
  const b = (await service.authenticate('login', 'same_user', 'qa5678')).activeAccountId
  service.persist({ ...service.state, revision: 42, lastSync: 1234 })
  monitor.configure({ enabled: true, mode: 'account' })
  const expired = JSON.parse(vault.getCredential(ref(a)).secret)
  expired.expiresAt = Date.now() - 1
  vault.setCredential(ref(a), JSON.stringify(expired))
  vault.setCredential('synthetic-ssh', 'synthetic-ssh-password')
  vault.setCredential('synthetic-webdav', 'synthetic-webdav-password')
  const tokenRef = monitor.agentTokenRef('1'.repeat(24))
  vault.setCredential(tokenRef, 'synthetic-agent-token')
  const sentinelFiles = ['connections.json', 'shared-credentials.json', 'webdav-sync.json', 'monitoring.json', 'backup-preferences.json']
  for (const name of sentinelFiles) fs.writeFileSync(path.join(directory, name), JSON.stringify({ synthetic: name }))
  const preserved = new Map(sentinelFiles.map(name => [name, read(name)]))
  const originalB = vault.getCredential(ref(b)).secret
  const originalC = vault.getCredential(ref(c)).secret
  let releases = 0
  service.sessions.set('synthetic-relay', { close: () => { releases++; service.sessions.delete('synthetic-relay') } })
  monitor.histories.set('synthetic-cache', ['keep'])
  offline = true
  const beforeRequests = requests
  changes.length = 0
  // Failed disk writes must roll back the encrypted vault and account list together.
  const beforeVault = read('vault.enc'), beforeState = read('official-account.json')
  const rename = fs.renameSync
  let failOnce = true
  fs.renameSync = (from, to) => {
    if (to === path.join(directory, 'official-account.json') && failOnce) { failOnce = false; throw new Error('synthetic write failure') }
    return rename(from, to)
  }
  try { await assert.rejects(service.removeAccount(c), /synthetic write failure/) }
  finally { fs.renameSync = rename }
  assert.deepEqual(read('vault.enc'), beforeVault)
  assert.deepEqual(read('official-account.json'), beforeState)
  assert.equal(vault.getCredential(ref(c)).secret, originalC)
  assert.equal(service.status().accounts.length, 3)
  assert.deepEqual(changes, [])
  const afterInactive = await service.removeAccount(a)
  assert.equal(afterInactive.activeAccountId, b)
  assert.equal(afterInactive.user.username, 'same_user')
  assert.equal(afterInactive.revision, 42)
  assert.equal(afterInactive.lastSync, 1234)
  assert.equal(vault.getCredential(ref(a)), null)
  assert.equal(vault.getCredential(ref(b)).secret, originalB)
  assert.equal(vault.getCredential(ref(c)).secret, originalC)
  assert.deepEqual(changes, [false])
  assert.equal(releases, 0)
  assert(monitor.histories.has('synthetic-cache'))
  await assert.rejects(service.removeAccount(a), /不存在|已从本机移除/)
  await assert.rejects(service.removeAccount(null), /无效账号/)
  assert.equal(requests, beforeRequests)
  // Signed-out current profiles can be removed without reauthentication.
  await service.switchAccount(c)
  vault.deleteCredential(ref(c))
  assert.equal(service.status().user, null)
  changes.length = 0
  const afterSignedOut = await service.removeAccount(c)
  assert.equal(afterSignedOut.activeAccountId, undefined)
  assert.equal(afterSignedOut.user, null)
  assert.equal(afterSignedOut.accounts.length, 1)
  assert.equal(afterSignedOut.accounts[0].id, b)
  assert.equal(afterSignedOut.accounts[0].signedIn, true)
  assert.equal(afterSignedOut.revision, 0)
  assert.equal(afterSignedOut.lastSync, undefined)
  assert.deepEqual(changes, [true])
  assert.equal(requests, beforeRequests)
  // Removing the signed-in current account invalidates in-flight cloud results.
  await service.switchAccount(b)
  offline = false
  const pending = monitor.request('/v1/nodes')
  const stale = assert.rejects(pending, /账号已切换|配置已切换/)
  assert(resolvePending)
  offline = true
  const requestsBeforeCurrentRemoval = requests
  service.gitlabAttempt = { id: 'synthetic', secret: 'synthetic', expiresAt: Date.now() + 60000, serverUrl: service.status().serverUrl }
  service.sessions.set('synthetic-relay', { close: () => { releases++; service.sessions.delete('synthetic-relay') } })
  const releaseBefore = releases
  const afterActive = await service.removeAccount(b)
  resolvePending()
  await stale
  assert.equal(releases, releaseBefore + 1)
  assert.equal(service.gitlabAttempt, undefined)
  assert.equal(requests, requestsBeforeCurrentRemoval)
  assert.deepEqual(afterActive.accounts, [])
  assert.equal(afterActive.activeAccountId, undefined)
  assert.equal(afterActive.user, null)
  assert.equal(service.monitorContext().token, undefined)
  assert.equal(vault.getCredential(ref(b)), null)
  assert.deepEqual(afterActive.serverHistory, ['https://second.example.test', 'https://first.example.test'])
  for (const [name, bytes] of preserved) assert.deepEqual(read(name), bytes, name)
  assert.equal(vault.getCredential('synthetic-ssh').secret, 'synthetic-ssh-password')
  assert.equal(vault.getCredential('synthetic-webdav').secret, 'synthetic-webdav-password')
  assert.equal(vault.getCredential(tokenRef).secret, 'synthetic-agent-token')
  const restartedVault = new VaultService(directory)
  restartedVault.unlock('synthetic-vault-password')
  const restarted = new OfficialAccountService(directory, restartedVault, backup, async () => true)
  assert.deepEqual(restarted.status().accounts, [])
  assert.equal(restarted.status().user, null)
  assert(!restartedVault.listCredentialRefs().some(value => value.startsWith('official-account-session')))
  restarted.dispose()
  // The original single-account format must not resurrect through its legacy token.
  const legacyDir = path.join(directory, 'legacy')
  fs.mkdirSync(legacyDir)
  const legacyVault = new VaultService(legacyDir)
  legacyVault.init('synthetic-legacy-password')
  legacyVault.setCredential('official-account-session', JSON.stringify({ serverUrl: 'https://legacy.example.test', user: { id: 'legacy', username: 'legacy', role: 'user' }, token: 'synthetic', syncKey: 'synthetic', expiresAt: Date.now() + 60000 }))
  fs.writeFileSync(path.join(legacyDir, 'official-account.json'), JSON.stringify({ serverUrl: 'https://legacy.example.test', revision: 9 }))
  const legacy = new OfficialAccountService(legacyDir, legacyVault, backup, async () => true)
  assert(legacy.status().activeAccountId)
  await legacy.removeAccount(legacy.status().activeAccountId)
  assert.equal(legacyVault.getCredential('official-account-session'), null)
  assert.deepEqual(legacy.status().accounts, [])
  assert.equal(legacy.status().user, null)
  legacy.dispose()
  console.log('PASS: offline current/expired/inactive removal, credential cleanup, persistence, scoped notifications, stale-request rejection, relay cleanup, legacy cleanup, write-failure rollback and local connection/WebDAV/monitor data preservation')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => service.dispose())
