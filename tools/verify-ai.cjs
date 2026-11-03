const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const { once } = require('node:events')
const crypto = require('node:crypto')
fs.mkdirSync('tmp', { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/ai-qa-'))
require('esbuild').buildSync({ entryPoints: ['ai', 'ai-tools', 'connection-store', 'shared-credentials', 'vault', 'config-backup'].map(name => `src/main/services/${name}.ts`), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const load = name => require(path.join(directory, name + '.js'))
const { AiService } = load('ai')
const { linuxQueries, publicServer, redactAiText } = load('ai-tools')
const { ConnectionStore } = load('connection-store')
const { VaultService } = load('vault')
const { SharedCredentialStore } = load('shared-credentials')
const { ConfigurationBackupService, recoverConfigurationImport } = load('config-backup')
const vault = new VaultService(directory)
vault.init('Synthetic-local-vault')
const password = 'QA-password-very-private-8477', privateKey = 'QA-private-key-2677', apiKey = 'QA-api-key-3799' // gitleaks:allow -- synthetic inputs for credential redaction tests
vault.setCredential('qa-password-ref', password)
vault.setCredential('qa-private-ref', privateKey)
const connections = new ConnectionStore(directory)
const first = connections.save({ kind: 'ssh', name: 'Alpha', host: '192.0.2.10', port: 22, username: 'qa', authMethod: 'password', credentialRef: 'qa-password-ref', tags: ['旧标签'], note: '原始备注', group: '测试', proxy: { type: 'socks5', host: '192.0.2.50', port: 1080, username: 'qa-proxy', password: 'QA-proxy-secret' }, exposedToExternal: false })
const second = connections.save({ kind: 'ssh', name: 'Beta', host: '192.0.2.11', port: 22, username: 'qa', authMethod: 'privateKey', credentialRef: 'qa-private-ref' })
const windows = connections.save({ kind: 'rdp', name: 'Windows', host: '192.0.2.12', port: 3389, username: 'qa' })
let expectedKey = apiKey
let steps = [], requests = [], serial = 0, executions = [], changes = 0, destination = 'effective-qa@192.0.2.10:22'
const call = (name, args) => ({ id: 'call_' + ++serial, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls })
const done = { role: 'assistant', content: '任务结束。' }
const server = createServer(async (request, reply) => {
  try {
    assert.equal(request.url, '/v1/chat/completions')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    requests.push(body)
    assert.equal(body.model, 'explicit-qa-model')
    assert.equal(request.headers.authorization, expectedKey ? 'Bearer ' + expectedKey : undefined)
    const next = steps.shift()
    assert(next, 'Unexpected model request')
    const message = typeof next === 'function' ? next(body, reply) : next
    if (message === false) return
    reply.writeHead(200, { 'Content-Type': 'application/json' })
    reply.end(JSON.stringify({ choices: [{ message }] }))
  } catch (error) { reply.writeHead(500); reply.end(String(error)); failures.push(error) }
})
const failures = []
const options = {
  approvalTimeoutMs: 2000,
  destination: () => destination,
  metadataChanged: () => changes++,
  execute: async (connection, command, signal, beforeExecute) => {
    beforeExecute(destination)
    executions.push({ id: connection.id, command })
    if (command === 'hang') await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    return { stdout: 'synthetic output', stderr: '', code: 0, durationMs: 1, truncated: false }
  }
}
let ai = new AiService(directory, connections, vault, options)
async function until(predicate, label) {
  const deadline = Date.now() + 6000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timeout: ' + label + ' ' + JSON.stringify(ai.state())); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function start(next, ids = [first.id], text = '处理已选服务器') {
  assert.equal(ai.state().status, 'idle'); assert.equal(steps.length, 0)
  steps = [...next]
  ai.send(text, ids)
}
async function idle() { await until(() => ai.state().status === 'idle', 'idle'); assert.equal(steps.length, 0); assert.deepEqual(failures, []) }
function errors() { return ai.state().messages.filter(message => message.error).map(message => message.text).join('\n') }
async function main() {
  for (const value of [
    'password=unseen-secret', '"password":"unseen-secret"', "'api_key': 'unseen-secret'", 'Authorization: Bearer unseen-secret',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nunseen-secret\n-----END OPENSSH PRIVATE KEY-----', // gitleaks:allow -- synthetic inputs for credential redaction tests
    '-----BEGIN RSA PRIVATE KEY-----\nunseen-secret\ntruncated', 'some known-' + password
  ]) assert(!redactAiText(value, [password]).includes('unseen-secret') && !redactAiText(value, [password]).includes(password), value)
  assert.equal(ai.configuration().baseUrl, '')
  assert.throws(() => ai.send('x', [first.id]), /请先配置/)
  for (const baseUrl of ['file:///local', 'https://user:password@example.test/v1', 'https://example.test/v1?key=x']) assert.throws(() => ai.saveConfiguration({ baseUrl, model: 'qa' }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  ai.saveConfiguration({ baseUrl, model: 'explicit-qa-model', apiKey, permissionMode: 'full' })
  recoverConfigurationImport(directory)
  assert.equal(ai.configuration().hasApiKey, true)
  assert(!fs.readFileSync(path.join(directory, 'ai-settings.json'), 'utf8').includes(apiKey))
  assert(!fs.readFileSync(path.join(directory, 'vault.enc'), 'utf8').includes(apiKey))
  const restored = new AiService(directory, connections, vault, options)
  assert.deepEqual(restored.configuration(), ai.configuration()); restored.dispose()
  steps = [done]; assert.match(await ai.test(), /连接成功/)
  ai.saveConfiguration({ baseUrl, model: 'explicit-qa-model', clearApiKey: true })
  assert.equal(ai.configuration().hasApiKey, false); assert.equal(vault.getCredential('omnidesk-ai-api-key'), null)
  expectedKey = ''; steps = [done]; assert.match(await ai.test(), /连接成功/)
  ai.saveConfiguration({ baseUrl: baseUrl + '/chat/completions', model: 'explicit-qa-model', apiKey })
  expectedKey = apiKey; steps = [done]; assert.match(await ai.test(), /连接成功/)
  ai.saveConfiguration({ baseUrl, model: 'explicit-qa-model' })
  assert.equal(ai.configuration().hasApiKey, true)
  const original = connections.get(first.id)
  await start([response(call('list_servers', {})), response(call('update_metadata', { server_ids: [first.id], changes: { tags: { mode: 'add', values: ['生产环境'] }, note: { mode: 'append', value: 'AI 新备注' }, group: { mode: 'replace', value: '华东' } } })), done])
  await idle()
  const updated = connections.get(first.id)
  assert.deepEqual(updated.tags, ['旧标签', '生产环境']); assert.equal(updated.note, '原始备注\nAI 新备注'); assert.equal(updated.group, '华东')
  for (const key of Object.keys(original).filter(key => !['tags', 'note', 'group', 'updatedAt'].includes(key))) assert.deepEqual(updated[key], original[key], key)
  assert.equal(changes, 1); assert.equal(vault.getCredential('qa-password-ref').secret, password)
  for (const request of requests) {
    const serialized = JSON.stringify(request)
    for (const secret of [password, privateKey, apiKey, 'QA-proxy-secret', 'qa-password-ref', 'qa-private-ref', 'credentialRef', 'sharedCredentialId']) assert(!serialized.includes(secret), secret + ' leaked')
  }
  assert.deepEqual(Object.keys(publicServer(updated)).sort(), ['id', 'kind', 'name', 'host', 'port', 'address', 'username', 'group', 'tags', 'note'].sort())
  await start([response(call('update_metadata', { server_ids: [second.id], changes: { note: { mode: 'replace', value: 'unauthorized' } } }), call('update_metadata', { server_ids: [first.id], changes: { password: 'malicious' } })), done])
  await idle(); assert.match(errors(), /选中/); assert.equal(connections.get(second.id).note, undefined); assert.equal(vault.getCredential('qa-password-ref').secret, password)
  await start([response(call('inspect_linux', { server_id: first.id, topic: 'disks; rm -rf /' }), call('inspect_linux', { server_id: first.id, topic: 'disks', command: 'rm -rf /' })), done])
  await idle(); assert.equal(executions.length, 0)
  await start([response(call('run_ssh', { server_id: first.id, command: 'echo hidden\x1b[2J', reason: 'control characters' })), done]); await idle(); assert.equal(executions.length, 0)
  await start([response(call('inspect_linux', { server_id: first.id, topic: 'disks' })), done]); await idle()
  assert.equal(executions.pop().command, linuxQueries.disks)
  const custom = call('run_ssh', { server_id: first.id, command: 'echo synthetic-operation', reason: '仅测试确认流程' })
  await start([response(custom), done]); await until(() => ai.state().pending, 'approval')
  const pending = ai.state().pending
  assert.equal(pending.kind, 'ssh')
  assert.equal(ai.state().messages.find(message => message.approval?.id === pending.id).approval.outcome, 'pending')
  assert.equal(pending.destination, destination); assert.equal(pending.command, 'echo synthetic-operation'); assert.equal(executions.length, 0)
  assert.equal(ai.confirm('wrong-id', true), false)
  assert.equal(ai.confirm(pending.id, true), true); assert.equal(ai.confirm(pending.id, true), false)
  await idle(); assert.equal(executions.pop().command, pending.command)
  assert.equal(ai.state().messages.find(message => message.approval?.id === pending.id).approval.outcome, 'confirmed')
  await start([response(custom), response(call('run_ssh', { server_id: first.id, command: custom.function.arguments && 'echo synthetic-operation', reason: 'retry' })), done])
  await until(() => ai.state().pending, 'reject'); ai.confirm(ai.state().pending.id, false); await idle(); assert.equal(executions.length, 0)
  options.approvalTimeoutMs = 45
  await start([response(custom), done]); await idle(); assert.equal(executions.length, 0)
  assert.equal(ai.state().messages.filter(message => message.approval).at(-1).approval.outcome, 'expired')
  options.approvalTimeoutMs = 2000
  await start([response(custom)]); await until(() => ai.state().pending, 'cancel')
  const cancelledId = ai.state().pending.id
  ai.cancel(); await idle(); assert.equal(ai.confirm(cancelledId, true), false); assert.equal(executions.length, 0)
  assert.equal(ai.state().messages.find(message => message.approval?.id === cancelledId).approval.outcome, 'stopped')
  await start([response(custom), done]); await until(() => ai.state().pending, 'stale')
  connections.save({ ...connections.get(first.id), host: '192.0.2.99' })
  ai.confirm(ai.state().pending.id, true); await idle(); assert.equal(executions.length, 0); assert.match(errors(), /其他操作修改/)
  await start([response(custom), done]); await until(() => ai.state().pending, 'account change')
  destination = 'different-user@192.0.2.99:22'; ai.confirm(ai.state().pending.id, true); await idle(); assert.equal(executions.length, 0); assert.match(errors(), /账号已变化/)
  ai.clear()
  const question = call('ask_user', { title: '确认巡检方案', message: '是否继续检查已选服务器，并整理结果？' })
  await start([body => { assert(body.tools.some(tool => tool.function.name === 'ask_user')); return response(question) }, body => {
    assert.equal(JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content).confirmed, true)
    return response(custom)
  }, done])
  await until(() => ai.state().pending?.kind === 'question', 'general confirmation')
  const questionId = ai.state().pending.id
  assert.equal(executions.length, 0); assert.equal(ai.confirm(questionId, true), true); assert.equal(ai.confirm(questionId, true), false)
  await until(() => ai.state().pending?.kind === 'ssh', 'independent SSH approval')
  assert.equal(executions.length, 0, 'A general confirmation must not authorize an SSH command')
  const rejectedId = ai.state().pending.id
  ai.confirm(rejectedId, false); await idle(); assert.equal(executions.length, 0)
  assert.equal(ai.state().messages.find(message => message.approval?.id === rejectedId).approval.outcome, 'cancelled')
  const unchanged = connections.get(first.id)
  const beforeCancel = requests.length
  await start([response(question, call('update_metadata', { server_ids: [first.id], changes: { note: { mode: 'append', value: '不应写入' } } }), custom)])
  await until(() => ai.state().pending?.kind === 'question', 'cancel general confirmation')
  ai.confirm(ai.state().pending.id, false); await idle()
  assert.deepEqual(connections.get(first.id), unchanged); assert.equal(executions.length, 0); assert.equal(requests.length, beforeCancel + 1)
  assert.match(ai.state().messages.at(-1).text, /已取消，本轮后续操作未执行/)
  options.approvalTimeoutMs = 45
  await start([response(question, custom)]); await idle()
  assert.equal(ai.state().messages.filter(message => message.approval).at(-1).approval.outcome, 'expired')
  assert.match(ai.state().messages.at(-1).text, /确认已超时/); assert.equal(executions.length, 0)
  options.approvalTimeoutMs = 2000
  await start([response(call('ask_user', { title: '', message: 'missing title' }), call('ask_user', { title: 'bad', message: 'x', command: 'bypass' })), done]); await idle()
  assert.equal(ai.state().pending, null); assert.match(errors(), /确认标题|格式不正确/)
  ai.clear()
  const windowsExecutions = []
  options.inspectWindows = async (connection, topic, signal, guard) => {
    guard(destination)
    windowsExecutions.push({ id: connection.id, topic })
    return { stdout: 'Windows Server synthetic status', stderr: '', code: 0, durationMs: 1, truncated: false }
  }
  await start([body => {
    const names = body.tools.map(tool => tool.function.name)
    assert(names.includes('inspect_windows') && !names.includes('inspect_linux') && !names.includes('run_ssh'))
    return response(call('inspect_windows', { server_id: windows.id, topic: 'resources' }))
  }, done], [windows.id]); await idle()
  assert.deepEqual(windowsExecutions.splice(0), [{ id: windows.id, topic: 'resources' }])
  await start([response(call('inspect_windows', { server_id: first.id, topic: 'system' }), call('inspect_windows', { server_id: windows.id, topic: 'services;Remove-Item' }), call('inspect_windows', { server_id: windows.id, topic: 'system', command: 'whoami' })), done], [windows.id]); await idle()
  assert.equal(windowsExecutions.length, 0)
  await start([response(call('inspect_windows', { server_id: first.id, topic: 'system' })), done]); await idle()
  assert.equal(windowsExecutions.length, 0)
  options.inspectWindows = async () => { windowsExecutions.push('attempt'); throw Object.assign(new Error('Windows 管理通道不可达'), { windowsUnavailable: true }) }
  const activityCount = ai.state().messages.filter(message => message.error).length
  await start([response(call('inspect_windows', { server_id: windows.id, topic: 'system' }), call('inspect_windows', { server_id: windows.id, topic: 'disks' })), body => {
    assert(!body.tools.some(tool => tool.function.name === 'inspect_windows'))
    return done
  }], [windows.id]); await idle()
  assert.equal(windowsExecutions.length, 1)
  assert.equal(ai.state().messages.filter(message => message.error).length - activityCount, 1)
  await start([response(call('run_ssh', { server_id: windows.id, command: 'echo nope', reason: 'rdp' })), done], [windows.id]); await idle(); assert.equal(executions.length, 0)
  const previousRequests = requests.length
  await start([body => { assert(!JSON.stringify(body.messages).includes('AI 新备注')); return done }], [second.id], '新的范围'); await idle(); assert.equal(requests.length, previousRequests + 1)
  await start([(_body, reply) => { reply.writeHead(401); reply.end('secret provider body ' + apiKey); return false }], [first.id]); await idle()
  assert.match(errors(), /HTTP 401/); assert(!JSON.stringify(ai.state()).includes(apiKey))
  await start([response(call('run_ssh', { server_id: first.id, command: 'hang', reason: '测试执行中取消' }))]); await until(() => ai.state().pending, 'hang approval')
  ai.confirm(ai.state().pending.id, true); await until(() => executions.length, 'hang execution'); ai.cancel(); await idle(); executions = []
  vault.lock(); assert.throws(() => ai.send('locked', [first.id]), /解锁/); vault.unlock('Synthetic-local-vault')
  const shared = new SharedCredentialStore(directory)
  const backup = new ConfigurationBackupService(directory, connections, shared, vault, async () => true)
  const snapshot = { version: 1, connections: [], sharedCredentials: [], credentials: { 'omnidesk-ai-api-key': { secret: 'evil' } } }
  const encrypted = JSON.parse(await backup.create('QA-backup'))
  const backupKey = crypto.scryptSync('QA-backup', Buffer.from(encrypted.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
  const decrypt = crypto.createDecipheriv('aes-256-gcm', backupKey, Buffer.from(encrypted.iv, 'base64'))
  decrypt.setAAD(Buffer.from('OmniDesk encrypted configuration v1')); decrypt.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
  const actualSnapshot = JSON.parse(Buffer.concat([decrypt.update(Buffer.from(encrypted.data, 'base64')), decrypt.final()]))
  assert(!actualSnapshot.credentials['omnidesk-ai-api-key'])
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', backupKey, iv)
  cipher.setAAD(Buffer.from('OmniDesk encrypted configuration v1'))
  encrypted.data = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]).toString('base64')
  encrypted.tag = cipher.getAuthTag().toString('base64'); encrypted.iv = iv.toString('base64')
  await assert.rejects(backup.restore(JSON.stringify(encrypted), 'QA-backup'), /备份不能覆盖/)
  backupKey.fill(0)
  assert.equal(vault.getCredential('omnidesk-ai-api-key').secret, apiKey)
  ai.clear(); assert.equal(ai.state().messages.length, 0)
  console.log('PASS: explicit AI config, encrypted key persistence, real compatible HTTP fixture, metadata atomicity and credential preservation')
  console.log('PASS: scope and protocol boundaries, fixed read-only queries, per-command approval, replay, reject/retry, expiry, cancel and stale destination')
  console.log('PASS: private field projection, key/password redaction including JSON/partial PEM, bounded provider errors and model history reset')
  console.log('PASS: Windows-only tool exposure, Windows query scope/argument checks, and one-attempt management-channel failure handling')
  console.log('PASS: durable approval outcomes, general confirmation tool and validation, cancellation/timeout skip remaining operations, and independent SSH authorization')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { ai.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
