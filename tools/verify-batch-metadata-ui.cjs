const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/batch-metadata-qa-'))
const profile = path.join(directory, 'profile')
let application, page
const errors = []
const list = () => page.evaluate(async () => { const result = await window.omnidesk.connections.list(); if (!result.ok) throw new Error(result.message); return result.data })
const dialog = () => page.getByRole('dialog', { name: '批量编辑服务器', exact: true })
const apply = () => dialog().getByRole('button', { name: '应用到 2 台服务器', exact: true }).click()
async function selectPair() {
  await page.getByLabel('选择 生产 Linux', { exact: true }).check()
  await page.getByLabel('选择 团队 Windows', { exact: true }).check()
  await page.getByRole('button', { name: '批量编辑', exact: true }).click()
}
async function main() {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: profile }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: require('electron'), args: [root, '--disable-gpu'], env: environment })
  page = await application.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }) })
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.getByRole('region', { name: '快速上手', exact: true }).waitFor()
  const before = await page.evaluate(async () => {
    const inputs = [
      { kind: 'ssh', name: '生产 Linux', host: '192.0.2.10', port: 22, username: 'ops', authMethod: 'password', tags: ['生产', '华东'], note: '应用节点', group: '应用组', proxy: { type: 'socks5', host: '127.0.0.1', port: 1080 }, exposedToExternal: true },
      { kind: 'rdp', name: '团队 Windows', host: '192.0.2.20', port: 3389, username: 'ops', domain: 'QA', tags: ['桌面', '华东'], note: '办公节点', group: '桌面组', options: { engine: 'freerdp', securityMode: 'legacy', ignoreCertificate: false } },
      { kind: 'ssh', name: '保持原值', host: '192.0.2.30', port: 22, username: 'ops', authMethod: 'password', tags: ['不修改'], note: '独立节点' }
    ]
    const result = []
    for (const input of inputs) { const saved = await window.omnidesk.connections.save(input, { secret: 'synthetic-qa-secret' }); if (!saved.ok) throw new Error(saved.message); result.push(saved.data) }
    return result
  })
  const vaultFile = fs.readdirSync(profile).find(file => file === 'vault.enc')
  assert(vaultFile, 'test must find the encrypted vault to verify metadata edits do not touch it')
  const vault = fs.readFileSync(path.join(profile, vaultFile))
  await page.reload()
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  await page.getByRole('button', { name: /^服务器管理/ }).first().click()
  const monitoring = page.getByRole('button', { name: '暂停自动监测', exact: true })
  if (await monitoring.count()) await monitoring.click()
  assert.equal(await page.locator('.server-table .tag-pill').count(), 5)
  await selectPair()
  assert(await dialog().getByRole('button', { name: '应用到 2 台服务器', exact: true }).isDisabled())
  await dialog().getByLabel('标签操作', { exact: true }).selectOption('add')
  await dialog().getByLabel('标签', { exact: true }).fill('已取消')
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  assert.deepEqual(await list(), before)
  await page.getByRole('button', { name: '批量编辑', exact: true }).click()
  await dialog().getByLabel('标签操作', { exact: true }).selectOption('add')
  const tags = () => dialog().getByLabel('标签', { exact: true })
  await tags().fill('共同维护'); await tags().press('Enter')
  await tags().fill('共同维护'); await tags().press('Enter')
  assert.equal(await dialog().locator('.tag-pill').count(), 1, 'tags deduplicate')
  await tags().fill('临时标签'); await tags().press('Enter')
  await dialog().getByRole('button', { name: '移除标签 临时标签', exact: true }).click()
  await dialog().getByLabel('备注操作', { exact: true }).selectOption('append')
  await dialog().getByLabel('备注内容', { exact: true }).fill('周五维护')
  await dialog().getByLabel('分组操作', { exact: true }).selectOption('replace')
  await dialog().getByLabel('分组名称', { exact: true }).fill('运维组')
  await page.screenshot({ path: path.join(directory, 'batch-edit.png') })
  await apply(); await dialog().waitFor({ state: 'hidden' })
  let records = await list()
  for (const original of before.slice(0, 2)) {
    const current = records.find(item => item.id === original.id)
    assert.deepEqual(current, { ...original, tags: [...original.tags, '共同维护'], note: original.note + '\n周五维护', group: '运维组', updatedAt: current.updatedAt })
    assert(current.updatedAt > original.updatedAt)
  }
  assert.deepEqual(records.find(item => item.id === before[2].id), before[2])
  await page.screenshot({ path: path.join(directory, 'directory.png') })
  await selectPair()
  await dialog().getByLabel('标签操作', { exact: true }).selectOption('remove')
  await dialog().getByRole('button', { name: '华东', exact: true }).click()
  await apply(); await dialog().waitFor({ state: 'hidden' })
  records = await list()
  assert(records.slice(0, 2).every(item => !item.tags.includes('华东')))
  await selectPair()
  await dialog().getByLabel('标签操作', { exact: true }).selectOption('replace')
  await tags().fill('统一标签') // Unfinished draft is included on save.
  await dialog().getByLabel('备注操作', { exact: true }).selectOption('replace')
  await dialog().getByLabel('备注内容', { exact: true }).fill('统一备注')
  await apply(); await dialog().waitFor({ state: 'hidden' })
  records = await list()
  for (const item of records.slice(0, 2)) { assert.deepEqual(item.tags, ['统一标签']); assert.equal(item.note, '统一备注') }
  await selectPair()
  for (const label of ['标签操作', '备注操作', '分组操作']) await dialog().getByLabel(label, { exact: true }).selectOption('clear')
  await apply(); await dialog().waitFor({ state: 'hidden' })
  await page.reload()
  records = await list()
  for (const item of records.slice(0, 2)) { assert.deepEqual(item.tags, []); assert.equal(item.note, ''); assert.equal(item.group, '') }
  assert.deepEqual(records[2], before[2])
  // Call the real IPC contract with stale/invalid requests and verify all-or-nothing persistence.
  const conflicts = await page.evaluate(async () => {
    const api = window.omnidesk.connections, rows = (await api.list()).data
    await api.save({ ...rows[1], note: '其他窗口更新' })
    const before = (await api.list()).data
    const result = await api.batchMetadata({ items: rows.slice(0, 2).map(({ id, updatedAt }) => ({ id, updatedAt })), changes: { note: { mode: 'append', value: '不能写入' } } })
    const after = (await api.list()).data
    const invalid = await api.batchMetadata({ items: after.slice(0, 2).map(({ id, updatedAt }) => ({ id, updatedAt })), changes: { credentialRef: 'bad' } })
    return { before, after, final: (await api.list()).data, result, invalid }
  })
  assert.equal(conflicts.result.ok, false); assert.equal(conflicts.invalid.ok, false)
  assert.deepEqual(conflicts.after, conflicts.before); assert.deepEqual(conflicts.final, conflicts.before)
  // Single-server editor uses the same pills, suggestions and keyboard handling.
  await page.getByRole('button', { name: /^服务器管理/ }).first().click()
  await page.locator('.server-table tbody tr').filter({ has: page.getByRole('button', { name: '生产 Linux', exact: true }) }).getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑连接', exact: true })
  await editor.getByLabel('标签', { exact: true }).fill('单台标签')
  await editor.getByLabel('标签', { exact: true }).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  assert.equal(await editor.locator('.tag-pill').count(), 0, 'IME candidate confirmation must not add a tag')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  assert.deepEqual((await list())[0].tags, ['单台标签'])
  assert.deepEqual(fs.readFileSync(path.join(profile, vaultFile)), vault, 'all metadata edits must leave encrypted credentials untouched')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 850 }))
  await selectPair()
  await dialog().getByLabel('标签操作', { exact: true }).selectOption('add')
  await tags().fill('a'.repeat(129))
  const beforeInvalid = await list()
  await apply()
  await dialog().getByRole('alert').waitFor()
  assert.deepEqual(await list(), beforeInvalid)
  await tags().fill('浅色标签'); await tags().press('Enter')
  await page.evaluate(() => document.documentElement.dataset.theme = 'light')
  await page.screenshot({ path: path.join(directory, 'compact-light.png') })
  assert(await dialog().evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth }))
  await dialog().getByRole('button', { name: '取消', exact: true }).click()
  assert.deepEqual(errors, [])
  console.log('PASS desktop real IPC/persistence: batch add/remove/replace/clear tags, append/replace/clear notes, groups, cancel, dedup, pending input, stale/invalid atomic rollback, untouched records/credentials/options, single editor IME and compact layout:', directory)
}
main().catch(async error => { console.error(error); if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: path.join(directory, 'failure.png') }) } process.exitCode = 1 }).finally(async () => { await application?.close() })
