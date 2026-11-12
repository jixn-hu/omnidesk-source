const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const { once } = require('node:events')
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(root, 'tmp/ai-history-qa-'))
require('esbuild').buildSync({ entryPoints: ['ai', 'connection-store', 'vault'].map(name => path.join(root, `src/main/services/${name}.ts`)), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const { AiService } = require(path.join(directory, 'ai.js')), { VaultService } = require(path.join(directory, 'vault.js')), { ConnectionStore } = require(path.join(directory, 'connection-store.js'))
const vault = new VaultService(directory); vault.init('QA-history-password')
const connections = new ConnectionStore(directory)
const connection = connections.save({ kind: 'ssh', name: 'QA history host', host: '192.0.2.10', port: 22, username: 'qa', authMethod: 'password' })
let requests = 0, executions = 0, ai, handler
const model = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  requests++; const body = JSON.parse(Buffer.concat(chunks)), message = handler(body)
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message }] }))
})
const options = { execute: async () => { executions++; throw new Error('must never execute') } }
const until = async predicate => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timeout'); await new Promise(resolve => setTimeout(resolve, 5)) } }
async function main() {
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  ai = new AiService(directory, connections, vault, options)
  ai.saveConfiguration({ baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'qa', permissionMode: 'edit' })
  handler = () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'pending-command', type: 'function', function: { name: 'run_ssh', arguments: JSON.stringify({ server_id: connection.id, command: 'echo pending', reason: 'QA pending confirmation' }) } }] })
  const id = ai.state().conversationId
  await ai.send('QA private task history', [connection.id]); await until(() => ai.state().pending)
  const pendingId = ai.state().pending.id
  ai.dispose()
  const filename = path.join(directory, 'ai-conversations.enc'), contents = fs.readFileSync(filename, 'utf8')
  for (const text of ['QA private task history', 'echo pending', 'QA history host']) assert(!contents.includes(text))
  assert.throws(() => vault.openLocalData(contents, 'wrong context'))
  vault.lock()
  ai = new AiService(directory, connections, vault, options)
  assert.equal(ai.state().messages.length, 0)
  vault.unlock('QA-history-password')
  const state = ai.state()
  assert.equal(state.conversationId, id); assert.equal(state.status, 'idle'); assert.equal(state.pending, null)
  assert.equal(state.conversations[0].interrupted, true)
  assert(state.messages.some(message => message.text === 'QA private task history'))
  assert.equal(state.messages.find(message => message.approval?.id === pendingId).approval.outcome, 'stopped')
  assert(state.messages.some(message => message.text.includes('上次任务因客户端退出而中断')))
  assert.equal(ai.confirm(pendingId, true, id), false); assert.equal(requests, 1); assert.equal(executions, 0)
  handler = body => {
    const interrupted = body.messages.find(message => message.tool_call_id === 'pending-command')
    assert(interrupted && JSON.parse(interrupted.content).interrupted)
    return { role: 'assistant', content: 'QA restored summary' }
  }
  await ai.send('仅整理已有信息', [connection.id], id); await until(() => ai.state().status === 'idle')
  assert.equal(ai.state().conversations[0].interrupted, false)
  assert.equal(executions, 0); ai.dispose()
  // A wrong vault or damaged ciphertext must not overwrite the original archive.
  const box = JSON.parse(fs.readFileSync(filename, 'utf8')); box.tag = Buffer.alloc(16).toString('base64')
  const damaged = JSON.stringify(box); fs.writeFileSync(filename, damaged)
  ai = new AiService(directory, connections, vault, options)
  assert.match(ai.state().storageError, /原文件已保留/)
  ai.createConversation(); ai.dispose()
  assert.equal(fs.readFileSync(filename, 'utf8'), damaged)
  console.log('PASS: encrypted durable conversations, lazy unlock, AEAD context authentication, interrupted task/approval recovery, valid resumed tool history, no automatic execution and corrupt archive preservation')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { ai?.dispose(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) })
