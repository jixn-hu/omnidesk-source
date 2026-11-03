const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright')
const fixtures = require('./rdo-test-fixtures.cjs')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-rdo-qa-'))
const file = path.join(directory, 'synthetic-connections.rdo')
const invalid = path.join(directory, 'invalid.rdo')
const original = fixtures.encodeNrbf(fixtures.fixture())
fs.writeFileSync(file, original)
fs.writeFileSync(invalid, 'QA invalid input')
const vaultModule = path.join(directory, 'vault.cjs')
require('esbuild').buildSync({ entryPoints: ['src/main/services/vault.ts'], outfile: vaultModule, bundle: true, platform: 'node', external: ['electron'], alias: { '@shared': path.resolve('src/shared') } })
let application

async function main() {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [path.resolve('.')]), '--disable-gpu'], env: environment })
  await application.evaluate(({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setBounds({ width: 1440, height: 1000 }); window.focus()
    globalThis.qaFileChoice = null
    globalThis.qaDialogCount = 0
    globalThis.qaConfirm = 0
    globalThis.qaConfirmations = []
    dialog.showOpenDialog = async () => {
      globalThis.qaDialogCount++
      return { canceled: !globalThis.qaFileChoice, filePaths: globalThis.qaFileChoice ? [globalThis.qaFileChoice] : [] }
    }
    dialog.showMessageBox = async options => { globalThis.qaConfirmations.push(options.title); return { response: globalThis.qaConfirm } }
  })
  const page = await application.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.locator('.app-shell').waitFor()
  const shared = await page.evaluate(async () => {
    const result = await window.omnidesk.shared.save({ name: 'QA public credential preserved', kind: 'password', username: 'qa-public', secret: 'QA-SYNTHETIC-PUBLIC-ONLY' })
    if (!result.ok) throw new Error(result.message)
    return result.data
  })
  const open = async () => {
    await page.getByRole('button', { name: /^服务器管理/ }).first().click()
    await page.getByRole('button', { name: '导入连接', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: '导入连接', exact: true })
    await dialog.getByRole('button', { name: /^Remote Desktop Organizer/ }).click()
  }
  await open()
  await page.getByRole('dialog', { name: '导入连接', exact: true }).waitFor()
  assert.equal(await application.evaluate(() => globalThis.qaDialogCount), 1)
  assert.equal((await page.evaluate(() => window.omnidesk.connections.list())).data.length, 0)
  await page.getByRole('dialog', { name: '导入连接', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await application.evaluate((_, file) => { globalThis.qaFileChoice = file }, invalid)
  await open()
  let dialog = page.getByRole('dialog', { name: '从 Remote Desktop Organizer 导入', exact: true })
  await dialog.locator('.alert-danger').waitFor()
  await dialog.getByRole('button', { name: '选择其他来源', exact: true }).click()
  await page.getByRole('dialog', { name: '导入连接', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  console.log('PASS native file picker cancellation/error paths; one dialog per request including React StrictMode; no connection changes')

  await application.evaluate((_, file) => { globalThis.qaFileChoice = file }, file)
  await open()
  dialog = page.getByRole('dialog', { name: '从 Remote Desktop Organizer 导入', exact: true })
  await dialog.getByRole('button', { name: '导入 2 条', exact: true }).waitFor()
  assert.equal(await dialog.locator('tbody tr').count(), 3)
  assert.equal(await dialog.locator('tbody input[type="checkbox"]:checked').count(), 2)
  assert.equal(await dialog.locator('tbody input[type="checkbox"]:disabled').count(), 1)
  assert.equal(await dialog.getByText('QA shared identity', { exact: true }).count(), 1)
  const preview = await dialog.innerText()
  for (const secret of [fixtures.PASSWORD, fixtures.UNICODE_PASSWORD, fixtures.CIPHER, fixtures.UNICODE_CIPHER]) assert(!preview.includes(secret))
  await page.screenshot({ path: path.resolve('tmp/qa-rdo-import.png') })
  await dialog.getByRole('button', { name: '导入 2 条', exact: true }).click()
  let completed = page.getByRole('dialog', { name: '导入完成', exact: true })
  await completed.waitFor()
  assert((await completed.innerText()).includes('已迁移 2 条密码'))
  await completed.getByRole('button', { name: '完成', exact: true }).click()
  const imported = (await page.evaluate(() => window.omnidesk.connections.list())).data
  assert.equal(imported.length, 2)
  assert.equal(imported[0].group, 'QA 生产 / QA Windows')
  assert.equal(imported[0].options.ignoreCertificate, false)
  assert.equal(imported[0].options.colorDepth, 16)
  assert.equal(imported[0].note, 'QA note\nsecond line')
  assert.equal(imported.find(connection => connection.name === 'QA tunnel').host, '198.51.100.10:9101')
  const { VaultService } = require(vaultModule)
  const vault = new VaultService(path.join(directory, 'profile'))
  vault.unlock()
  try {
    for (const connection of imported) assert.equal(vault.getCredential(connection.credentialRef)?.secret, connection.name === 'QA shared' ? fixtures.UNICODE_PASSWORD : fixtures.PASSWORD)
    assert.equal(vault.getCredential(shared.credentialRef)?.secret, 'QA-SYNTHETIC-PUBLIC-ONLY')
  } finally { vault.lock() }
  console.log('PASS real preview/apply IPC, nested folders, remarks, options, IP:port and identity/direct passwords encrypted into isolated vault; preview contains no passwords')

  await open()
  dialog = page.getByRole('dialog', { name: '从 Remote Desktop Organizer 导入', exact: true })
  await dialog.getByRole('button', { name: '导入 0 条', exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '导入 0 条', exact: true }).isDisabled(), true)
  assert.equal(await dialog.locator('tbody input[type="checkbox"]:disabled').count(), 3)
  await dialog.getByText('只导入新的，跳过重复服务器', { exact: true }).click()
  await dialog.locator('tbody input[type="checkbox"]').first().check()
  await dialog.getByRole('button', { name: '导入 1 条', exact: true }).click()
  await dialog.getByText('已取消导入', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.omnidesk.connections.list())).data.length, 2)
  await application.evaluate(() => { globalThis.qaConfirm = 1 })
  await dialog.getByRole('button', { name: '导入 1 条', exact: true }).click()
  completed = page.getByRole('dialog', { name: '导入完成', exact: true })
  await completed.waitFor()
  assert.equal((await page.evaluate(() => window.omnidesk.connections.list())).data.length, 3)
  await completed.getByRole('button', { name: '完成', exact: true }).click()
  assert.deepEqual((await page.evaluate(() => window.omnidesk.shared.list())).data, [shared])
  assert.deepEqual(await application.evaluate(() => globalThis.qaConfirmations), ['导入重复连接', '导入重复连接'])
  assert.deepEqual(fs.readFileSync(file), original)
  console.log('PASS repeated import defaults to zero duplicates; cancel/confirm duplicate import; public credentials and source file unchanged')

  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('xt:scan')
    ipcMain.handle('xt:scan', async () => ({ ok: true, data: { scanId: 'QA-XTERMINAL-PREVIEW', source: 'xterminal', dbPath: 'QA synthetic XTerminal', modifiedAt: Date.now(), candidates: [], summary: { sshTotal: 0, rdpTotal: 0, groups: 0, encryptedCredentials: 0, duplicates: 0 }, warnings: [] } }))
  })
  await page.getByRole('button', { name: /^服务器管理/ }).first().click()
  await page.getByRole('button', { name: '导入连接', exact: true }).first().click()
  await page.getByRole('dialog', { name: '导入连接', exact: true }).getByRole('button', { name: /^XTerminal/ }).click()
  await page.getByRole('dialog', { name: '从 XTerminal 导入', exact: true }).getByText('QA synthetic XTerminal', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS XTerminal source and preview remain available; synthetic QA only, no user RDO/XTerminal data read or imported')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { if (application) await application.close() })
