const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const version = require('../package.json').version
const directory = fs.mkdtempSync(path.join(root, 'tmp/settings-sections-ui-'))
const sectionIds = ['appearance', 'ai', 'monitoring', 'backup', 'updates', 'security', 'shortcuts', 'about']
const errors = []
let application, page
const section = id => page.locator(`[data-settings-section="${id}"]`)
async function expanded(id, expected) {
  await page.waitForFunction(({ id, expected }) => document.querySelector(`[data-settings-section="${id}"]`)?.open === expected, { id, expected })
}
async function toggle(id, open) {
  if ((await section(id).getAttribute('open') !== null) !== open) await section(id).locator(':scope > summary').click()
  await expanded(id, open)
}
async function settings() {
  await page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.settings-page:visible').waitFor()
}
async function launch() {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env: environment })
  page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width: 1360, height: 980 }); window.focus()
  })
}
async function screenshot(name) {
  await page.waitForTimeout(250) // Allow theme and disclosure transitions to finish before capturing.
  const bytes = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(directory, name), Buffer.from(bytes, 'base64'))
}
async function updateFixture(releaseVersion) {
  await application.evaluate(({ ipcMain, BrowserWindow }, { version, releaseVersion }) => {
    const status = { currentVersion: version, autoCheck: false, checking: false, available: true, release: { tag: 'v' + releaseVersion, version: releaseVersion, name: 'QA update', notes: 'Synthetic release', publishedAt: '2026-11-02T00:00:00Z', url: 'https://github.com/jixn-hu/omnidesk-releases/releases/tag/v' + releaseVersion } }
    ipcMain.removeHandler('updates:status')
    ipcMain.handle('updates:status', () => ({ ok: true, data: status }))
    ipcMain.removeHandler('updates:check')
    ipcMain.handle('updates:check', () => ({ ok: true, data: { ...status, lastCheckedAt: new Date().toISOString() } }))
    BrowserWindow.getAllWindows()[0].webContents.send('push:updates-changed', status)
  }, { version, releaseVersion })
  await page.getByRole('button', { name: '查看更新', exact: true }).waitFor()
}
async function noOverflow() {
  assert(await page.evaluate(() => {
    const pane = document.querySelector('.settings-page')
    return document.documentElement.scrollWidth <= innerWidth + 1 && pane.scrollWidth <= pane.clientWidth + 1
  }), 'Settings must fit without horizontal scrolling')
}
async function main() {
  await launch()
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.evaluate(() => window.omnidesk.updates.setAutoCheck(false))
  const records = await page.evaluate(async () => {
    const credential = await window.omnidesk.shared.save({ name: 'Settings QA credential', kind: 'password', username: 'qa-user', secret: 'synthetic-credential-only', note: 'Keep this fixture' })
    const connection = await window.omnidesk.connections.save({ kind: 'ssh', name: 'Settings QA server', host: '127.0.0.1', port: 12222, username: 'qa-user', authMethod: 'password', tags: ['fixture'], note: 'Keep all metadata' })
    if (!credential.ok || !connection.ok) throw new Error('Could not create isolated fixtures')
    return { credentials: await window.omnidesk.shared.list(), connections: await window.omnidesk.connections.list() }
  })
  await settings()
  assert.equal(await section('vpn').count(), 0)
  assert.equal(await page.evaluate(() => 'vpn' in window.omnidesk), false)
  assert.deepEqual(await page.locator('[data-settings-section]').evaluateAll(nodes => nodes.map(node => node.dataset.settingsSection)), sectionIds)
  for (const id of sectionIds) await expanded(id, false)
  assert.equal(await page.getByText('公共凭据 · 共享账号与凭证', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '管理公共凭据 →', exact: true }).count(), 0)
  await noOverflow()
  await screenshot('01-default-collapsed.png')
  console.log(`PASS ${sectionIds.length} collapsed groups by default, duplicate credential shortcut removed, compact overview`)

  await page.locator('.sidebar-footer').getByRole('button', { name: /^公共凭据/ }).click()
  await page.getByRole('heading', { name: '公共凭据', exact: true }).waitFor()
  await page.getByText('Settings QA credential', { exact: true }).waitFor()
  await settings()
  await toggle('ai', true)
  await page.getByLabel('AI 接口地址', { exact: true }).fill('http://127.0.0.1:1/v1')
  await page.getByLabel('AI 模型名称', { exact: true }).fill('settings-qa-model')
  await page.getByLabel('AI API Key', { exact: true }).fill('synthetic-ai-key-only')
  await page.getByLabel('单轮模型调用上限', { exact: true }).fill('201')
  await toggle('ai', false)
  await toggle('appearance', true)
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  await page.getByLabel('界面缩放', { exact: true }).selectOption('110')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.getByLabel('界面缩放', { exact: true }).selectOption('100')
  await toggle('ai', true)
  assert.equal(await page.getByLabel('AI API Key', { exact: true }).inputValue(), 'synthetic-ai-key-only')
  assert.equal(await page.getByLabel('AI 模型名称', { exact: true }).inputValue(), 'settings-qa-model')
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click()
  await page.getByText('AI 配置已保存。', { exact: true }).waitFor()
  const config = await page.evaluate(() => window.omnidesk.ai.configuration())
  assert(config.ok); assert.equal(config.data.model, 'settings-qa-model'); assert.equal(config.data.maxModelCalls, 201); assert(config.data.hasApiKey)
  console.log('PASS sidebar credential manager, independent folding, retained AI drafts and encrypted configuration save')

  await toggle('backup', true)
  await page.locator('#configuration-password').fill('synthetic-backup-password')
  await page.getByRole('tab', { name: 'WebDAV', exact: true }).click()
  await page.locator('#webdav-url').fill('https://dav.example.test/qa/')
  await page.locator('#webdav-username').fill('qa-draft')
  await page.locator('#webdav-password').fill('synthetic-webdav-password')
  await toggle('backup', false)
  await toggle('backup', true)
  assert.equal(await page.locator('#configuration-password').inputValue(), 'synthetic-backup-password')
  assert.equal(await page.locator('#webdav-url').inputValue(), 'https://dav.example.test/qa/')
  assert.equal(await page.locator('#webdav-password').inputValue(), 'synthetic-webdav-password')
  await toggle('backup', false)
  await toggle('security', true)
  await page.getByRole('button', { name: '切换方式', exact: true }).click()
  await page.locator('.modal:visible').waitFor()
  await page.locator('.modal:visible').getByRole('button', { name: '取消', exact: true }).click()
  await toggle('security', false)
  await section('shortcuts').locator(':scope > summary').focus()
  await page.keyboard.press('Enter'); await expanded('shortcuts', true)
  await page.keyboard.press('Space'); await expanded('shortcuts', false)
  console.log('PASS retained backup/WebDAV drafts, protection dialog cancel, removed VPN interface and keyboard toggles')

  for (const id of sectionIds) await toggle(id, false)
  await updateFixture('9.9.91')
  await page.locator('.sidebar-footer').getByRole('button', { name: /^公共凭据/ }).click()
  await page.getByRole('button', { name: '查看更新', exact: true }).click()
  await expanded('updates', true)
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await section('updates').getByText(/^上次成功检查：/).waitFor()
  await toggle('updates', false)
  await page.getByRole('button', { name: '关闭标签 设置', exact: true }).click()
  await updateFixture('9.9.92')
  await page.getByRole('button', { name: '查看更新', exact: true }).click()
  await expanded('updates', true)
  await toggle('updates', false)
  console.log('PASS update notices reveal collapsed updates for both retained and newly mounted settings views')

  await toggle('appearance', true)
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  await toggle('appearance', false)
  await screenshot('02-light-collapsed.png')
  await toggle('ai', true)
  await screenshot('03-light-ai-expanded.png')
  await toggle('appearance', true)
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await toggle('appearance', false)
  await screenshot('04-dark-ai-expanded.png')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 960, height: 720 }))
  await section('ai').locator(':scope > summary').scrollIntoViewIfNeeded()
  await noOverflow()
  await screenshot('05-narrow-ai-expanded.png')
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).scrollIntoViewIfNeeded()
  await screenshot('06-narrow-ai-controls.png')
  const savedStates = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('omnidesk.settings.expanded.')).map(key => [key, localStorage.getItem(key)])))
  assert.equal(savedStates['omnidesk.settings.expanded.ai'], 'true')
  assert.equal(savedStates['omnidesk.settings.expanded.appearance'], 'false')
  const storage = await page.evaluate(() => JSON.stringify(localStorage))
  for (const secret of ['synthetic-credential-only', 'synthetic-ai-key-only', 'synthetic-backup-password', 'synthetic-webdav-password']) assert(!storage.includes(secret))
  await page.reload(); await settings()
  for (const id of sectionIds) await expanded(id, id === 'ai')
  assert.equal(await page.getByLabel('AI 模型名称', { exact: true }).inputValue(), 'settings-qa-model')
  await application.close(); application = null
  await launch(); await settings()
  for (const id of sectionIds) await expanded(id, id === 'ai')
  const after = await page.evaluate(async () => ({ credentials: await window.omnidesk.shared.list(), connections: await window.omnidesk.connections.list() }))
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(records)))
  assert.deepEqual(errors, [])
  console.log('PASS light/dark/narrow layouts, reload/restart expansion persistence, no localStorage secrets, unchanged server/credential fixtures and no renderer errors')
  console.log('Artifacts:', directory)
}
main().catch(error => { console.error(error); console.error('Artifacts:', directory); process.exitCode = 1 }).finally(async () => { await application?.close() })