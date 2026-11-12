const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { createServer } = require('node:http')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/ai-modes-qa-'))
require('esbuild').buildSync({ entryPoints: ['ai', 'connection-store', 'vault'].map(name => path.join(root, `src/main/services/${name}.ts`)), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const { AiService } = require(path.join(directory, 'ai.js'))
const { ConnectionStore } = require(path.join(directory, 'connection-store.js'))
const { VaultService } = require(path.join(directory, 'vault.js'))
const connections = new ConnectionStore(directory), vault = new VaultService(directory)
vault.init('QA-only-vault')
const connection = connections.save({ kind: 'ssh', name: 'QA Alpha', host: '192.0.2.10', port: 22, username: 'qa', authMethod: 'password', tags: ['original'] })
let calls = 0, executions = 0, serial = 0, handler, failures = []
const done = text => ({ role: 'assistant', content: text })
const tool = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'qa_call_' + ++serial, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const model = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); calls++
    const available = new Set()
    for (const message of body.messages) {
      for (const call of message.tool_calls ?? []) available.add(call.id)
      if (message.role === 'tool') assert(available.has(message.tool_call_id), 'orphaned tool result after history compaction')
    }
    const message = await handler(body)
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message }] }))
  } catch (error) { failures.push(error); response.writeHead(500); response.end('QA fixture failure') }
})
const ai = new AiService(directory, connections, vault, { approvalTimeoutMs: 5000, execute: async (_connection, _command, _signal, beforeExecute, id) => { beforeExecute('qa@192.0.2.10:22'); assert(id); executions++; return { stdout: 'QA status', stderr: '', code: 0, durationMs: 1, truncated: false } } })
const until = async (test, label) => { const end = Date.now() + 15000; while (!test()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 5)) } }
const summary = id => ai.state().conversations.find(item => item.id === id)
const idle = async id => { await until(() => summary(id)?.status === 'idle', 'idle ' + id); assert.deepEqual(failures, []) }
const mode = value => ai.setPermissionMode(value)
async function run(script, ids = [connection.id], text = 'QA task') {
  let index = 0; handler = body => { assert(index < script.length, 'unexpected model call'); const step = script[index++]; return typeof step === 'function' ? step(body) : step }
  const id = ai.state().conversationId; await ai.send(text, ids, id); await idle(id); assert.equal(index, script.length); return ai.state()
}
async function main() {
  assert.equal(ai.configuration().maxModelCalls, 200); assert.equal(ai.configuration().permissionMode, 'read')
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`
  const legacyDirectory = path.join(directory, 'legacy-settings'); fs.mkdirSync(legacyDirectory)
  fs.writeFileSync(path.join(legacyDirectory, 'ai-settings.json'), JSON.stringify({ baseUrl, model: 'legacy-model' }))
  const legacy = new AiService(legacyDirectory, connections, vault, { execute: async () => { throw new Error('unused') } })
  assert.equal(legacy.configuration().maxModelCalls, 200); assert.equal(legacy.configuration().permissionMode, 'read'); legacy.dispose()
  ai.saveConfiguration({ baseUrl, model: 'qa' })
  const saved = fs.readFileSync(path.join(directory, 'ai-settings.json'), 'utf8')
  for (const maxModelCalls of [0, -1, 1.5, 1001, '200', null]) assert.throws(() => ai.saveConfiguration({ baseUrl, model: 'qa', maxModelCalls }))
  for (const permissionMode of ['admin', '', null]) assert.throws(() => ai.saveConfiguration({ baseUrl, model: 'qa', permissionMode }))
  assert.equal(fs.readFileSync(path.join(directory, 'ai-settings.json'), 'utf8'), saved)
  // Complete the entire default 200-call budget and reserve request 200 for a summary.
  let used = 0
  handler = body => { used++; if (used === 200) { assert(!body.tools); assert.match(body.messages[0].content, /最后一次/); return done('QA 200 rounds summarized') } return tool('list_servers', {}) }
  const firstId = ai.state().conversationId
  await ai.send('QA full default budget', [connection.id]); await idle(firstId)
  assert.equal(used, 200); assert.equal(ai.state().modelCalls, 200)
  assert(ai.state().messages.some(item => item.text === 'QA 200 rounds summarized'))
  await run([done('QA next task after compaction')])
  ai.saveConfiguration({ baseUrl, model: 'qa', maxModelCalls: 3 })
  const restored = new AiService(directory, connections, vault, { execute: async () => { throw new Error('unused') } })
  assert.equal(restored.configuration().maxModelCalls, 3); restored.dispose()
  // A provider that ignores the no-tools final request must not cause additional operations.
  let limitCalls = 0; handler = () => { limitCalls++; return tool('inspect_linux', { server_id: connection.id, topic: 'system' }) }
  const before = executions; await ai.send('QA capped task', [connection.id]); await idle(firstId)
  assert.equal(limitCalls, 3); assert.equal(executions - before, 2); assert.match(ai.state().messages.at(-1).text, /3 次/)
  ai.saveConfiguration({ baseUrl, model: 'qa', maxModelCalls: 200 })
  async function decision(script, kind, approve, check = () => {}) {
    let index = 0
    handler = body => { assert(index < script.length); const step = script[index++]; return typeof step === 'function' ? step(body) : step }
    await ai.send('QA scoped confirmation', [connection.id])
    await until(() => ai.state().pending?.kind === kind, kind + ' confirmation')
    const pending = ai.state().pending
    assert.equal(ai.state().permissionMode, 'read')
    check(pending)
    assert.equal(ai.confirm(pending.id, approve), true)
    await idle(firstId)
    assert.equal(ai.confirm(pending.id, true), false, 'confirmation is single use')
    assert.equal(ai.state().permissionMode, 'read', 'approval must not elevate conversation mode')
    assert.equal(index, script.length)
  }
  const current = connections.get(connection.id)
  const update = { server_ids: [connection.id], changes: { tags: { mode: 'add', values: ['confirmed'] } } }
  await decision([body => {
    const names = body.tools.map(item => item.function.name)
    for (const name of ['update_metadata', 'create_server', 'delete_server', 'run_ssh']) assert(names.includes(name), name + ' remains available to propose')
    return tool('update_metadata', update)
  }, done('Read mode declined mutation')], 'edit', false, pending => {
    assert.deepEqual(connections.get(connection.id), current, 'no write before confirmation')
    assert.match(pending.message, /QA Alpha/); assert.match(pending.message, /original → original、confirmed/)
  })
  assert.deepEqual(connections.get(connection.id), current)
  await decision([tool('update_metadata', update), done('Read mode confirmed mutation')], 'edit', true)
  assert.deepEqual(connections.get(connection.id).tags, ['original', 'confirmed'])
  const modified = connections.get(connection.id)
  await decision([tool('update_metadata', { server_ids: [connection.id], changes: { note: { mode: 'replace', value: 'AI pending write' } } }), done('Concurrent edit preserved')], 'edit', true, () => {
    connections.batchMetadata({ items: [{ id: connection.id, updatedAt: modified.updatedAt }], changes: { note: { mode: 'replace', value: 'external change while pending' } } })
  })
  assert.equal(connections.get(connection.id).note, 'external change while pending')
  assert(ai.state().messages.some(message => message.error && /其他操作修改/.test(message.text)))
  const addition = { kind: 'ssh', name: 'QA approved creation', host: '192.0.2.11', port: 22, username: 'qa' }
  await decision([tool('create_server', addition), done('Cancelled creation')], 'edit', false)
  assert.equal(connections.list().length, 1)
  await decision([tool('create_server', addition), done('Confirmed creation')], 'edit', true, () => assert.equal(connections.list().length, 1))
  const approvedCreation = connections.list().find(item => item.name === addition.name)
  assert(approvedCreation); assert(!approvedCreation.credentialRef)
  let beforeCommand = executions
  await decision([tool('run_ssh', { server_id: connection.id, command: 'echo QA', reason: 'Read mode explicit approval' }), done('Cancelled command')], 'ssh', false, () => assert.equal(executions, beforeCommand))
  assert.equal(executions, beforeCommand)
  await decision([tool('run_ssh', { server_id: connection.id, command: 'echo QA', reason: 'Read mode explicit approval' }), done('Approved command')], 'ssh', true)
  assert.equal(executions, beforeCommand + 1)
  await decision([tool('delete_server', { server_id: connection.id }), done('Cancelled deletion')], 'delete', false)
  assert(connections.get(connection.id))
  mode('edit')
  await run([body => {
    const names = body.tools.map(item => item.function.name)
    assert(names.includes('run_ssh') && names.includes('delete_server'))
    return tool('update_metadata', { server_ids: [connection.id], changes: { tags: { mode: 'add', values: ['edited'] } } })
  }, done('edited automatically')])
  assert.deepEqual(connections.get(connection.id).tags, ['original', 'confirmed', 'edited'])
  await run([tool('create_server', { kind: 'rdp', name: 'QA created', host: '192.0.2.30', port: 3389, username: 'qa', tags: ['new'], note: 'new only' }), done('created')], [])
  const created = connections.list().find(item => item.name === 'QA created'); assert(created); assert(!created.credentialRef)
  await run([tool('create_server', { kind: 'rdp', name: 'duplicate', host: '192.0.2.30', port: 3389, username: 'qa' }), done('duplicate denied')], [])
  assert.equal(connections.list().length, 3)
  let step = 0; handler = () => step++ === 0 ? tool('delete_server', { server_id: created.id }) : done('delete result')
  await ai.send('QA delete', [created.id]); await until(() => ai.state().pending?.kind === 'delete', 'edit mode delete approval')
  assert(connections.get(created.id)); ai.confirm(ai.state().pending.id, false); await idle(firstId); assert(connections.get(created.id))
  step = 0; await ai.send('QA confirmed delete', [created.id]); await until(() => ai.state().pending?.kind === 'delete', 'edit mode delete approval 2')
  ai.confirm(ai.state().pending.id, true); await idle(firstId); assert.equal(connections.get(created.id), null)
  beforeCommand = executions
  step = 0; handler = () => step++ === 0 ? tool('run_ssh', { server_id: connection.id, command: 'echo edit', reason: 'edit requires approval' }) : done('edit command approved')
  await ai.send('QA edit SSH', [connection.id]); await until(() => ai.state().pending?.kind === 'ssh', 'edit command approval')
  assert.equal(executions, beforeCommand); ai.confirm(ai.state().pending.id, true); await idle(firstId)
  assert.equal(executions, beforeCommand + 1)
  mode('full')
  beforeCommand = executions
  await run([tool('run_ssh', { server_id: connection.id, command: 'echo full', reason: 'full automatic execution' }), done('full executed')])
  assert.equal(executions, beforeCommand + 1); assert.equal(ai.state().pending, null)
  await run([tool('delete_server', { server_id: approvedCreation.id }), done('full deleted automatically')], [approvedCreation.id])
  assert.equal(connections.get(approvedCreation.id), null)
  // Concurrent requests continue across conversation selection, with independently visible results.
  const releases = new Map()
  handler = body => new Promise(resolve => releases.set(body.messages.filter(item => item.role === 'user').at(-1).content, resolve))
  await ai.send('QA background A', [connection.id], firstId)
  const secondId = ai.createConversation().conversationId
  assert.equal(ai.state().permissionMode, 'read')
  await ai.send('QA background B', [connection.id], secondId)
  await until(() => releases.size === 2, 'two simultaneous requests')
  assert.equal(summary(firstId).status, 'running'); assert.equal(summary(secondId).status, 'running')
  assert.throws(() => ai.deleteConversation(firstId), /先完成/)
  assert.throws(() => ai.saveConfiguration({ baseUrl, model: 'qa' }), /所有对话/)
  releases.get('QA background A')(done('QA A complete'))
  await idle(firstId); assert.equal(summary(firstId).unread, true); assert(!ai.state().messages.some(item => item.text === 'QA A complete'))
  ai.selectConversation(firstId); assert.equal(summary(firstId).unread, false); assert(ai.state().messages.some(item => item.text === 'QA A complete'))
  releases.get('QA background B')(done('QA B complete')); await idle(secondId)
  assert.equal(summary(secondId).unread, true)
  ai.selectConversation(secondId); assert(ai.state().messages.some(item => item.text === 'QA B complete')); assert(!ai.state().messages.some(item => item.text === 'QA A complete'))
  // Approval IDs cannot authorize another conversation, and cancel affects only its named task.
  ai.selectConversation(firstId); mode('read'); step = 0
  handler = () => step++ === 0 ? tool('run_ssh', { server_id: connection.id, command: 'echo QA', reason: 'QA approval' }) : done('QA command done')
  await ai.send('QA approve A', [connection.id]); await until(() => ai.state().pending?.kind === 'ssh', 'A command approval')
  const approval = ai.state().pending.id
  ai.selectConversation(secondId)
  assert.equal(ai.confirm(approval, true, secondId), false)
  assert.equal(ai.cancel(secondId), false); assert.equal(summary(firstId).status, 'approval')
  assert.equal(ai.confirm(approval, true, firstId), true); await idle(firstId)
  assert.equal(ai.confirm(approval, true, firstId), false)
  handler = () => new Promise(() => {})
  await ai.send('QA cancel B', [connection.id], secondId); await ai.send('QA cancel A', [connection.id], firstId)
  ai.cancel(secondId); await idle(secondId); assert.equal(summary(firstId).status, 'running')
  ai.cancelAll(); await idle(firstId)
  const count = ai.state().conversations.length
  ai.deleteConversation(firstId); assert.equal(ai.state().conversations.length, count - 1)
  assert.throws(() => ai.selectConversation(firstId), /不存在/)
  await assert.rejects(() => ai.send('stale', [connection.id], firstId), /不存在/)
  console.log('PASS: default 200 requests, persisted validated settings, reserved summary, strict cap and valid compacted tool history')
  console.log('PASS: read/edit/full automatic execution scopes, explicit approvals without elevation, rejection, replay, concurrent edit protection, creation without credentials and duplicate prevention')
  console.log('PASS: concurrent background chats, isolated histories/modes, unread badges, cross-chat approval rejection, targeted cancellation, cancel-all and deletion')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { ai.dispose(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) })
