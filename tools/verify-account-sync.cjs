const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/account-sync-qa-'))
require('esbuild').buildSync({ entryPoints: ['official-account', 'connection-store', 'shared-credentials', 'vault', 'config-backup'].map(name => path.join(root, `src/main/services/${name}.ts`)), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const load = name => require(path.join(directory, name + '.js'))
const { OfficialAccountService } = load('official-account')
const { ConnectionStore } = load('connection-store')
const { SharedCredentialStore } = load('shared-credentials')
const { VaultService } = load('vault')
const { ConfigurationBackupService } = load('config-backup')
const clients = [], errors = []
let server, origin
const accountPassword = 'QA-synthetic-account-password'
async function client(name, action = 'login') {
  const profile = path.join(directory, name); fs.mkdirSync(profile)
  const vault = new VaultService(profile); vault.init('QA-synthetic-local-password')
  const connections = new ConnectionStore(profile), shared = new SharedCredentialStore(profile)
  const record = { profile, vault, connections, shared, confirmations: 0, approve: true, requests: [], hook: null }
  record.backup = new ConfigurationBackupService(profile, connections, shared, vault, async () => { record.confirmations++; return record.approve })
  record.account = new OfficialAccountService(profile, vault, record.backup, async () => true)
  const transport = record.account.transport, request = transport.request.bind(transport)
  transport.request = async (...args) => {
    const operation = args[1] + ' ' + new URL(args[0]).pathname
    record.requests.push(operation)
    const override = await record.hook?.(operation, args)
    return override ?? request(...args)
  }
  clients.push(record)
  await record.account.configure(origin)
  await record.account.authenticate(action, 'sync_qa', accountPassword)
  return record
}
function save(record, name, host, secret) {
  const credentialRef = 'qa-password-' + name.replaceAll(' ', '-')
  if (secret) record.vault.setCredential(credentialRef, secret)
  return record.connections.save({ kind: 'ssh', name, host, port: 22, username: 'qa', authMethod: 'password', ...(secret ? { credentialRef } : {}) })
}
function shared(record, name, secret) {
  const ref = 'qa-shared-' + name.replaceAll(' ', '-'); record.vault.setCredential(ref, secret)
  return record.shared.save({ name, kind: 'password', username: 'qa', credentialRef: ref })
}
const files = record => Object.fromEntries(['connections.json', 'shared-credentials.json', 'vault.enc', 'official-account.json'].map(name => [name, fs.existsSync(path.join(record.profile, name)) ? fs.readFileSync(path.join(record.profile, name), 'utf8') : null]))
const cloud = record => record.account.request('/v1/configuration')
const response = (status, value) => ({ status, contents: Buffer.from(JSON.stringify(value)) })
async function main() {
  const { createOfficialServer } = await import(pathToFileURL(path.resolve(root, '../omnidesk-server/server.mjs')).href)
  server = createOfficialServer({ directory: path.join(directory, 'server'), registration: true, onError: error => errors.push(String(error)) })
  server.server.listen(0, '127.0.0.1'); await once(server.server, 'listening')
  origin = 'http://127.0.0.1:' + server.server.address().port
  const a = await client('device-a', 'register')
  const remote = save(a, 'Cloud connection', '192.0.2.10', 'QA-cloud-secret')
  const remoteShared = shared(a, 'Cloud credential', 'QA-cloud-shared-secret')
  assert.equal((await a.account.upload()).revision, 1)
  assert.equal(a.confirmations, 0)
  const b = await client('device-b')
  const local = save(b, 'Local connection', '192.0.2.20', 'QA-local-secret')
  const localShared = shared(b, 'Local credential', 'QA-local-shared-secret')
  const stale = await b.backup.create(b.account.login().syncKey)
  await assert.rejects(b.account.request('/v1/configuration', 'PUT', { revision: 0, contents: stale }), /另一台设备已更新/)
  assert.equal((await cloud(a)).revision, 1)
  assert.equal(b.account.status().revision, 0)
  assert.equal((await b.account.upload()).revision, 2)
  assert.equal(b.confirmations, 1)
  assert.equal(b.connections.list().length, 2)
  assert.equal(b.vault.getCredential(remote.credentialRef).secret, 'QA-cloud-secret')
  assert.equal(b.vault.getCredential(local.credentialRef).secret, 'QA-local-secret')
  assert.equal(b.shared.list().length, 2)
  assert.equal(b.vault.getCredential(remoteShared.credentialRef).secret, 'QA-cloud-shared-secret')
  assert.equal(b.vault.getCredential(localShared.credentialRef).secret, 'QA-local-shared-secret')
  console.log('PASS reproduced stale #0 rejection; fresh-device upload merges cloud/local connections and credentials before encrypted upload')

  // A matching revision must allow intentional local edits, without reimporting the older cloud snapshot.
  b.connections.save({ ...b.connections.get(remote.id), name: 'Intentional local edit' })
  const confirmations = b.confirmations
  assert.equal((await b.account.upload()).revision, 3)
  assert.equal(b.confirmations, confirmations)
  assert.equal(b.connections.get(remote.id).name, 'Intentional local edit')
  await a.account.download()
  assert.equal(a.connections.get(remote.id).name, 'Intentional local edit')
  a.connections.save({ ...a.connections.get(remote.id), name: 'Newer cloud edit' })
  save(a, 'New cloud record', '192.0.2.30')
  assert.equal((await a.account.upload()).revision, 4)
  b.connections.save({ ...b.connections.get(remote.id), name: 'Stale local edit' })
  assert.equal((await b.account.upload()).revision, 5)
  assert.equal(b.connections.get(remote.id).name, 'Newer cloud edit')
  assert(b.connections.get(local.id))
  console.log('PASS matching-revision local edits survive; stale same-ID records use cloud content while local-only records remain')

  // Exercise the actual HTTP 409 race between the preflight GET and the conditional PUT.
  const racer = await client('device-race')
  const raceLocal = save(racer, 'Race local', '192.0.2.40')
  let injected = false
  racer.hook = async operation => {
    if (!injected && operation === 'PUT /v1/configuration') {
      injected = true
      save(b, 'Concurrent cloud', '192.0.2.50')
      await b.account.upload()
    }
  }
  assert.equal((await racer.account.upload()).revision, 7)
  assert.equal(racer.requests.filter(operation => operation === 'PUT /v1/configuration').length, 2)
  assert(racer.connections.get(raceLocal.id))
  assert(racer.connections.list().some(record => record.name === 'Concurrent cloud'))
  assert.equal(racer.confirmations, 2)
  const restarted = new OfficialAccountService(racer.profile, racer.vault, racer.backup, async () => true)
  assert.equal(restarted.status().revision, 7); assert(restarted.status().lastSync); restarted.dispose()
  await b.account.download()
  assert(b.connections.get(raceLocal.id))
  console.log('PASS real concurrent cloud update retries with a fresh merge/snapshot; accepted revision and last-sync survive service restart')

  const cancelled = await client('device-cancel')
  save(cancelled, 'Never uploaded', '192.0.2.60'); shared(cancelled, 'Never uploaded credential', 'QA-never-uploaded-secret')
  cancelled.approve = false
  const beforeCancel = files(cancelled), beforeCloud = await cloud(a)
  await assert.rejects(cancelled.account.upload(), /已取消云端配置合并/)
  assert.deepEqual(files(cancelled), beforeCancel)
  assert.deepEqual(await cloud(a), beforeCloud)
  assert.equal(cancelled.requests.filter(operation => operation === 'PUT /v1/configuration').length, 0)

  const retryStart = racer.requests.length, beforeLimit = await cloud(a)
  racer.hook = async operation => operation === 'PUT /v1/configuration' ? response(409, { error: 'QA concurrent update' }) : undefined
  await assert.rejects(racer.account.upload(), /连续更新/)
  assert.equal(racer.requests.slice(retryStart).filter(operation => operation === 'PUT /v1/configuration').length, 3)
  assert.deepEqual(await cloud(a), beforeLimit)
  assert(racer.connections.get(raceLocal.id))
  console.log('PASS cancellation leaves all local/cloud files unchanged; repeated 409 is bounded at three attempts without blind overwrites')

  const invalid = await client('device-invalid')
  save(invalid, 'Preserve on failure', '192.0.2.70')
  const beforeInvalid = files(invalid)
  for (const payload of [{ revision: -1, contents: null }, { revision: 7, contents: null }, { revision: 0, contents: 'invalid' }]) {
    invalid.hook = async operation => operation === 'GET /v1/configuration' ? response(200, payload) : undefined
    await assert.rejects(invalid.account.upload(), /版本或内容无效/)
    assert.deepEqual(files(invalid), beforeInvalid)
  }
  invalid.hook = async operation => operation === 'GET /v1/configuration' ? response(200, { revision: 8, contents: '{"format":"wrong"}' }) : undefined
  await assert.rejects(invalid.account.upload(), /不是支持的/)
  assert.deepEqual(files(invalid), beforeInvalid)
  let failures = 0
  invalid.hook = async operation => operation === 'GET /v1/configuration' ? (++failures, response(503, { error: 'QA unavailable' })) : undefined
  await assert.rejects(invalid.account.upload(), /QA unavailable/)
  assert.equal(failures, 1)
  assert.deepEqual(files(invalid), beforeInvalid)
  assert.equal(invalid.requests.filter(operation => operation === 'PUT /v1/configuration').length, 0)
  assert.deepEqual(errors, [])
  console.log('PASS malformed cloud revisions, invalid encrypted content and non-conflict HTTP errors cannot advance local state or upload data')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { clients.forEach(record => record.account.dispose()); await server?.close() })
