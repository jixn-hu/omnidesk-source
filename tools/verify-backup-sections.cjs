const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/backup-sections-qa-'))
const names = ['config-backup', 'backup-modules', 'vault', 'connection-store', 'shared-credentials', 'monitoring', 'ai', 'monitor-data-backup']
require('esbuild').buildSync({ entryPoints: names.map(name => path.join(root, `src/main/services/${name}.ts`)), outdir: path.join(directory, 'modules'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const load = name => require(path.join(directory, 'modules', name + '.js'))
const clients = []
function client(name, host = '192.0.2.1', url = 'https://monitor.example.test') {
  const dir = path.join(directory, name); fs.mkdirSync(dir)
  const vault = new (load('vault').VaultService)(dir); vault.init('Synthetic-local-' + name)
  const connections = new (load('connection-store').ConnectionStore)(dir)
  const shared = new (load('shared-credentials').SharedCredentialStore)(dir)
  const connection = connections.save({ kind: 'ssh', name, host, port: 22, username: 'qa', authMethod: 'password', credentialRef: name + '-password' })
  vault.setCredential(name + '-password', 'Synthetic-server-password-' + name)
  const monitor = new (load('monitoring').MonitoringService)(dir, vault, connections, async () => { throw new Error('No network in fixture') }, () => {})
  monitor.setAccountProvider(() => ({key:'synthetic-account-id',url:url+'/v1/monitor',token:'synthetic-account-token'}), async()=>({}))
  monitor.configure({ enabled: true, mode:'account' })
  const ai = new (load('ai').AiService)(dir, connections, vault, { execute: async () => { throw new Error('An imported task must never execute') } })
  ai.saveConfiguration({ baseUrl: 'https://ai.example.test/v1', model: name, apiKey: 'synthetic-ai-key-' + name, permissionMode: 'read', maxModelCalls: 30 })
  let approve = true, confirmationHook
  const record = { dir, vault, connections, shared, connection, monitor, ai, approvals: [], restored: [], setApprove(value) { approve = value }, setConfirmHook(value) { confirmationHook = value } }
  record.backup = new (load('config-backup').ConfigurationBackupService)(dir, connections, shared, vault, async (message, detail) => { record.approvals.push({ message, detail }); await confirmationHook?.(); return approve })
  record.backup.modules = load('backup-modules').createBackupModules(dir, monitor, ai, vault)
  record.backup.onRestored = summary => record.restored.push(summary)
  clients.push(record); return record
}
const preferences = { appearance: { theme: 'dark', uiFont: 'yahei', uiScale: 110, terminalFont: 'consolas', terminalFontSize: 16, sidebarShowAddress: false }, monitorView: 'list' }
const all = { sections: ['monitoring', 'preferences', 'aiSettings', 'aiHistory', 'serviceCredentials'], preferences }
const password = 'Synthetic-encrypted-backup-password'
const files = c => Object.fromEntries(fs.readdirSync(c.dir).filter(name => !name.endsWith('.tmp')).map(name => [name, fs.readFileSync(path.join(c.dir, name)).toString('base64')]))
function plaintext(contents) {
  const box = JSON.parse(contents), key = crypto.scryptSync(password, Buffer.from(box.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64')); decipher.setAAD(Buffer.from('OmniDesk encrypted configuration v1')); decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]))
}
function encrypted(snapshot) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('OmniDesk encrypted configuration v1'))
  const data = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()])
  return JSON.stringify({ format: 'omnidesk-encrypted-configuration', version: 1, kdf: 'scrypt-32768-8-1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
}
async function main() {
  const source = client('source')
  const nodeId = '1234567890abcdef12345678', agentRef = source.monitor.agentTokenRef(nodeId)
  source.vault.setCredential(agentRef, 'synthetic-agent-token-long-enough-for-testing')
  source.monitor.data.agentConnections[agentRef] = { connectionId: source.connection.id, host: source.connection.host, port: 22 }
  const conversation = source.ai.session()
  conversation.restore({ value: { ...conversation.state(), selectedIds: [source.connection.id], scopeMode: 'selected', messages: [{ id: 'synthetic-message', role: 'user', text: 'Synthetic conversation', at: 1 }, { id: 'synthetic-pending', role: 'approval', text: 'Synthetic approval', at: 2, approval: { id: 'old-approval', kind: 'edit', title: 'Synthetic edit', message: 'Never execute', outcome: 'pending' } }] }, history: [{ role: 'assistant', content: null, tool_calls: [{ id: 'unfinished-call', type: 'function', function: { name: 'run_ssh', arguments: '{}' } }] }], historyTrimmed: false })
  const base = await source.backup.create(password)
  assert.equal(plaintext(base).modules, undefined, 'legacy/no-options caller must export basic data only')
  const selected = await source.backup.create(password, { sections: ['monitoring', 'preferences'], preferences })
  const selectedRaw = plaintext(selected)
  assert.deepEqual(Object.keys(selectedRaw.modules), ['monitoring', 'preferences'])
  assert(!JSON.stringify(selectedRaw).includes('synthetic-monitor-token'))
  assert(!JSON.stringify(selectedRaw).includes('synthetic-ai-key'))
  assert(!JSON.stringify(selectedRaw).includes('synthetic-agent-token'))
  assert(!JSON.stringify(selectedRaw).includes('official-account-session'))
  const full = await source.backup.create(password, all)
  assert(!full.includes('Synthetic conversation')); assert(!full.includes('synthetic-monitor-token'))
  const destination = client('destination') // same endpoint, different local connection ID
  // Wait for normal AI autosave, so byte-for-byte cancellation compares stable files.
  await new Promise(resolve => setTimeout(resolve, 350))
  const previousSettings = destination.ai.configuration(), previousToken = destination.vault.getCredential('omnidesk-monitor-service')
  let summary = await destination.backup.restore(full, password, { sections: [] })
  assert.equal(summary.skipped, 1); assert.deepEqual(summary.sections, [])
  assert.deepEqual(destination.ai.configuration(), previousSettings)
  assert.deepEqual(destination.vault.getCredential('omnidesk-monitor-service'), previousToken)
  assert(!fs.existsSync(path.join(destination.dir, 'backup-preferences.json')))
  destination.setApprove(false)
  const beforeCancel = files(destination)
  assert.equal(await destination.backup.restore(full, password, all), null)
  assert.deepEqual(files(destination), beforeCancel)
  destination.setApprove(true)
  summary = await destination.backup.restore(full, password, all)
  assert.deepEqual(summary.sections, all.sections); assert.deepEqual(summary.preferences, preferences)
  assert.equal(destination.ai.configuration().model, 'source')
  assert.equal(destination.vault.getCredential('omnidesk-ai-api-key').secret, 'synthetic-ai-key-source')
  assert.equal(destination.monitor.agentInstallation(nodeId).connectionId, destination.connection.id)
  assert.equal(destination.vault.getCredential(agentRef).secret, 'synthetic-agent-token-long-enough-for-testing')
  assert.equal(destination.connections.list().length, 1)
  assert(destination.approvals.at(-1).detail.includes('AI 对话记录'))
  const restoredHistory = destination.ai.backupHistory()
  const imported = restoredHistory.items.find(item => item.id === conversation.id)
  assert.deepEqual(imported.snapshot.value.selectedIds, [destination.connection.id])
  assert.equal(imported.snapshot.value.messages[1].approval.outcome, 'stopped')
  assert.equal(imported.snapshot.value.pending, null)
  assert.equal(imported.snapshot.history.at(-1).role, 'tool')
  assert.equal(imported.snapshot.history.at(-1).tool_call_id, 'unfinished-call')
  const resealed = fs.readFileSync(path.join(destination.dir, 'ai-conversations.enc'), 'utf8')
  assert.doesNotThrow(() => destination.vault.openLocalData(resealed, 'OmniDesk AI conversations v1'))
  assert.throws(() => source.vault.openLocalData(resealed, 'OmniDesk AI conversations v1'))
  assert(!resealed.includes('Synthetic conversation'))
  const different = client('different', '192.0.2.2', 'https://other-monitor.example.test')
  await new Promise(resolve => setTimeout(resolve, 350))
  const beforeMismatch = files(different)
  await assert.rejects(different.backup.restore(full, password, { sections: ['serviceCredentials'] }), /服务地址不一致/)
  assert.deepEqual(files(different), beforeMismatch)
  await assert.rejects(different.backup.restore(full, password, { sections: ['monitoring'] }), /备份对应的账号/)
  different.monitor.setAccountProvider(() => ({key:'synthetic-account-id',url:'https://monitor.example.test/v1/monitor',token:'synthetic-account-token'}),async()=>({}))
  await different.backup.restore(full,password,{sections:['monitoring']})
  assert.equal(different.monitor.local().config.url, 'https://monitor.example.test/v1/monitor')
  assert.equal(different.vault.getCredential('omnidesk-monitor-service'), null, 'old endpoint token must not be used at new service')
  const beforeInvalid = files(different)
  const invalid = plaintext(full); invalid.modules.preferences.appearance.uiScale = 99999
  await assert.rejects(different.backup.restore(encrypted(invalid), password, { sections: ['preferences'] }), /偏好/)
  assert.deepEqual(files(different), beforeInvalid)
  await assert.rejects(different.backup.restore(full, 'Wrong password', all), /备份密码错误/)
  assert.deepEqual(files(different), beforeInvalid)
  const forbidden = plaintext(base); forbidden.credentials['official-account-session'] = { secret: 'Never-import-this' }
  await assert.rejects(different.backup.restore(encrypted(forbidden), password), /不能覆盖/)
  const originalMonitorLocal = different.monitor.local, originalAIConfiguration = different.ai.configuration
  different.monitor.local = () => { throw new Error('Synthetic unrelated monitor load error') }
  different.ai.configuration = () => { throw new Error('Synthetic unrelated AI load error') }
  try { assert.deepEqual((await different.backup.restore(full, password, { sections: ['preferences'] })).sections, ['preferences']) }
  finally { different.monitor.local = originalMonitorLocal; different.ai.configuration = originalAIConfiguration }
  const beforeTransaction = files(different)
  const rename = fs.renameSync
  let failedOnce = false
  fs.renameSync = (from, to) => {
    if (!failedOnce && to === path.join(different.dir, 'connections.json')) { failedOnce = true; throw new Error('Synthetic transaction write failure') }
    return rename(from, to)
  }
  try { await assert.rejects(different.backup.restore(full, password, all), /Synthetic transaction write failure/) } finally { fs.renameSync = rename }
  assert(failedOnce); assert.deepEqual(files(different), beforeTransaction)
  assert.equal(different.monitor.local().config.url, 'https://monitor.example.test/v1/monitor')
  const beforeBusy = files(different)
  different.ai.session().testing = true
  try { await assert.rejects(different.backup.restore(full, password, { sections: ['aiHistory'] }), /停止所有 AI 任务/) } finally { different.ai.session().testing = false }
  assert.deepEqual(files(different), beforeBusy)
  const guard = client('guard', '192.0.2.3')
  await new Promise(resolve => setTimeout(resolve, 350))
  guard.setConfirmHook(() => guard.connections.save({ ...guard.connection, name: 'Changed-during-confirmation' }))
  await assert.rejects(guard.backup.restore(full, password, all), /确认期间/)
  assert.equal(guard.connections.list().length, 1)
  guard.setConfirmHook(null)
  summary = await guard.backup.restore(base, password, all)
  assert.deepEqual(summary.sections, [], 'new client must import old basic-only backups')
  const fresh = client('fresh-thirty', '192.0.2.50')
  await new Promise(resolve => setTimeout(resolve, 350))
  const thirty = plaintext(full)
  const item = thirty.modules.aiHistory.items[0]
  thirty.modules.aiHistory.items = Array.from({ length: 30 }, () => ({ ...structuredClone(item), id: crypto.randomUUID() }))
  await fresh.backup.restore(encrypted(thirty), password, { sections: ['aiHistory'] })
  assert.equal(fresh.ai.state().conversations.length, 30, 'empty default conversation must not block importing a full archive')
  const { encryptMonitorData, decryptMonitorData } = load('monitor-data-backup')
  const db = Buffer.concat([Buffer.from('SQLite format 3\0'), crypto.randomBytes(256)])
  const monitorBackup = await encryptMonitorData(password, { format: 'omnidesk-monitor-database', version: 1, database: db.toString('base64'), createdAt: 1 })
  assert.deepEqual(await decryptMonitorData(password, monitorBackup), db)
  await assert.rejects(decryptMonitorData('wrong', monitorBackup), /密码错误/)
  const damaged = JSON.parse(monitorBackup); damaged.tag = Buffer.alloc(16).toString('base64')
  await assert.rejects(decryptMonitorData(password, JSON.stringify(damaged)), /篡改/)
  await assert.rejects(encryptMonitorData(password, {}), /快照/)
  console.log('PASS: selected/omitted sections, old backups, cancellation, invalid input, endpoint-bound credentials, duplicate connection mapping, AI merge/reseal/stopped approvals, concurrent edits, encrypted database roundtrip')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { for (const c of clients) c.ai.dispose() })
