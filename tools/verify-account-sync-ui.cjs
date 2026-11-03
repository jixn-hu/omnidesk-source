const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/account-sync-ui-'))
require('esbuild').buildSync({ entryPoints: ['official-account', 'connection-store', 'shared-credentials', 'vault', 'config-backup'].map(name => path.join(root, `src/main/services/${name}.ts`)), outdir: directory, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const load = name => require(path.join(directory, name + '.js'))
const { OfficialAccountService } = load('official-account')
const { ConnectionStore } = load('connection-store')
const { SharedCredentialStore } = load('shared-credentials')
const { VaultService } = load('vault')
const { ConfigurationBackupService } = load('config-backup')
const errors = []
let application, page, server, seed, failPut = false
const password = 'QA-synthetic-account-password'
async function launch(fresh = false) {
  const env = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env })
  page = await application.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow, dialog }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1320, height: 940 })
    globalThis.qaApprove = true; globalThis.qaMerges = 0
    dialog.showMessageBox = async (...args) => { if (args.at(-1).message === '导入加密配置？') globalThis.qaMerges++; return { response: globalThis.qaApprove ? 1 : 0 } }
  })
  if (fresh) await page.getByRole('button', { name: /暂不设置/ }).click()
}
const status = () => page.evaluate(async () => (await window.omnidesk.account.status()).data)
async function upload() {
  const button = page.getByRole('button', { name: '上传本机配置', exact: true })
  await button.click()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === '上传本机配置')
    return button && !button.disabled && document.querySelector('.account-workspace .alert')
  })
}
async function main() {
  const { createOfficialServer } = await import(pathToFileURL(path.resolve(root, '../omnidesk-server/server.mjs')).href)
  server = createOfficialServer({ directory: path.join(directory, 'server'), registration: true, onError: error => errors.push(String(error)) })
  const handler = server.server.listeners('request')[0]
  server.server.removeListener('request', handler)
  server.server.on('request', (request, response) => {
    if (failPut && request.method === 'PUT' && request.url === '/v1/configuration') {
      response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'QA upload unavailable after successful merge' })); return
    }
    handler(request, response)
  })
  server.server.listen(0, '127.0.0.1'); await once(server.server, 'listening')
  const origin = 'http://127.0.0.1:' + server.server.address().port
  const seedProfile = path.join(directory, 'seed'); fs.mkdirSync(seedProfile)
  const vault = new VaultService(seedProfile); vault.init('QA-synthetic-seed-password')
  const connections = new ConnectionStore(seedProfile), shared = new SharedCredentialStore(seedProfile)
  const backup = new ConfigurationBackupService(seedProfile, connections, shared, vault, async () => true)
  seed = new OfficialAccountService(seedProfile, vault, backup, async () => true)
  await seed.configure(origin); await seed.authenticate('register', 'sync_ui', password)
  connections.save({ kind: 'ssh', name: 'QA cloud server', host: '192.0.2.10', port: 22, username: 'qa', authMethod: 'password' })
  await seed.upload()
  await launch(true)
  await page.evaluate(async () => {
    await window.omnidesk.updates.setAutoCheck(false)
    const result = await window.omnidesk.connections.save({ kind: 'ssh', name: 'QA local server', host: '192.0.2.20', port: 22, username: 'qa', authMethod: 'password' })
    if (!result.ok) throw new Error(result.message)
  })
  await page.reload()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByLabel('官方服务地址', { exact: true }).fill(origin)
  await page.getByRole('button', { name: '保存服务地址', exact: true }).click()
  await page.getByText('服务地址已保存；更换服务后需重新登录。', { exact: true }).waitFor()
  await page.getByLabel('官方账号', { exact: true }).fill('sync_ui')
  await page.getByLabel('官方账号密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录账号', exact: true }).click()
  await page.getByText('已登录。本机连接不会自动上传。', { exact: true }).waitFor()
  await page.locator('.account-sync summary').click()
  assert.equal((await status()).revision, 0)
  await upload()
  await page.getByText('本机配置已加密同步到云端。其他设备登录同一账号后可拉取。', { exact: true }).waitFor()
  assert.equal((await status()).revision, 2)
  await page.locator('.sidebar').getByRole('button', { name: '打开连接 QA cloud server', exact: true }).waitFor()
  await page.locator('.sidebar').getByRole('button', { name: '打开连接 QA local server', exact: true }).waitFor()
  assert.equal(await application.evaluate(() => globalThis.qaMerges), 1)
  await page.screenshot({ path: path.join(directory, '01-first-sync.png') })
  console.log('PASS real Electron login and #0 upload complete one confirmed cloud merge, refresh the sidebar and display the accepted version')

  await seed.download()
  connections.save({ kind: 'ssh', name: 'QA later cloud server', host: '192.0.2.30', port: 22, username: 'qa', authMethod: 'password' })
  assert.equal((await seed.upload()).revision, 3)
  await application.evaluate(() => { globalThis.qaApprove = false })
  await upload()
  await page.getByRole('alert').filter({ hasText: '已取消云端配置合并' }).waitFor()
  assert.equal((await status()).revision, 2)
  assert.equal(await page.locator('.sidebar').getByRole('button', { name: '打开连接 QA later cloud server', exact: true }).count(), 0)
  assert.equal((await seed.request('/v1/configuration')).revision, 3)
  console.log('PASS cancelling the merge keeps the previous version, local list and cloud snapshot unchanged')

  await application.evaluate(() => { globalThis.qaApprove = true })
  failPut = true
  await upload()
  await page.getByRole('alert').filter({ hasText: 'QA upload unavailable after successful merge' }).waitFor()
  assert.equal((await status()).revision, 3)
  await page.locator('.sidebar').getByRole('button', { name: '打开连接 QA later cloud server', exact: true }).waitFor()
  assert.equal((await seed.request('/v1/configuration')).revision, 3)
  await page.screenshot({ path: path.join(directory, '02-merged-upload-failure.png') })
  const confirmations = await application.evaluate(() => globalThis.qaMerges)
  failPut = false
  await upload()
  assert.equal((await status()).revision, 4)
  assert.equal(await application.evaluate(() => globalThis.qaMerges), confirmations)
  assert.equal((await page.evaluate(() => window.omnidesk.connections.list())).data.length, 3)
  await page.screenshot({ path: path.join(directory, '03-retry-success.png') })
  await application.close(); application = undefined
  await launch()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByRole('button', { name: '退出账号', exact: true }).waitFor()
  assert.equal((await status()).revision, 4)
  assert.equal((await page.evaluate(() => window.omnidesk.connections.list())).data.length, 3)
  assert.deepEqual(errors, [])
  console.log('PASS successful merge followed by failed upload still refreshes local rows; retry needs no duplicate merge, and version/session persist after restart')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await application?.close(); seed?.dispose(); await server?.close() })
