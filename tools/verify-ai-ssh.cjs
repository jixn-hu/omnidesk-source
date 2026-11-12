const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { Server } = require('ssh2')
fs.mkdirSync('tmp', { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/ai-ssh-qa-'))
require('esbuild').buildSync({ entryPoints: ['ai-ssh', 'ssh', 'connection-store', 'shared-credentials', 'vault'].map(name => `src/main/services/${name}.ts`), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const load = name => require(path.join(directory, name + '.js'))
const { executeAiSsh } = load('ai-ssh')
const { SshService } = load('ssh')
const { VaultService } = load('vault')
const { SharedCredentialStore } = load('shared-credentials')
const { ConnectionStore } = load('connection-store')
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const vault = new VaultService(directory)
vault.init('Synthetic-SSH-vault')
const password = 'QA-ssh-local-secret-84777'
vault.setCredential('qa-ssh', password)
const shared = new SharedCredentialStore(directory)
const credential = shared.save({ name: 'Synthetic shared credential', kind: 'password', username: 'effective-qa', credentialRef: 'qa-ssh' })
const connections = new ConnectionStore(directory)
const peers = new Set(), commands = [], authenticated = [], standardInputs = []
const server = new Server({ hostKeys: [key] }, client => {
  peers.add(client); client.on('close', () => peers.delete(client)); client.on('error', () => {})
  client.on('authentication', context => {
    if (context.method === 'password' && context.username === 'effective-qa' && context.password === password) { authenticated.push(context.username); context.accept() } else context.reject()
  })
  client.on('ready', () => client.on('session', accept => {
    const session = accept()
    session.on('exec', (accept, _reject, info) => {
      const stream = accept(); commands.push(info.command)
      if (info.command === "sudo -S -k -p '' -- true") {
        let input='';stream.on('data', bytes=>{input+=bytes.toString()});stream.on('end',()=>{standardInputs.push(input);stream.write('accepted\n');stream.exit(0);stream.end()});return
      }
      if (info.command === 'hang') return
      if (info.command === 'large') { stream.write('-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'x'.repeat(40000)); stream.exit(0); stream.end(); return }
      stream.write(`status=ok\nraw credential ${password}\n{"password":"not-known-secret"}\nAuthorization: Bearer synthetic-token\n`)
      stream.stderr.write('token=stderr-token\n')
      stream.exit(7); stream.end()
    })
  }))
})
let known = {}, ssh, untrusted
const resolve = connection => {
  const item = shared.get(connection.sharedCredentialId)
  return { ...vault.getCredential(item.credentialRef), username: item.username }
}
async function until(predicate) {
  const deadline = Date.now() + 8000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('SSH timeout'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
async function main() {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const connection = connections.save({ name: 'Synthetic Linux', kind: 'ssh', host: '127.0.0.1:' + server.address().port, port: 22, username: 'unused-user', authMethod: 'password', sharedCredentialId: credential.id })
  ssh = new SshService(resolve, () => known, value => { known = value })
  let prompts = 0
  ssh.on('hostKeyPrompt', prompt => { prompts++; ssh.resolveHostKey(prompt.sessionId, { accept: true, remember: true }) })
  const original = await ssh.connect(connection)
  const result = await executeAiSsh(ssh, vault, shared, { ...connection, vpn: { name: 'legacy VPN metadata' } }, 'synthetic-query', new AbortController().signal)
  assert.equal(result.code, 7); assert.match(result.stdout, /status=ok/)
  for (const secret of [password, 'not-known-secret', 'synthetic-token', 'stderr-token']) assert(!JSON.stringify(result).includes(secret), secret)
  assert.equal(prompts, 1); assert.deepEqual(authenticated, ['effective-qa', 'effective-qa'])
  assert.equal(ssh.list().filter(item => item.status === 'connected').length, 1)
  assert.equal(ssh.list().find(item => item.id === original.id).status, 'connected')
  const sudoResult = await ssh.exec(original.id, "sudo -S -k -p '' -- true", { stdin: 'qa-sudo-stdin-secret\n', timeoutMs: 3000 })
  assert.equal(sudoResult.code, 0); assert.equal(sudoResult.stdout, 'accepted\n')
  assert.deepEqual(standardInputs, ['qa-sudo-stdin-secret\n'])
  assert(!commands.some(command=>command.includes('qa-sudo-stdin-secret')))
  const beforeGuard = commands.length
  await assert.rejects(executeAiSsh(ssh, vault, shared, connection, 'guarded-command', new AbortController().signal, username => {
    assert.equal(username, 'effective-qa'); throw new Error('服务器登录账号已变化')
  }), /账号已变化/)
  assert.equal(commands.length, beforeGuard)
  const large = await executeAiSsh(ssh, vault, shared, connection, 'large', new AbortController().signal)
  assert.equal(large.truncated, true); assert(!large.stdout.includes('xxxxx')); assert.match(large.stdout, /私钥已隐藏/)
  const controller = new AbortController()
  const pending = executeAiSsh(ssh, vault, shared, connection, 'hang', controller.signal)
  await until(() => commands.includes('hang')); controller.abort(); await assert.rejects(pending)
  assert.equal(ssh.list().filter(item => item.status === 'connected').length, 1)
  assert.equal(ssh.list().find(item => item.id === original.id).status, 'connected')
  untrusted = new SshService(resolve, () => ({}), () => {})
  let prompt
  untrusted.on('hostKeyPrompt', value => { prompt = value })
  const rejectController = new AbortController(), before = commands.length
  const waiting = executeAiSsh(untrusted, vault, shared, connection, 'no-execution', rejectController.signal)
  await until(() => prompt); assert.equal(commands.length, before)
  rejectController.abort(); await assert.rejects(waiting); assert.equal(commands.length, before)
  vault.lock(); await assert.rejects(executeAiSsh(ssh, vault, shared, connection, 'locked', new AbortController().signal), /解锁/)
  console.log('PASS: real local SSH authentication with effective shared username, explicit host-key trust, exit status and credential/output redaction')
  console.log('PASS: independent AI sessions preserve open terminals; cancellation during execution/host-key approval, truncation, legacy metadata compatibility and locked Vault')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { ssh?.dispose(); untrusted?.dispose(); for (const client of peers) client.end(); await new Promise(resolve => server.close(resolve)) })
