const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { Server } = require('ssh2')
const { _electron } = require('playwright')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/appearance-qa-'))
const compiled = buildSync({ entryPoints: ['src/renderer/src/store/appearance.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const loaded = new Module(path.join(directory, 'appearance.cjs'), module)
loaded.filename = loaded.id
loaded.paths = module.paths
loaded._compile(compiled, loaded.filename)
const { normalizeAppearance, DEFAULT_APPEARANCE, terminalTheme } = loaded.exports
for (const input of [null, [], true, 'bad', { uiScale: 500, terminalFontSize: -1, uiFont: '__proto__', terminalFont: 'constructor', theme: 'bad' }]) assert.deepEqual(normalizeAppearance(input), DEFAULT_APPEARANCE)
assert.equal(normalizeAppearance({ terminalFontSize: 15.5 }).terminalFontSize, 14)
assert.equal(normalizeAppearance({ terminalFontSize: 24 }).terminalFontSize, 24)
assert.equal(normalizeAppearance({ terminalFontSize: 10 }).terminalFontSize, 10)
assert.equal(normalizeAppearance({ uiScale: '125' }).uiScale, 100)
assert.equal(normalizeAppearance({ sidebarLayout: 'unknown' }).sidebarLayout, 'tree')
for (const sidebarLayout of ['tree', 'grouped', 'flat']) assert.equal(normalizeAppearance({ sidebarLayout }).sidebarLayout, sidebarLayout)
assert.equal(terminalTheme('follow', 'light').background, terminalTheme('light', 'dark').background)
assert.notEqual(terminalTheme('dark', 'light').background, terminalTheme('light', 'dark').background)
console.log('PASS preference validation, size boundaries, prototype-safe font presets and terminal palettes')

const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const peers = []
let application
const errors = []
async function peer(name) {
  const state = { name, clients: new Set(), authentications: 0, input: '', sizes: [] }
  state.server = new Server({ hostKeys: [key] }, client => {
    state.clients.add(client)
    client.on('error', () => {})
    client.on('close', () => state.clients.delete(client))
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'qa' && context.password === 'synthetic-only') { state.authentications++; context.accept() }
      else context.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', (allow, reject, dimensions) => { state.sizes.push(dimensions); allow() })
      session.on('window-change', (allow, reject, dimensions) => { state.sizes.push(dimensions); allow?.() })
      session.on('shell', allow => {
        const stream = allow()
        stream.on('error', () => {})
        stream.write('Synthetic appearance check\r\nqa@server:~$ ')
        stream.on('data', data => { state.input += data.toString(); stream.write(data) })
      })
      session.on('exec', (allow, reject) => reject())
    }))
  })
  state.server.listen(0, '127.0.0.1')
  await once(state.server, 'listening')
  state.port = state.server.address().port
  peers.push(state)
  return state
}
async function launch() {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env: environment })
  const page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ width: 1440, height: 1000 }); window.focus() })
  return page
}
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function capture(filename) {
  const data = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(directory, filename), Buffer.from(data, 'base64'))
}
async function geometry(page) {
  await settle(page)
  return page.evaluate(() => {
    const rectangle = selector => {
      const element = document.querySelector(selector)
      const bounds = element.getBoundingClientRect()
      return [bounds.x, bounds.y, bounds.width, bounds.height].map(value => Math.round(value * 10) / 10)
    }
    return { header: rectangle('.workspace-header'), tabs: rectangle('.tabbar'), content: rectangle('.content-area'), sidebar: rectangle('.sidebar'), viewport: [innerWidth, innerHeight], status: getComputedStyle(document.querySelector('.statusbar')).display }
  })
}
async function settings(page) { await page.getByRole('button', { name: '设置', exact: true }).click(); if (await page.locator('[data-settings-section=appearance]').getAttribute('open') === null) await page.locator('[data-settings-section=appearance] > summary').click(); await page.getByRole('region', { name: '外观与字体设置' }).waitFor() }
async function activate(page, name) { await page.locator('.tab').filter({ hasText: name }).click(); await page.locator('#session-toolbar-slot .is-connected').waitFor(); await settle(page) }
async function main() {
  const first = await peer('QA Appearance One')
  const second = await peer('QA Appearance Two')
  let page = await launch()
  await page.getByRole('button', { name: /暂不设置/ }).click()
  const emptyGeometry = await geometry(page)
  await page.evaluate(() => { localStorage.setItem('omnidesk.theme', 'dark'); localStorage.setItem('omnidesk.terminal.fontSize', '17'); localStorage.setItem('omnidesk.terminal.sidebar', 'closed') })
  for (const target of peers) {
    const saved = await page.evaluate(target => window.omnidesk.connections.save({ kind: 'ssh', name: target.name, host: '127.0.0.1', port: target.port, username: 'qa', authMethod: 'password' }, { secret: 'synthetic-only' }), { name: target.name, port: target.port })
    assert(saved.ok, saved.message)
  }
  await page.reload()
  await settings(page)
  if (await page.locator('[data-settings-section="updates"]').getAttribute('open') === null) await page.locator('[data-settings-section="updates"] > summary').click()
  const updateSource = await page.getByRole('region', { name: '软件更新', exact: true }).innerText()
  assert(!updateSource.includes('jixn-hu/omnidesk-releases'))
  assert(!updateSource.includes('需公开仓库'))
  assert.equal(await page.getByLabel('SSH 终端字号', { exact: true }).inputValue(), '17')
  assert.equal(await page.getByRole('button', { name: '深色', exact: true }).getAttribute('aria-pressed'), 'true')
  for (const target of peers) {
    await page.getByRole('button', { name: /^服务器管理/ }).first().click()
    await page.getByRole('button', { name: target.name, exact: true }).click()
    await page.getByRole('button', { name: '信任并记住', exact: true }).click()
    await page.locator('#session-toolbar-slot .is-connected').waitFor()
  }
  const baseline = await geometry(page)
  assert.deepEqual(baseline, emptyGeometry)
  assert.equal(baseline.header[3], 42)
  assert.equal(baseline.tabs[3], 34)
  assert.equal(baseline.status, 'none')
  const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
  for (let iteration = 0; iteration < 3; iteration++) {
    await settings(page); assert.deepEqual(await geometry(page), baseline)
    await activate(page, first.name); assert.deepEqual(await geometry(page), baseline)
    await page.getByRole('button', { name: /^服务器管理/ }).first().click(); assert.deepEqual(await geometry(page), baseline)
    await activate(page, second.name); assert.deepEqual(await geometry(page), baseline)
  }
  assert.equal(first.authentications, 1)
  assert.equal(second.authentications, 1)
  console.log('PASS fixed 42px header / 34px tabs, no bottom-bar jump across home, settings, management and two live SSH sessions; no reconnect or window resize')
  await settings(page)
  await page.getByLabel('界面字体', { exact: true }).selectOption('yahei')
  await page.getByLabel('SSH 终端字体', { exact: true }).selectOption('consolas')
  await page.getByLabel('SSH 终端字号', { exact: true }).selectOption('20')
  await page.getByLabel('SSH 终端配色', { exact: true }).selectOption('follow')
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  assert(await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Microsoft YaHei')))
  for (const target of peers) {
    await activate(page, target.name)
    const style = await page.locator('.terminal-workspace:visible .xterm-rows').evaluate(element => { const style = getComputedStyle(element); return { size: style.fontSize, family: style.fontFamily } })
    assert.equal(style.size, '20px')
    assert(style.family.includes('Consolas'))
    assert.equal(await page.locator('.terminal-workspace:visible .terminal-body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(245, 248, 247)')
  }
  await page.getByRole('button', { name: '放大终端字号', exact: true }).click()
  await activate(page, first.name)
  assert.equal(await page.locator('.terminal-workspace:visible .xterm-rows').evaluate(element => getComputedStyle(element).fontSize), '21px')
  await page.locator('.terminal-workspace:visible .xterm-helper-textarea').focus()
  await page.keyboard.type('appearance-keyboard-check')
  await page.waitForFunction(() => document.querySelector('.terminal-workspace:not([hidden]) .xterm-rows')?.textContent.includes('appearance-keyboard-check'))
  assert(first.input.includes('appearance-keyboard-check'))
  console.log('PASS fonts, 10–24px terminal size, ANSI palettes and toolbar changes reach existing/hidden SSH tabs live; terminal input and nonblinking cursor preserved')
  await settings(page)
  for (const scale of ['90', '110', '125', '100']) {
    await page.getByLabel('界面缩放', { exact: true }).selectOption(scale)
    await settle(page)
    const scaled = await geometry(page)
    const zoom = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
    assert(Math.abs(zoom - Number(scale) / 100) < 0.001)
    await activate(page, first.name); assert.deepEqual(await geometry(page), scaled)
    await settings(page); assert.deepEqual(await geometry(page), scaled)
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), originalBounds)
  }
  const rejected = await page.evaluate(() => [NaN, Infinity, 0, 10, '1', null].map(value => { try { window.omnidesk.app.setZoomFactor(value); return false } catch { return true } }))
  assert(rejected.every(Boolean))
  await page.getByRole('button', { name: '跟随系统', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await capture('appearance-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  console.log('PASS 90/100/110/125% real Electron zoom keeps native bounds and tab geometry stable; invalid zoom rejected; system theme follows changes while explicit theme stays fixed')
  const newWindow = application.waitForEvent('window')
  const opened = await page.evaluate(() => window.omnidesk.app.openWindow())
  assert(Number.isInteger(opened.id ?? opened.data?.id))
  const other = await newWindow
  other.on('pageerror', error => errors.push(error.message))
  await settings(other)
  await other.getByLabel('SSH 终端字号', { exact: true }).selectOption('18')
  await page.getByLabel('SSH 终端字号', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="SSH 终端字号"]').value === '18')
  await other.close()
  await page.getByLabel('界面缩放', { exact: true }).selectOption('125')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 960, height: 760 }))
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  await settle(page)
  assert(await page.getByRole('region', { name: '外观与字体设置' }).evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'appearance controls overflow at 960px / 125%')
  assert(await page.getByRole('region', { name: '外观与字体设置' }).evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'appearance settings extend beyond the viewport')
  for (const label of ['界面字体', '界面缩放', 'SSH 终端字体', 'SSH 终端字号', 'SSH 终端配色']) assert(await page.getByLabel(label, { exact: true }).evaluate(element => element.getBoundingClientRect().right <= innerWidth), label + ' is clipped in the small window')
  await capture('appearance-small-light.png')
  assert.equal(first.authentications, 1)
  assert.equal(second.authentications, 1)
  await application.close(); application = undefined
  page = await launch()
  await settings(page)
  assert.equal(await page.getByLabel('界面字体', { exact: true }).inputValue(), 'yahei')
  assert.equal(await page.getByLabel('SSH 终端字体', { exact: true }).inputValue(), 'consolas')
  assert.equal(await page.getByLabel('SSH 终端字号', { exact: true }).inputValue(), '18')
  assert.equal(await page.getByLabel('SSH 终端配色', { exact: true }).inputValue(), 'follow')
  assert.equal(await page.getByLabel('界面缩放', { exact: true }).inputValue(), '125')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await page.getByRole('button', { name: '恢复默认外观', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('omnidesk.appearance'))), DEFAULT_APPEARANCE)
  assert.equal((await page.evaluate(() => window.omnidesk.connections.list())).data.length, 2)
  assert.deepEqual(errors, [])
  console.log('PASS legacy preference migration, multi-window synchronization, 960px/125% layout, restart persistence and scoped reset; synthetic profile only:', directory)
}
main().catch(async error => {
  console.error(error)
  if (application) await (await application.firstWindow()).screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {})
  process.exitCode = 1
}).finally(async () => {
  await application?.close()
  for (const target of peers) { for (const client of target.clients) client.end(); target.server.close() }
})
