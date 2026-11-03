const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { once } = require('node:events')
const { spawn, execFileSync } = require('node:child_process')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/rdp-auto-compat-qa-'))
const sdk = path.join(root, 'tmp/freerdp-sdk')
const msys = process.env.OMNIDESK_MSYS2 || 'C:/msys64/ucrt64'
const libraries = process.env.OMNIDESK_QA_FREERDP_DIR || path.join(root, 'out/native-freerdp')
const environment = { ...process.env, PATH: `${libraries};${msys}/bin;${process.env.PATH}`, OPENSSL_MODULES: libraries, WLOG_LEVEL: 'OFF' }
const children = []
const bridges = []
const sockets = new Set()
let application
async function until(predicate, label) {
  const deadline = Date.now() + 20000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
async function startPeer(legacy) {
  const child = spawn(path.join(directory, 'test-peer.exe'), [path.join(directory, 'cert.pem'), path.join(directory, 'key.pem'), legacy ? '1' : '2', path.join(directory, 'sam')], { env: environment, windowsHide: true })
  children.push(child)
  child.lines = ''
  child.stdout.on('data', chunk => { child.lines += chunk.toString() })
  child.stderr.resume()
  await until(() => /port \d+/.test(child.lines), 'peer listener')
  return { child, port: Number(/port (\d+)/.exec(child.lines)[1]) }
}
async function bridge(mode) {
  const stats = { secure: 0, legacy: 0, peers: [] }
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let request = Buffer.alloc(0)
    const handshake = chunk => {
      request = Buffer.concat([request, chunk])
      if (request.length < 4 || request.length < request.readUInt16BE(2)) return
      socket.off('data', handshake)
      socket.pause()
      const offset = request.readUInt16BE(2) - 8
      const protocol = offset >= 11 && request[offset] === 1 ? request.readUInt32LE(offset + 4) : 0
      if (protocol) stats.secure++; else stats.legacy++
      const probe = request.equals(Buffer.from('030000130ee00000000000010008000b000000', 'hex'))
      if (mode === 'cert-fail' || (['legacy', 'delayed-legacy', 'tls-legacy', 'probe-error', 'modern-tls-fail'].includes(mode) && protocol)) {
        const response = Buffer.from('030000130ed000001234000300080002000000', 'hex')
        if (mode === 'cert-fail') response.writeUInt32LE(3, 15)
        if (['tls-legacy', 'probe-error', 'modern-tls-fail'].includes(mode) && !probe) response.writeUInt32LE(3, 15)
        if (mode === 'probe-error' && probe) response[4] = 0
        if (mode === 'modern-tls-fail' && probe) { response[11] = 2; response.writeUInt32LE(1, 15) }
        if (mode === 'delayed-legacy') setTimeout(() => { if (!socket.destroyed) socket.end(response) }, 900)
        else socket.end(response)
        return
      }
      void startPeer(['legacy', 'delayed-legacy', 'tls-legacy'].includes(mode)).then(({ child, port }) => {
        stats.peers.push(child)
        if (socket.destroyed) { child.kill(); return }
        const upstream = net.connect(port, '127.0.0.1')
        sockets.add(upstream)
        upstream.on('close', () => { sockets.delete(upstream); socket.destroy() })
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
        upstream.once('connect', () => { upstream.write(request); socket.pipe(upstream).pipe(socket); socket.resume() })
      }).catch(error => { console.error(error); socket.destroy() })
    }
    socket.on('data', handshake)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  bridges.push(server)
  return { port: server.address().port, stats }
}
async function main() {
  execFileSync(path.join(msys, 'bin/openssl.exe'), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { env: environment, windowsHide: true, stdio: 'ignore' })
  const hash = execFileSync(path.join(msys, 'bin/openssl.exe'), ['dgst', '-md4', '-provider', 'legacy', '-binary'], { input: Buffer.from('synthetic-not-a-real-password', 'utf16le'), env: environment, windowsHide: true }).toString('hex')
  fs.writeFileSync(path.join(directory, 'sam'), `qa-local-only:::${hash}:\n`)
  execFileSync(path.join(msys, 'bin/gcc.exe'), ['native/freerdp/test-peer.c', `-I${sdk}/include/freerdp3`, `-I${sdk}/include/winpr3`, `-L${sdk}/lib`, '-lfreerdp3', '-lwinpr3', '-lws2_32', '-D__STDC_NO_THREADS__', '-Wno-deprecated-declarations', '-o', path.join(directory, 'test-peer.exe')], { env: environment, windowsHide: true, stdio: 'inherit' })
  const legacy = await bridge('legacy')
  const secure = await bridge('tls')
  const wrong = await bridge('tls')
  const certificate = await bridge('cert-fail')
  const tlsLegacy = await bridge('tls-legacy')
  const background = await bridge('delayed-legacy')
  const probeError = await bridge('probe-error')
  const modernTlsFail = await bridge('modern-tls-fail')
  const secondaryLegacy = await bridge('tls-legacy')
  const appEnvironment = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }
  delete appEnvironment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env: appEnvironment })
  const page = await application.firstWindow()
  if (process.env.OMNIDESK_QA_BLOCK_BROWSER_LOOPBACK === '1') {
    await application.evaluate(async ({ BrowserWindow }) => {
      const session = BrowserWindow.getAllWindows()[0].webContents.session
      await session.setProxy({ mode: 'fixed_servers', proxyRules: '127.0.0.1:9', proxyBypassRules: '<-loopback>' })
      await session.closeAllConnections()
    })
    console.log('QA: Chromium loopback traffic deliberately blocked by a failing proxy')
  }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(25000)
  await application.evaluate(({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width: 1360, height: 900 })
    window.focus()
    globalThis.qaDialogs = []
    globalThis.qaAccept = false
    dialog.showMessageBox = async (...args) => { const options = args.at(-1); globalThis.qaDialogs.push({ title: options.title, message: options.message, detail: options.detail, owner: args[0]?.id }); return { response: globalThis.qaAccept ? 1 : 0 } }
  })
  await page.getByRole('button', { name: /暂不设置/ }).click()
  const records = []
  for (const [name, target, password] of [['QA Legacy', legacy, 'synthetic-not-a-real-password'], ['QA TLS', secure, 'synthetic-not-a-real-password'], ['QA Wrong password', wrong, 'synthetic-wrong-password'], ['QA Missing cert', certificate, 'synthetic-not-a-real-password'], ['QA TLS legacy', tlsLegacy, 'synthetic-not-a-real-password'], ['QA Background legacy', background, 'synthetic-not-a-real-password'], ['QA Probe error', probeError, 'synthetic-not-a-real-password'], ['QA Modern TLS error', modernTlsFail, 'synthetic-not-a-real-password'], ['QA Secondary legacy', secondaryLegacy, 'synthetic-not-a-real-password']]) {
    const saved = await page.evaluate(async ({ name, port, password }) => window.omnidesk.connections.save({ kind: 'rdp', name, host: '127.0.0.1', port, username: 'qa-local-only', options: { engine: 'ironrdp', securityMode: 'auto', ignoreCertificate: true, enableClipboard: false, dynamicResolution: name === 'QA TLS' } }, { secret: password }), { name, port: target.port, password })
    assert(saved.ok, saved.message)
    records.push(saved.data)
  }
  await page.reload()
  const open = async name => {
    await page.getByRole('button', { name: /^服务器管理/ }).first().click()
    await page.getByRole('button', { name, exact: true }).click()
  }
  const dialogs = () => application.evaluate(() => globalThis.qaDialogs)
  const record = async index => (await page.evaluate(() => window.omnidesk.connections.list())).data.find(item => item.id === records[index].id)
  await open('QA Legacy')
  await page.getByText('无法建立远程桌面', { exact: true }).waitFor()
  assert.equal((await dialogs()).length, 1)
  assert.match((await dialogs())[0].message, /仅接受旧版/)
  assert.equal((await record(0)).options.securityMode, 'auto')
  assert.equal(legacy.stats.legacy, 0)
  assert.equal(legacy.stats.peers.length, 0)
  console.log('PASS actual Electron/native TLS-first failure: cancel preserves configuration and never opens a legacy session or sends legacy login credentials')
  await application.evaluate(() => { globalThis.qaAccept = true })
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await page.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
  assert.equal((await dialogs()).length, 2)
  const saved = await record(0)
  assert.equal(saved.options.engine, 'freerdp')
  assert.equal(saved.options.securityMode, 'legacy')
  assert.equal(saved.credentialRef, records[0].credentialRef)
  assert.equal(saved.options.ignoreCertificate, true)
  await page.getByText('旧版安全层', { exact: true }).waitFor()
  assert(legacy.stats.peers.some(child => child.lines.includes('activated')))
  await page.screenshot({ path: path.join(directory, 'legacy-confirmed.png') })
  await page.getByRole('button', { name: '关闭标签 QA Legacy', exact: true }).click()
  await open('QA Legacy')
  await page.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
  assert.equal((await dialogs()).length, 2)
  console.log('PASS consent saves only this server, automatically reconnects into a real Standard RDP Security desktop, preserves credentials, and reconnects without another prompt')
  await open('QA TLS')
  await page.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
  assert.equal((await record(1)).options.securityMode, 'auto')
  assert.equal(secure.stats.legacy, 0)
  assert.equal((await dialogs()).length, 2)
  assert(secure.stats.peers.some(child => child.lines.includes('activated')))
  console.log('PASS old IronRDP configuration now uses FreeRDP on Windows; modern server authenticates with TLS/NLA without a downgrade or prompt')
  const geometry = () => page.evaluate(() => ['.workspace-header', '.tabbar', '.content-area', '.sidebar'].map(selector => {
    const bounds = document.querySelector(selector).getBoundingClientRect()
    return [bounds.x, bounds.y, bounds.width, bounds.height].map(value => Math.round(value * 10) / 10)
  }))
  const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  const peerCount = secure.stats.peers.length
  const connectedPeer = secure.stats.peers.find(child => child.lines.includes('activated'))
  await until(() => connectedPeer.lines.includes('display-ready'), 'display channel ready')
  const canvas = page.locator('.desktop-workspace:visible canvas')
  await canvas.click()
  const canvasBounds = await canvas.boundingBox()
  const position = { x: canvasBounds.x + canvasBounds.width / 2, y: canvasBounds.y + canvasBounds.height / 2 }
  const protocol = await page.context().newCDPSession(page)
  const originalLocation = page.url()
  for (const [button, mask] of [['back', 8], ['forward', 16]]) {
    await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button, buttons: mask, clickCount: 1 })
    await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button, buttons: 0, clickCount: 1 })
  }
  await page.mouse.move(position.x, position.y)
  await page.mouse.wheel(100, 0)
  await page.mouse.wheel(0, 100)
  for (const shortcut of ['Control+Shift+n', 'Control+Shift+k']) await page.keyboard.press(shortcut)
  await until(() => ['mousex 32769', 'mousex 1', 'mousex 32770', 'mousex 2', 'mouse 1144', 'mouse 904', 'key 0 49', 'key 32768 49', 'key 0 37', 'key 32768 37'].every(prefix => connectedPeer.lines.split('\n').some(line => line.startsWith(prefix + ' ') || line.trim() === prefix)), 'actual DesktopView side buttons, both scroll axes and Ctrl+Shift shortcuts reach the real RDP peer')
  assert.equal(page.url(), originalLocation)
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.locator('.desktop-workspace:visible').count(), 1)
  assert.equal(await page.locator('textarea.desktop-keyboard-input:focus').count(), 1)
  const releaseCount = (connectedPeer.lines.match(/^mousex 2 /gm) || []).length
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'forward', buttons: 16, clickCount: 1 })
  await page.keyboard.down('Control')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await until(() => (connectedPeer.lines.match(/^mousex 2 /gm) || []).length > releaseCount, 'actual blur releases a held side button')
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'forward', buttons: 0, clickCount: 1 })
  await page.keyboard.up('Control')
  assert.equal(secure.stats.peers.length, peerCount)
  console.log('PASS actual DesktopView → FreeRDP → peer: back/forward, horizontal/vertical wheel, Ctrl+Shift shortcuts and held-side-button blur release; no local navigation, dialogs, focus theft or reconnect')
  for (const scale of ['110', '125', '100']) {
    const initial = await geometry()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    if (await page.locator('[data-settings-section="appearance"]').getAttribute('open') === null) await page.locator('[data-settings-section="appearance"] > summary').click()
    await page.getByRole('region', { name: '外观与字体设置' }).waitFor()
    assert.deepEqual(await geometry(), initial)
    const layouts = (connectedPeer.lines.match(/^layout /gm) || []).length
    await page.getByLabel('界面缩放', { exact: true }).selectOption(scale)
    await page.getByRole('button', { name: scale === '125' ? '浅色' : '深色', exact: true }).click()
    const scaled = await geometry()
    await page.locator('.tab').filter({ hasText: 'QA TLS' }).click()
    await page.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
    assert.deepEqual(await geometry(), scaled)
    await until(() => (connectedPeer.lines.match(/^layout /gm) || []).length > layouts, 'display resize after appearance zoom')
    assert.equal(secure.stats.peers.length, peerCount)
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), bounds)
  }
  console.log('PASS live native RDP keeps the same header/tabs/content geometry as settings; 110/125/100% zoom and theme changes resize through Display Control without reconnecting or resizing the window')
  for (const [name, index, target] of [['QA Wrong password', 2, wrong], ['QA Missing cert', 3, certificate]]) {
    await open(name)
    await page.locator('.desktop-workspace:visible').getByText('无法建立远程桌面', { exact: true }).waitFor()
    assert.equal((await record(index)).options.securityMode, 'auto')
    assert.equal(target.stats.legacy, 0)
    assert.equal((await dialogs()).length, 2)
  }
  assert.deepEqual(errors, [])
  console.log('PASS real NLA password rejection and missing-server-certificate failure never prompt, downgrade or modify the server security configuration; no renderer errors')
  await open('QA TLS legacy')
  await page.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
  assert.equal((await dialogs()).length, 3)
  assert.equal((await record(4)).options.securityMode, 'legacy')
  assert(tlsLegacy.stats.legacy > 0)
  console.log('PASS actual native TLS_CONNECT_FAILED now performs a credential-free probe and reconnects with legacy security only after explicit consent')
  await open('QA Background legacy')
  await page.getByRole('button', { name: /^服务器管理/ }).first().click()
  await until(() => background.stats.secure > 0, 'background native negotiation')
  await page.waitForTimeout(1600)
  assert.equal((await dialogs()).length, 3)
  assert.equal(background.stats.legacy, 0)
  await page.getByRole('button', { name: '关闭标签 QA Background legacy', exact: true }).click()
  const closedRequests = background.stats.secure
  await page.waitForTimeout(200)
  assert.equal(background.stats.secure, closedRequests)
  assert.equal((await dialogs()).length, 3)
  await open('QA Background legacy')
  await page.getByRole('button', { name: /^服务器管理/ }).first().click()
  await until(() => background.stats.secure > closedRequests, 'reopened background native negotiation')
  await page.waitForTimeout(1600)
  assert.equal((await dialogs()).length, 3)
  await page.locator('.tab').filter({ hasText: 'QA Background legacy' }).click()
  await page.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
  assert.equal((await dialogs()).length, 4)
  assert.equal((await record(5)).options.securityMode, 'legacy')
  console.log('PASS failed background tab defers consent until selected, cancels safely when closed, and detects/reconnects after reopening rather than silently losing the fallback')
  for (const [name, index, target, expected] of [['QA Probe error', 6, probeError, '兼容检测未确认旧版兼容需求'], ['QA Modern TLS error', 7, modernTlsFail, '服务器接受 TLS / NLA 协商']]) {
    await open(name)
    const workspace = page.locator('.desktop-workspace:visible')
    await workspace.getByText('无法建立远程桌面', { exact: true }).waitFor()
    const detail = await workspace.innerText()
    assert(detail.includes(expected), detail)
    assert(detail.includes('ERRCONNECT_TLS_CONNECT_FAILED'), detail)
    assert(!detail.includes('目标证书尚未受信任或身份验证被取消'), detail)
    assert.equal((await record(index)).options.securityMode, 'auto')
    assert.equal(target.stats.legacy, 0)
    assert.equal((await dialogs()).length, 4)
  }
  assert.deepEqual(errors, [])
  console.log('PASS probe failures and TLS-capable targets retain original TLS error plus specific compatibility diagnostics, without misleading certificate claims or downgrades')
  const opening = application.waitForEvent('window')
  await page.evaluate(() => window.omnidesk.app.openWindow())
  const secondary = await opening
  secondary.setDefaultTimeout(15000)
  secondary.on('pageerror', error => errors.push(error.message))
  await secondary.locator('.app-shell').waitFor()
  const windowHandle = await application.browserWindow(secondary)
  const owner = await windowHandle.evaluate(window => { window.focus(); return window.id })
  await secondary.getByRole('button', { name: /^服务器管理/ }).first().click()
  await secondary.getByRole('button', { name: 'QA Secondary legacy', exact: true }).click()
  await secondary.locator('#session-toolbar-slot .session-state.is-connected').waitFor()
  assert.equal((await dialogs()).length, 5)
  assert.equal((await dialogs()).at(-1).owner, owner)
  assert.equal((await record(8)).options.securityMode, 'legacy')
  assert.deepEqual(errors, [])
  await windowHandle.evaluate(window => window.close())
  console.log('PASS compatibility consent is attached to the initiating secondary window rather than the primary window')
}
main().catch(async error => {
  console.error(error)
  if (application) {
    const page = await application.firstWindow()
    console.error(await page.locator('.desktop-workspace:visible').innerText())
    console.error(await application.evaluate(() => globalThis.qaDialogs))
    await page.screenshot({ path: path.join(directory, 'failure.png') })
  }
  for (const child of children) console.error('peer:', child.lines)
  process.exitCode = 1
}).finally(async () => {
  await application?.close()
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
  for (const socket of sockets) socket.destroy()
  await Promise.all(bridges.map(server => new Promise(resolve => server.close(resolve))))
})
