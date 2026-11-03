const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { WebSocketServer } = require('ws')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/native-transport-qa-'))
let application, page, server
const token = 'a'.repeat(32), session = randomUUID()
const errors = []
async function until(predicate, label) {
  const end = Date.now() + 10000
  while (!await predicate()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 25)) }
}
async function main() {
  const runtime = path.join(directory, 'runtime.cjs')
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/services/freerdp-runtime.ts')], outfile: runtime, bundle: true, platform: 'node', format: 'cjs' })
  const { nativeStartupError, checkNativeRuntime } = require(runtime)
  assert.match(nativeStartupError(-1073741515), /DLL.*0xC0000135/)
  assert.match(nativeStartupError(0xc000007b), /架构.*0xC000007B/)
  assert.match(nativeStartupError('EACCES'), /拒绝.*EACCES/)
  assert.match(nativeStartupError('ENOENT'), /不存在.*ENOENT/)
  assert.match(nativeStartupError(0xc000001d), /CPU.*0xC000001D/)
  await assert.rejects(checkNativeRuntime(directory), /不存在.*ENOENT/)
  server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info, done) => done(info.req.url === '/freerdp/' + session + '?token=' + token, 403) })
  await once(server, 'listening')
  const address = 'ws://127.0.0.1:' + server.address().port + '/freerdp/' + session + '?token=' + token
  const bytes = Buffer.alloc(1024 * 1024); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  server.on('connection', socket => { socket.on('message', (data, binary) => { assert(binary); assert.deepEqual([...data], [3, 1, 2, 3]); socket.send(bytes) }) })
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env: environment })
  page = await application.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await application.evaluate(async ({ BrowserWindow }) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session
    await session.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' })
    await session.closeAllConnections()
  })
  const oldResult = await page.evaluate(address => new Promise(resolve => {
    const socket = new WebSocket(address), timer = setTimeout(() => { socket.close(); resolve('timeout') }, 5000)
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open') }
    socket.onerror = () => { clearTimeout(timer); resolve('error') }
  }), address)
  assert.equal(oldResult, 'error', 'must reproduce the former Chromium loopback proxy failure')
  const result = await page.evaluate(address => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native socket timeout')), 5000)
    const socket = window.omnidesk.rdp.openNativeSocket(address, event => {
      if (event.kind === 'open') socket.send(new Uint8Array([3, 1, 2, 3]))
      if (event.kind === 'error') { clearTimeout(timer); reject(new Error(event.message)) }
      if (event.kind === 'data') {
        clearTimeout(timer)
        const bytes = event.data
        resolve({ typed: bytes instanceof Uint8Array, length: bytes.length, first: bytes[0], end: bytes[bytes.length - 1], valid: bytes.every((value, index) => value === index % 251) })
        socket.close()
      }
    })
  }), address)
  assert.deepEqual(result, { typed: true, length: bytes.length, first: 0, end: bytes.at(-1), valid: true })
  await until(() => !server.clients.size, 'closed native socket')
  const invalid = await page.evaluate(address => {
    const candidates = [address.replace('127.0.0.1', '192.0.2.1'), address.replace('ws:', 'wss:'), address + '&token=' + 'b'.repeat(32), address + '#hash', address.replace('/freerdp/', '/arbitrary/'), address.replace('127.0.0.1', 'user:secret@127.0.0.1'), address.replace('token=', 'arbitrary=')]
    return candidates.map(url => { try { window.omnidesk.rdp.openNativeSocket(url, () => {}); return false } catch { return true } })
  }, address)
  assert(invalid.every(Boolean), 'preload must reject remote/arbitrary/duplicate-token/authenticated URLs')
  const denied = await page.evaluate(address => new Promise(resolve => {
    const socket = window.omnidesk.rdp.openNativeSocket(address.replace('token=' + 'a'.repeat(32), 'token=' + 'b'.repeat(32)), event => {
      if (event.kind === 'error') { socket.close(); resolve(event.message) }
    })
  }), address)
  assert.match(denied, /握手失败/); assert(!denied.includes(token)); assert(!denied.includes('b'.repeat(32)))
  await page.evaluate(address => { window.qaSocket = window.omnidesk.rdp.openNativeSocket(address, () => {}) }, address)
  await until(() => server.clients.size === 1, 'reload test socket')
  await page.reload()
  await until(() => !server.clients.size, 'reload must close preload sockets')
  assert.deepEqual(errors, [])
  console.log('PASS former browser proxy failure reproduced; restricted preload connects directly, transfers exact 1MB binary frames, rejects unsafe URLs/tokens, cleans up on reload, and distinguishes native loader errors:', directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await application?.close(); if (server) { for (const socket of server.clients) socket.terminate(); server.close() } })
