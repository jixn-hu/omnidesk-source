const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
fs.mkdirSync('tmp', { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/account-address-qa-'))
require('esbuild').buildSync({ entryPoints: ['official-account', 'connection-store', 'shared-credentials', 'vault', 'config-backup'].map(name => `src/main/services/${name}.ts`), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const load = name => require(path.join(directory, name + '.js'))
const { OfficialAccountService } = load('official-account')
const { ConnectionStore } = load('connection-store')
const { SharedCredentialStore } = load('shared-credentials')
const { VaultService } = load('vault')
const { ConfigurationBackupService } = load('config-backup')
const vault = new VaultService(directory)
vault.init('QA-local-vault-password')
const connections = new ConnectionStore(directory)
connections.save({ name: 'QA local connection', kind: 'ssh', host: '192.0.2.10', port: 22, username: 'qa' })
const shared = new SharedCredentialStore(directory)
vault.setCredential('qa-shared-password', 'QA-synthetic-shared-password')
shared.save({ name: 'QA credential', kind: 'password', username: 'qa', credentialRef: 'qa-shared-password' })
const backup = new ConfigurationBackupService(directory, connections, shared, vault, async () => true)
const accounts = []
let requests = 0
function create() {
  const service = new OfficialAccountService(directory, vault, backup, async () => true)
  service.transport.request = async () => {
    requests++
    return { status: 200, contents: Buffer.from(JSON.stringify({ user: { id: 'qa_user', username: 'qa', role: 'user' }, token: 'QA-synthetic-session-token', syncKey: 'QA-synthetic-sync-key', expiresAt: Date.now() + 60000 })) }
  }
  accounts.push(service)
  return service
}
async function main() {
  let service = create()
  assert.equal(service.status().serverUrl, '')
  assert.equal(requests, 0)
  await assert.rejects(service.providers(), /请先填写并保存账号服务地址/)
  await assert.rejects(service.authenticate('login', 'qa', 'QA-synthetic-password'), /请先填写并保存账号服务地址/)
  assert.equal(requests, 0)
  await service.configure(' https://account.example.com:47831/ ')
  assert.equal(service.status().serverUrl, 'https://account.example.com:47831')
  service = create()
  assert.equal(service.status().serverUrl, 'https://account.example.com:47831')
  await service.configure(' http://192.0.2.75:47831/ ')
  assert.equal(service.status().serverUrl, 'http://192.0.2.75:47831')
  service = create()
  assert.equal(service.status().serverUrl, 'http://192.0.2.75:47831')
  await service.configure('http://account.internal:47831')
  assert.equal(service.status().serverUrl, 'http://account.internal:47831')
  for (const address of ['ftp://account.internal', 'file:///tmp/account', 'ws://account.internal', 'http://account.internal?token=test', 'http://account.internal#test']) await assert.rejects(service.configure(address))
  await assert.rejects(service.configure('https://user:password@account.example.com'), /不能包含账号密码/)
  await service.authenticate('login', 'qa', 'QA-synthetic-password')
  assert.equal(service.status().user.id, 'qa_user')
  const connectionsBefore = fs.readFileSync(path.join(directory, 'connections.json'), 'utf8')
  const sharedBefore = fs.readFileSync(path.join(directory, 'shared-credentials.json'), 'utf8')
  await service.configure('   ')
  assert.equal(service.status().serverUrl, '')
  assert.equal(service.status().user, null)
  assert.equal(vault.getCredential('official-account-session'), null)
  assert.equal(fs.readFileSync(path.join(directory, 'connections.json'), 'utf8'), connectionsBefore)
  assert.equal(fs.readFileSync(path.join(directory, 'shared-credentials.json'), 'utf8'), sharedBefore)
  assert.equal(vault.getCredential('qa-shared-password').secret, 'QA-synthetic-shared-password')
  assert.equal(create().status().serverUrl, '')
  await service.configure('http://127.0.0.1:47830')
  assert.equal(create().status().serverUrl, 'http://127.0.0.1:47830')
  await service.configure('http://192.0.2.75:47831')
  const id = 'A'.repeat(43), secret = 'B'.repeat(43)
  let authorizationUrl = 'https://192.0.2.75:47831/v1/auth/gitlab/authorize?request=' + id
  service.transport.request = async () => ({ status: 200, contents: Buffer.from(JSON.stringify({ id, secret, expiresAt: Date.now() + 60000, authorizationUrl })) })
  assert.equal((await service.startGitlab('login')).authorizationUrl, authorizationUrl)
  service.cancelGitlab(id)
  authorizationUrl = 'http://192.0.2.75:47831/v1/auth/gitlab/authorize?request=' + id
  assert.equal((await service.startGitlab('login')).authorizationUrl, authorizationUrl)
  service.cancelGitlab(id)
  for (const value of [
    'https://attacker.internal:47831/v1/auth/gitlab/authorize',
    'https://192.0.2.75:47832/v1/auth/gitlab/authorize',
    'https://192.0.2.75:47831/wrong'
  ]) {
    authorizationUrl = value + '?request=' + id
    await assert.rejects(service.startGitlab('login'), /浏览器地址无效/)
  }
  await service.configure('https://192.0.2.75:47831')
  authorizationUrl = 'http://192.0.2.75:47831/v1/auth/gitlab/authorize?request=' + id
  await assert.rejects(service.startGitlab('login'), /浏览器地址无效/)
  console.log('PASS: GitLab accepts explicit HTTP service with same-host HTTPS authorization; rejects other hosts, ports, paths and HTTPS downgrade')
  console.log('PASS: empty account address, no unsolicited requests, explicit HTTP/HTTPS persistence, intranet IP and hostname, invalid URLs, local development, clearing session preserves local connections and shared credentials')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => accounts.forEach(service => service.dispose()))
