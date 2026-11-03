const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const cp = require('node:child_process')
const net = require('node:net')
fs.mkdirSync('tmp', { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/ai-windows-qa-'))
require('esbuild').buildSync({ entryPoints: ['ai-windows', 'ai-tools', 'vault', 'connection-store', 'shared-credentials'].map(name => `src/main/services/${name}.ts`), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
const load = name => require(path.join(directory, name + '.js'))
const { inspectAiWindows, windowsInspectionScript, windowsUsername } = load('ai-windows')
const { windowsQueries } = load('ai-tools')
const { VaultService } = load('vault')
const { ConnectionStore } = load('connection-store')
const { SharedCredentialStore } = load('shared-credentials')
const vault = new VaultService(directory); vault.init('QA-local-master-password')
const password = 'QA-private-Windows-秘密-123', shared = new SharedCredentialStore(directory)
vault.setCredential('qa-domain-ref', password)
const credential = shared.save({ name: 'QA domain account', kind: 'password', username: 'effective-admin', domain: 'QA-DOMAIN', credentialRef: 'qa-domain-ref' })
const store = new ConnectionStore(directory)
const connection = store.save({ kind: 'rdp', name: 'QA Windows', host: '192.0.2.10:3399', port: 3389, username: 'unused', sharedCredentialId: credential.id })
const originalSpawn = cp.spawn, originalConnect = net.createConnection
let mode = 'success', networkMode = 'success', helper, socket, spawned = [], rpc = [], payloads = [], wire = []
let lockedDuringProbe = false
const guard = username => assert.equal(username, 'QA-DOMAIN\\effective-admin')
const inspect = (topic = 'system', signal = new AbortController().signal, input = connection, before = guard, vpn = {}) => inspectAiWindows(vault, shared, vpn, input, topic, signal, before)
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('fixture timeout'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function main() {
  assert.equal(windowsUsername('admin', 'DOMAIN'), 'DOMAIN\\admin')
  assert.equal(windowsUsername('OTHER\\admin', 'DOMAIN'), 'OTHER\\admin')
  assert.equal(windowsUsername('admin@example.test', 'DOMAIN'), 'admin@example.test')
  net.createConnection = options => {
    rpc.push(options)
    socket = new EventEmitter(); socket.destroyed = false
    socket.setTimeout = () => socket; socket.destroy = () => { socket.destroyed = true }
    setImmediate(() => {
      if (networkMode === 'timeout') socket.emit('timeout')
      else if (networkMode === 'error') socket.emit('error', new Error('ECONNREFUSED'))
      else if (networkMode === 'success') { if (lockedDuringProbe) vault.lock(); socket.emit('connect') }
    })
    return socket
  }
  cp.spawn = (executable, args, options) => {
    spawned.push({ executable, args, options })
    helper = new EventEmitter(); helper.stdin = new PassThrough(); helper.stdout = new PassThrough(); helper.stderr = new PassThrough()
    helper.killed = false; helper.kill = () => { helper.killed = true }
    let input = ''
    helper.stdin.on('data', bytes => { input += bytes.toString() })
    const current = helper
    helper.stdin.on('end', () => {
      const request = JSON.parse(input); payloads.push(request)
      let result = { ok: true, stdout: `中文 Windows 状态\nraw credential ${password}\npassword=unseen-secret\nBearer unseen-token`, truncated: false }
      if (mode === 'hang') return
      if (mode === 'failure') result = { ok: false, stage: 'connect', message: 'raw ' + password, hresult: '80070005' }
      if (mode === 'redaction') result = { ok: false, stage: 'query', message: 'raw ' + password, hresult: 'other' }
      if (mode === 'truncated') result.truncated = true
      const json = mode === 'invalid' ? 'not-json' : mode === 'large' ? 'x'.repeat(300000) : JSON.stringify(result)
      setImmediate(() => {
        current.stderr.write('diagnostic ' + password)
        current.stdout.write(Buffer.from(json).subarray(0, 13)); current.stdout.end(Buffer.from(json).subarray(13))
        current.emit('close', 0)
      })
    })
    return current
  }
  const result = await inspect()
  assert.equal(result.code, 0); assert.match(result.stdout, /中文 Windows/)
  for (const secret of [password, 'unseen-secret', 'unseen-token']) assert(!JSON.stringify(result).includes(secret))
  assert.deepEqual(rpc.pop(), { host: '192.0.2.10', port: 135 })
  assert.equal(payloads[0].host, '192.0.2.10'); assert.equal(payloads[0].username, 'QA-DOMAIN\\effective-admin'); assert.equal(payloads[0].password, password)
  assert(spawned[0].options.windowsHide)
  const commandline = JSON.stringify(spawned[0]); assert(!commandline.includes(password) && !commandline.includes('192.0.2.10'))
  const script = Buffer.from(spawned[0].args.at(-1), 'base64').toString('utf16le')
  assert.equal(script, windowsInspectionScript); assert.match(script, /-PacketPrivacy/)
  assert(!/CommandLine|PathName|Invoke-Expression|Invoke-Command|Win32_Process.*Create/.test(script))
  const beforeInvalid = spawned.length
  await assert.rejects(inspect('system;Remove-Item'), /受支持/)
  await assert.rejects(inspect('system', new AbortController().signal, { ...connection, proxy: { type: 'socks5' } }), /不支持.*代理/)
  await assert.rejects(inspect('system', new AbortController().signal, { ...connection, vpn: { name: 'QA VPN' } }, guard, { isConnected: async () => false }), /请先连接/)
  await assert.rejects(inspect('system', new AbortController().signal, connection, () => { throw new Error('目标已变化') }), /目标已变化/)
  assert.equal(spawned.length, beforeInvalid)
  const canceled = new AbortController(); canceled.abort(); await assert.rejects(inspect('system', canceled.signal))
  networkMode = 'timeout'; await assert.rejects(inspect(), error => error.windowsUnavailable && /135.*超时/.test(error.message))
  networkMode = 'error'; await assert.rejects(inspect(), error => error.windowsUnavailable && /无法连接/.test(error.message))
  networkMode = 'hang'; const waiting = new AbortController(); const pendingProbe = inspect('system', waiting.signal)
  waiting.abort(); await assert.rejects(pendingProbe, /取消/); assert(socket.destroyed)
  networkMode = 'success'; lockedDuringProbe = true; await assert.rejects(inspect(), /解锁/); vault.unlock('QA-local-master-password'); lockedDuringProbe = false
  mode = 'failure'; await assert.rejects(inspect(), error => error.windowsUnavailable && /远程 WMI 权限/.test(error.message) && !error.message.includes(password))
  mode = 'redaction'; await assert.rejects(inspect(), error => !error.message.includes(password) && /已隐藏/.test(error.message))
  mode = 'invalid'; await assert.rejects(inspect(), /有效查询结果/)
  mode = 'large'; await assert.rejects(inspect(), /超过限制/)
  mode = 'truncated'; assert.equal((await inspect()).truncated, true)
  mode = 'hang'; const running = new AbortController(), started = spawned.length; const pending = inspect('system', running.signal)
  await until(() => spawned.length > started); running.abort(); await assert.rejects(pending, /取消/); assert(helper.killed)
  vault.lock(); await assert.rejects(inspect(), /解锁/); vault.unlock('QA-local-master-password')
  cp.spawn = originalSpawn; net.createConnection = originalConnect
  console.log('PASS Windows adapter: effective shared domain identity, host/port normalization, protected stdin, no secrets in args/output, RPC/VPN/proxy/vault guards, query validation, cancellation, errors and output bounds')

  // The remote session is substituted, while every fixed CIM query runs against real local Windows classes.
  const prelude = `
function New-CimSession { [pscustomobject]@{ Name='QA-local-query-fixture' } }
function Remove-CimSession { param($CimSession,$ErrorAction) }
function Get-CimInstance {
  param([Parameter(Position=0)]$ClassName,$CimSession,$Filter)
  if ($Filter) { CimCmdlets\\Get-CimInstance -ClassName $ClassName -Filter $Filter }
  else { CimCmdlets\\Get-CimInstance -ClassName $ClassName }
}
`
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  for (const topic of Object.keys(windowsQueries)) {
    console.log('Checking local CIM topic:', topic)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
    environment.PSModulePath = path.join(path.dirname(powershell), 'Modules')
    const child = cp.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prelude + windowsInspectionScript, 'utf16le').toString('base64')], { input: JSON.stringify({ host: 'localhost', username: 'qa', password: 'QA-local-only', topic }), encoding: 'utf8', env: environment, windowsHide: true, timeout: 25000, maxBuffer: 256000 })
    assert.equal(child.status, 0, topic + ': ' + (child.error?.message || '') + child.stderr)
    const response = JSON.parse(child.stdout)
    assert.equal(response.ok, true, JSON.stringify(response))
    const data = JSON.parse(response.stdout)
    assert(Array.isArray(data) && data.length, topic)
    wire.push({ topic, rows: data.length, fields: Object.keys(data[0]) })
  }
  fs.writeFileSync(path.join(directory, 'local-cim-results.json'), JSON.stringify(wire, null, 2))
  console.log('PASS all six fixed queries with real local Windows CIM data; full PowerShell script parsing, JSON output and remote-session cleanup path (remote authentication was mocked)')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { cp.spawn = originalSpawn; net.createConnection = originalConnect })
