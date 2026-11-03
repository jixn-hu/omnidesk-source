const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'tmp/ai-discovery-ui-'))
const profile = path.join(directory, 'profile')
const errors = [], requests = []
let application, page, records, steps = [], serial = 0
const done = content => ({ role: 'assistant', content })
const tool = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'discovery_ui_' + ++serial, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const result = body => JSON.parse(body.messages.at(-1).content)
const model = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    requests.push(body)
    const next = steps.shift()
    assert(next, 'Unexpected model request')
    const message = typeof next === 'function' ? await next(body) : next
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message }] }))
  } catch (error) { errors.push(error.message); response.writeHead(500); response.end('QA fixture failure') }
})
async function ipc(name, ...args) {
  return page.evaluate(async ({ name, args }) => {
    const [service, method] = name.split('.')
    const response = await window.omnidesk[service][method](...args)
    if (!response.ok) throw new Error(response.message)
    return response.data
  }, { name, args })
}
async function launch() {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: profile }; delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env: environment })
  page = await application.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }))
}
async function send(text, fixture) {
  assert.equal(steps.length, 0); steps = fixture
  await page.getByLabel('AI 任务', { exact: true }).fill(text)
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
}
async function capture(name) {
  await page.locator('.ai-transcript').evaluate(element => { element.style.scrollBehavior = 'auto'; element.scrollTop = element.scrollHeight })
  await page.screenshot({ path: path.join(directory, name) })
}
async function complete(text) {
  await page.locator('.ai-message-assistant').filter({ hasText: text }).waitFor()
  await page.getByText('准备就绪', { exact: true }).waitFor()
  assert.equal(steps.length, 0)
}
async function main() {
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await launch()
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.getByRole('region', { name: '快速上手', exact: true }).waitFor()
  records = []
  for (const input of [
    { kind: 'ssh', name: '生产应用', host: '192.0.2.10', port: 22, username: 'qa', group: '公司 / 生产', tags: ['华东', '应用'], note: '应用节点' },
    { kind: 'ssh', name: '代理池', host: '192.0.2.11', port: 22, username: 'qa', group: '公司 / 测试', tags: ['华东', '测试'], note: '待整理' },
    { kind: 'rdp', name: '办公 Windows', host: '192.0.2.12', port: 3389, username: 'qa', group: '办公', tags: ['桌面'], note: '办公节点' }
  ]) records.push(await ipc('connections.save', { ...input, authMethod: 'password' }))
  await page.reload()
  await page.getByRole('button', { name: /^AI 助手/ }).click()
  await page.getByLabel('AI 接口地址', { exact: true }).fill(`http://127.0.0.1:${model.address().port}/v1`)
  await page.getByLabel('AI 模型名称', { exact: true }).fill('qa-server-discovery')
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click()
  await page.getByText('AI 配置已保存。', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'qa-server-discovery', exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0)
  assert.match(await page.locator('.ai-scope-heading').innerText(), /全部本机服务器\s*3\s*\/\s*3/)
  await capture('discovery-welcome-light.png')
  await send('列出所有服务器，按分组整理给我看', [
    body => { assert.match(body.messages[0].content, /全部本机服务器/); for (const record of records) assert(!body.messages[0].content.includes(record.id)); return tool('list_servers', {}) },
    body => { const data = result(body); assert.equal(data.total, 3); assert.equal(data.scope, 'all'); assert.equal(data.nextOffset, null); assert.deepEqual(new Set(data.servers.map(item => item.id)), new Set(records.map(item => item.id))); return done('## 全部服务器资料\n\n| 名称 | 地址 | 分组 |\n| --- | --- | --- |\n| 生产应用 | 192.0.2.10:22 | 公司 / 生产 |\n| 代理池 | 192.0.2.11:22 | 公司 / 测试 |\n| 办公 Windows | 192.0.2.12:3389 | 办公 |\n\n共 3 台服务器，以上为登记资料。') }
  ])
  await complete('全部服务器资料')
  assert.equal(await page.locator('.ai-message-assistant table tbody tr').count(), 3)
  assert.deepEqual((await ipc('ai.state')).selectedIds, [])
  await page.getByLabel('当前对话权限').selectOption('edit')
  const newNote = '代理池，已核对登记资料'
  await send('先查看全部服务器资料，再把 192.0.2.11 的备注改为代理池，已核对登记资料', [
    tool('list_servers', {}),
    body => { assert.equal(result(body).total, 3); return tool('list_servers', { query: '192.0.2.11:22 测试' }) },
    body => { const data = result(body); assert.equal(data.total, 1); assert.equal(data.servers[0].id, records[1].id); assert.equal(data.servers[0].address, '192.0.2.11:22'); return tool('update_metadata', { server_ids: [data.servers[0].id], changes: { note: { mode: 'replace', value: newNote } } }) },
    body => { assert.equal(result(body).updated[0].note, newNote); return done('已将 **代理池（192.0.2.11）** 的备注改为：' + newNote + '。') }
  ])
  await complete('已将')
  let current = await ipc('connections.list')
  assert.equal(current.find(item => item.id === records[1].id).note, newNote)
  for (const index of [0, 2]) assert.deepEqual(current.find(item => item.id === records[index].id), records[index])
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0)
  const globalState = await ipc('ai.state')
  assert.equal(globalState.scopeMode, 'all'); assert.equal(globalState.scopeCount, 3); assert.deepEqual(globalState.selectedIds, [])
  await capture('discovery-target-updated-light.png')
  await page.getByLabel('选择 生产应用', { exact: true }).check()
  assert.match(await page.locator('.ai-scope-heading').innerText(), /已限定服务器\s*1\s*\/\s*3/)
  await send('查找并尝试修改范围外的办公 Windows', [
    body => { assert.match(body.messages[0].content, /仅手动勾选/); assert(!body.messages[0].content.includes(records[2].id)); return tool('list_servers', { query: '192.0.2.12' }) },
    body => { assert.equal(result(body).total, 0); assert.equal(result(body).scope, 'selected'); return tool('update_metadata', { server_ids: [records[2].id], changes: { note: { mode: 'replace', value: '不得写入' } } }) },
    body => { assert.match(result(body).error, /不在本轮可访问范围/); return done('此对话已限定为生产应用，办公 Windows 不在当前范围内，资料未修改。') }
  ])
  await complete('不在当前范围内')
  assert.deepEqual((await ipc('connections.list')).find(item => item.id === records[2].id), records[2])
  await capture('discovery-manual-scope-light.png')
  await page.getByRole('button', { name: '使用全部服务器', exact: true }).click()
  const restoredNote = '办公用途已确认'
  await send('把 192.0.2.12 的备注改为办公用途已确认', [
    body => { assert.equal(body.messages.filter(item => item.role === 'user').length, 1, 'Scope switch must reset model history'); return tool('list_servers', { query: '192.0.2.12' }) },
    body => { assert.equal(result(body).total, 1); return tool('update_metadata', { server_ids: [result(body).servers[0].id], changes: { note: { mode: 'replace', value: restoredNote } } }) },
    body => { assert.equal(result(body).updated[0].note, restoredNote); return done('办公 Windows（192.0.2.12）的备注已更新为：' + restoredNote + '。') }
  ])
  await complete('备注已更新为')
  current = await ipc('connections.list')
  assert.equal(current.find(item => item.id === records[2].id).note, restoredNote)
  assert.equal(current.find(item => item.id === records[1].id).note, newNote)
  assert.deepEqual(current.find(item => item.id === records[0].id), records[0])
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0)
  assert.deepEqual(await ipc('ssh.list'), [], 'Catalog discovery must not start SSH sessions')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await capture('discovery-dark.png')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 960, height: 720 }))
  await capture('discovery-narrow.png')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await application.close(); application = undefined
  await launch()
  await page.getByRole('button', { name: /^AI 助手/ }).click()
  await page.getByText('准备就绪', { exact: true }).waitFor()
  await page.locator('.ai-message-assistant').filter({ hasText: '备注已更新为' }).waitFor()
  const restored = await ipc('ai.state')
  assert.equal(restored.scopeMode, 'all'); assert.deepEqual(restored.selectedIds, []); assert.equal(restored.permissionMode, 'edit')
  assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0)
  assert.match(await page.locator('.ai-scope-heading').innerText(), /全部本机服务器/)
  assert(!fs.readFileSync(path.join(profile, 'ai-conversations.enc'), 'utf8').includes(restoredNote))
  assert.deepEqual(errors, [])
  assert.equal(requests.length, 12)
  console.log('PASS real Electron no-selection read/edit tasks, full-catalog table, address/tag lookup and exact-target metadata update without automatic selection')
  console.log('PASS explicit manual scope blocks unrelated reads/writes, switch to all resets model history, global scope encrypted restart, light/dark/narrow layouts and no catalog-triggered SSH')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await application?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) })