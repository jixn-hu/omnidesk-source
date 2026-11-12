const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { once } = require('node:events'), { _electron } = require('playwright')
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(root, 'tmp/backup-sections-ui-'))
let application, page, server, oldServer = false
const errors = [], requests = []
const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096 - 16)])
const token = 'synthetic-backup-admin-token-long-enough'
const backupPath = path.join(directory, 'selected.odbackup'), databasePath = path.join(directory, 'database.odmonitor'), restoredDBPath = path.join(directory, 'restored.db')
async function launch(first) {
 const env = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
 application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env })
 page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message))
 await application.evaluate(({ BrowserWindow, dialog }, paths) => {
  BrowserWindow.getAllWindows()[0].setBounds({ width: 1420, height: 1100 })
  globalThis.qaApprove = true; globalThis.qaDetails = []; globalThis.qaOpenDB = false
  dialog.showSaveDialog = async options => ({ canceled: false, filePath: options.defaultPath.endsWith('.odmonitor') ? paths.databasePath : options.defaultPath.endsWith('.db') ? paths.restoredDBPath : paths.backupPath })
  dialog.showOpenDialog = async options => ({ canceled: false, filePaths: [options.filters[0].extensions.includes('odmonitor') ? paths.databasePath : paths.backupPath] })
  dialog.showMessageBox = async (...args) => { globalThis.qaDetails.push(args.at(-1).detail); return { response: globalThis.qaApprove ? 1 : 0 } }
 }, { backupPath, databasePath, restoredDBPath })
 if (first) await page.getByRole('button', { name: /暂不设置/ }).click()
}
async function settings() {
 await page.locator('.sidebar, .sidebar-rail').getByRole('button', { name: '设置', exact: true }).click()
 const section = page.locator('[data-settings-section=backup]')
 if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click()
 await page.getByRole('tab', { name: '本地文件', exact: true }).click()
}
const checkbox = name => page.getByRole('checkbox', { name: new RegExp('^' + name) })
async function main() {
 server = http.createServer((req, res) => {
  requests.push(req.url)
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('{}') }
  if (req.url === '/v1/backup' && !oldServer) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ format: 'omnidesk-monitor-database', version: 1, createdAt: Date.now(), database: db.toString('base64') })) }
  res.writeHead(404); res.end('{}')
 }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
 const origin = 'http://127.0.0.1:' + server.address().port
 await launch(true)
 await page.evaluate(async ({ origin, token }) => {
  const unwrap = r => { if (!r.ok) throw new Error(r.message); return r.data }
  await window.omnidesk.updates.setAutoCheck(false)
  unwrap(await window.omnidesk.connections.save({ kind: 'ssh', name: 'Backup fixture', host: '192.0.2.5', port: 22, username: 'qa', authMethod: 'password' }))
  unwrap(await window.omnidesk.monitoring.configure({ enabled: false }))
  unwrap(await window.omnidesk.ai.saveConfiguration({ baseUrl: 'https://ai.example.test/v1', model: 'backup-fixture', apiKey: 'synthetic-ui-ai-key', maxModelCalls: 20, permissionMode: 'read' }))
 }, { origin, token })
 await page.reload(); await settings()
 await checkbox('基础连接资料').waitFor(); assert(await checkbox('基础连接资料').isChecked()); assert(await checkbox('基础连接资料').isDisabled())
 await checkbox('监控配置').check()
 assert(await checkbox('外观与终端偏好').isChecked()); assert(!await checkbox('AI 配置').isChecked()); assert(!await checkbox('AI 对话记录').isChecked()); assert(!await checkbox('服务访问凭据').isChecked())
 await checkbox('AI 配置').check()
 await page.getByRole('tab', { name: 'WebDAV', exact: true }).click()
 assert(!await checkbox('AI 配置').isChecked()); await checkbox('AI 对话记录').check()
 assert.equal(await page.getByRole('tab', { name: '账号云端', exact: true }).count(),0)
 await page.getByRole('tab', { name: '本地文件', exact: true }).click(); assert(await checkbox('AI 配置').isChecked()); assert(!await checkbox('AI 对话记录').isChecked())
 await page.getByLabel('备份加密密码', { exact: true }).fill('Synthetic-UI-backup-password')
 await page.getByRole('button', { name: '备份到文件', exact: true }).click()
 await page.getByRole('status').filter({ hasText: '加密备份已导出' }).waitFor()
 assert(fs.existsSync(backupPath)); assert(!fs.readFileSync(backupPath, 'utf8').includes('synthetic-ui-ai-key'))
 await page.screenshot({ path: path.join(directory, '01-unified-backup.png') })
 // Change local preferences and AI configuration, then recover through the actual UI/native-dialog IPC.
 await page.evaluate(async () => {
  localStorage.setItem('omnidesk.appearance', JSON.stringify({ theme: 'light' }))
  localStorage.setItem('omnidesk.monitor.view', 'list')
  const r = await window.omnidesk.ai.saveConfiguration({ baseUrl: 'https://ai.example.test/v1', model: 'changed-local-model' }); if (!r.ok) throw new Error(r.message)
 })
 await page.reload(); await settings()
 await application.evaluate(() => { globalThis.qaApprove = false })
 await page.getByRole('button', { name: '从文件恢复', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已取消，未修改本地配置' }).waitFor()
 assert.equal((await page.evaluate(() => window.omnidesk.ai.configuration())).data.model, 'changed-local-model')
 await application.evaluate(() => { globalThis.qaApprove = true })
 await page.getByRole('button', { name: '从文件恢复', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已恢复' }).waitFor()
 assert.equal((await page.evaluate(() => window.omnidesk.ai.configuration())).data.model, 'backup-fixture')
 assert.equal(await page.evaluate(() => localStorage.getItem('omnidesk.monitor.view')), 'cards')
 assert((await application.evaluate(() => globalThis.qaDetails.at(-1))).includes('外观与终端偏好'))
 // An unselected settings section must retain its unsaved draft as well as its saved value.
 const aiSection = page.locator('[data-settings-section=ai]')
 if (await aiSection.getAttribute('open') === null) await aiSection.locator(':scope > summary').click()
 await page.getByLabel('AI 模型名称', { exact: true }).fill('unsaved-local-model-draft')
 await checkbox('AI 配置').uncheck()
 await page.getByRole('button', { name: '从文件恢复', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已恢复' }).waitFor()
 assert.equal(await page.getByLabel('AI 模型名称', { exact: true }).inputValue(), 'unsaved-local-model-draft')
 await checkbox('AI 配置').check()
 assert.equal(await page.getByRole('button',{name:'导出监控数据库',exact:true}).count(),0)
 assert.deepEqual(errors, [])
 await application.close(); application = undefined
 await launch(false); await settings(); assert(await checkbox('AI 配置').isChecked()); assert(!await checkbox('AI 对话记录').isChecked())
 await page.getByRole('tab', { name: 'WebDAV', exact: true }).click(); assert(await checkbox('AI 对话记录').isChecked())
 assert.equal(requests.filter(url => url === '/v1/backup').length, 0)
 console.log('PASS: settings local/WebDAV backup, fixed basic data, per-destination selection/defaults/persistence, actual encrypted file export/restore/cancellation, live preferences, separate account destination, restart')
 console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await application?.close(); server?.close() })
