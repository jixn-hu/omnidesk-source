const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Server } = require('ssh2')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'tmp/ai-ui-qa-'))
const profile = path.join(directory, 'profile')
let application, page, records, steps = [], serial = 0
const requests = [], commands = [], errors = [], peers = new Set()
const password = 'Synthetic-UI-ssh-secret-4877', apiKey = 'Synthetic-UI-provider-key-3699'
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const ssh = new Server({ hostKeys: [key] }, client => {
  peers.add(client); client.on('close', () => peers.delete(client)); client.on('error', () => {})
  client.on('authentication', context => context.method === 'password' && context.username === 'qa' && context.password === password ? context.accept() : context.reject())
  client.on('ready', () => client.on('session', accept => accept().on('exec', (accept, _reject, info) => {
    commands.push(info.command)
    const stream = accept()
    stream.write(`Filesystem Size Used Avail Use% Mounted on\n/dev/qa 100G 48G 52G 48% /\npassword=${password}\n`)
    stream.exit(0); stream.end()
  })))
})
const call = (name, args) => ({ id: 'ui_' + ++serial, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tool = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls })
const done = text => ({ role: 'assistant', content: text })
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer ' + apiKey)
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body)
    assert.equal(body.model, 'qa-ui-model')
    const message = steps.shift(); assert(message, 'Unexpected AI request')
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: typeof message === 'function' ? await message(body) : message }] }))
  } catch (error) { errors.push(error.message); response.writeHead(500); response.end('QA fixture failed') }
})
const getState = () => page.evaluate(async () => (await window.omnidesk.ai.state()).data)
const list = () => page.evaluate(async () => (await window.omnidesk.connections.list()).data)
async function task(text, fixture) {
  assert.equal(steps.length, 0); steps = fixture
  await page.getByLabel('AI 任务', { exact: true }).fill(text)
  await page.getByRole('button', { name: '发送任务', exact: true }).click()
}
async function complete(text) {
  await page.locator('.ai-message-assistant').filter({ hasText: text }).waitFor()
  await page.getByText('准备就绪', { exact: true }).waitFor()
  assert.equal(steps.length, 0)
}
async function launch() {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: profile }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env: environment })
  page = await application.firstWindow(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }) })
}
async function main() {
  ssh.listen(0, '127.0.0.1'); model.listen(0, '127.0.0.1'); await Promise.all([once(ssh, 'listening'), once(model, 'listening')])
  await launch()
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.getByRole('region', { name: '快速上手', exact: true }).waitFor()
  records = await page.evaluate(async ({ port, password }) => {
    const inputs = [
      { kind: 'ssh', name: '生产 Linux', host: '127.0.0.1', port, username: 'qa', authMethod: 'password', tags: ['华东'], note: '应用节点' },
      { kind: 'rdp', name: '团队 Windows', host: '192.0.2.20', port: 3389, username: 'qa', tags: ['华东', '桌面'], note: '办公节点' },
      { kind: 'ssh', name: '未选中的服务器', host: '192.0.2.30', port: 22, username: 'qa', authMethod: 'password', note: '不修改' }
    ]
    const records = []
    for (const input of inputs) { const saved = await window.omnidesk.connections.save(input, { secret: password }); if (!saved.ok) throw new Error(saved.message); records.push(saved.data) }
    return records
  }, { port: ssh.address().port, password })
  await page.reload()
  await page.getByRole('button', { name: /^AI 助手/ }).click()
  const input = page.getByLabel('AI 接口地址', { exact: true })
  await input.waitFor(); assert.equal(await input.inputValue(), '')
  await input.fill(`http://127.0.0.1:${model.address().port}/v1`)
  await page.getByLabel('AI 模型名称', { exact: true }).fill('qa-ui-model')
  await page.getByLabel('AI API Key', { exact: true }).fill(apiKey)
  await page.getByLabel('默认完全权限', { exact: true }).check()
  steps = [done('连接成功')]
  await page.getByRole('button', { name: '保存并测试', exact: true }).click()
  await page.getByText(/AI 接口连接成功/).waitFor()
  assert.equal(await page.getByLabel('AI API Key', { exact: true }).inputValue(), '')
  assert((await page.evaluate(() => window.omnidesk.ai.configuration())).data.hasApiKey)
  assert(!JSON.stringify(await getState()).includes(apiKey))
  await page.screenshot({ path: path.join(directory, 'configuration.png') })
  await page.getByRole('button', { name: 'qa-ui-model', exact: true }).click()
  await page.getByLabel('选择 生产 Linux', { exact: true }).check()
  await page.getByLabel('选择 团队 Windows', { exact: true }).check()
  await page.screenshot({ path: path.join(directory, 'assistant-empty.png') })
  await task('给选中服务器添加生产标签，备注本周已巡检', [tool(call('list_servers', {})), tool(call('update_metadata', { server_ids: records.slice(0, 2).map(item => item.id), changes: { tags: { mode: 'add', values: ['生产'] }, note: { mode: 'append', value: '本周已巡检' } } })), done('两台服务器的标签和备注已更新。')])
  await complete('两台服务器的标签和备注已更新。')
  let current = await list()
  for (const record of records.slice(0, 2)) assert.deepEqual(current.find(item => item.id === record.id), { ...record, tags: [...record.tags, '生产'], note: record.note + '\n本周已巡检', updatedAt: current.find(item => item.id === record.id).updatedAt })
  assert.deepEqual(current.find(item => item.id === records[2].id), records[2])
  assert.equal(await page.locator('.ai-server-tags').getByText('生产', { exact: true }).count(), 2)
  const checkbox = await page.getByLabel('选择 生产 Linux', { exact: true }).boundingBox()
  assert(checkbox.width < 22 && checkbox.height < 22)
  assert.equal(await page.locator('.ai-server-list').evaluate(element => element.scrollWidth > element.clientWidth), false)
  await page.getByLabel('选择 团队 Windows', { exact: true }).uncheck()
  await task('先取消一次首次服务器身份确认', [tool(call('inspect_linux', { server_id: records[0].id, topic: 'disks' }))])
  const identity = page.getByRole('region', { name: 'SSH 身份确认', exact: true })
  await identity.waitFor()
  assert.equal(await page.locator('.modal-backdrop:visible').count(), 0)
  assert.match(await identity.innerText(), /SHA256/)
  await page.screenshot({ path: path.join(directory, 'identity-inline.png') })
  const identityConversation = (await getState()).conversationId
  await page.getByRole('button', { name: '新建对话', exact: true }).click()
  await identity.waitFor({ state: 'hidden' })
  assert.equal(await identity.count(), 0)
  assert.match(await page.locator(`.ai-conversation-tab[data-conversation-id="${identityConversation}"]`).innerText(), /待核验/)
  await page.locator(`.ai-conversation-tab[data-conversation-id="${identityConversation}"]`).click()
  await identity.waitFor()
  await identity.getByRole('button', { name: '取消', exact: true }).click()
  await identity.waitFor({ state: 'hidden' }); await page.getByText('准备就绪', { exact: true }).waitFor()
  assert.equal(commands.length, 0)
  await task('确认身份时切换页面再返回', [tool(call('inspect_linux', { server_id: records[0].id, topic: 'disks' }))])
  await identity.waitFor()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('.modal-backdrop:visible').getByRole('heading', { name: '确认主机密钥', exact: true }).waitFor()
  await page.evaluate(() => window.omnidesk.ai.cancel())
  await page.locator('.modal-backdrop:visible').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /^AI 助手/ }).click()
  await page.getByText('准备就绪', { exact: true }).waitFor()
  assert.equal(commands.length, 0)
  await task('检查这台 Linux 的磁盘情况', [tool(call('inspect_linux', { server_id: records[0].id, topic: 'disks' })), done('磁盘使用率为 48%。')])
  await page.getByRole('heading', { name: '确认主机密钥', exact: true }).waitFor()
  assert.equal(commands.length, 0)
  await page.getByRole('button', { name: '信任并记住', exact: true }).click()
  await complete('磁盘使用率为 48%。')
  assert.deepEqual(commands, ['df -hP; df -iP'])
  const operation = tool(call('run_ssh', { server_id: records[0].id, command: "printf 'qa-operation'", reason: '在已选服务器执行一条示例运维命令。' }))
  await task('执行示例运维命令', [operation, done('已确认并执行示例命令。')])
  const approval = page.locator('.ai-confirmation[data-state="pending"][aria-label="SSH 命令确认"]')
  await approval.waitFor()
  assert.equal(commands.length, 1)
  assert.match(await approval.innerText(), /qa@127\.0\.0\.1:/)
  assert.equal(await page.locator('.ai-transcript').getByRole('region', { name: 'SSH 命令确认', exact: true }).count(), 1)
  assert.equal(await page.locator('.modal-backdrop:visible').count(), 0)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(180)
  await page.screenshot({ path: path.join(directory, 'approval-dark.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(180)
  await page.screenshot({ path: path.join(directory, 'approval-light.png') })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 960, height: 720 }))
  await page.waitForTimeout(180)
  await page.waitForFunction(() => {
    const button = document.querySelector('.ai-confirmation[data-state="pending"] .btn-primary')?.getBoundingClientRect()
    const transcript = document.querySelector('.ai-transcript').getBoundingClientRect()
    return button && button.top >= transcript.top && button.bottom <= transcript.bottom
  })
  await page.screenshot({ path: path.join(directory, 'approval-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  assert(await approval.getByRole('button', { name: '确认执行', exact: true }).isVisible())
  const stopBounds = await page.getByRole('button', { name: '停止任务', exact: true }).boundingBox()
  assert(stopBounds.y + stopBounds.height <= await page.evaluate(() => window.innerHeight), 'Composer controls clipped')
  await approval.getByRole('button', { name: '确认执行', exact: true }).click()
  await complete('已确认并执行示例命令。'); assert.equal(commands.length, 2); assert.equal(commands[1], "printf 'qa-operation'")
  await task('再申请一次示例命令', [operation, done('已拒绝，未执行。')]); await approval.waitFor()
  await approval.getByRole('button', { name: '取消', exact: true }).click(); await complete('已拒绝，未执行。'); assert.equal(commands.length, 2)
  await task('申请命令后停止', [operation]); await approval.waitFor()
  await page.getByRole('button', { name: '停止任务', exact: true }).click()
  await approval.waitFor({ state: 'hidden' }); await page.getByText('准备就绪', { exact: true }).waitFor(); assert.equal(commands.length, 2)
  assert.equal(await page.locator('.ai-confirmation[data-state="confirmed"]').count(), 1)
  assert.equal(await page.locator('.ai-confirmation[data-state="cancelled"]').count(), 1)
  assert.equal(await page.locator('.ai-confirmation[data-state="stopped"]').count(), 1)
  assert.equal(await page.locator('.ai-confirmation:not([data-state="pending"]) button').count(), 0)
  const question = () => tool(call('ask_user', { title: '确认后续巡检方案', message: '是否继续只读巡检，并将结果整理为报告？\n\n- 作用范围：所选服务器\n- 不修改文件或服务' }))
  const choice = page.locator('.ai-confirmation[data-state="pending"][aria-label="AI 事项确认"]')
  await task('先确认巡检方案', [question(), done('已根据你的确认继续整理。')])
  await choice.waitFor()
  assert.equal(await page.locator('.modal-backdrop:visible').count(), 0)
  assert(await choice.getByRole('button', { name: '取消', exact: true }).evaluate(element => element === document.activeElement))
  await page.screenshot({ path: path.join(directory, 'question-narrow.png') })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }))
  await choice.getByRole('button', { name: '确定', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(directory, 'question-light.png') })
  await choice.screenshot({ path: path.join(directory, 'question-card.png'), animations: 'disabled' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: path.join(directory, 'question-dark.png'), animations: 'disabled' })
  await choice.getByRole('button', { name: '确定', exact: true }).click()
  await complete('已根据你的确认继续整理。')
  await page.locator('.ai-confirmation[data-state="confirmed"][aria-label="AI 事项确认"]').last().screenshot({ path: path.join(directory, 'question-confirmed.png') })
  assert.equal(commands.length, 2)
  const beforeQuestionCancel = await list()
  await task('取消方案后不要修改资料', [tool(call('ask_user', { title: '确认备注更新', message: '是否在所选服务器备注中追加巡检记录？' }), call('update_metadata', { server_ids: [records[0].id], changes: { note: { mode: 'append', value: '不应写入' } } }))])
  await choice.waitFor()
  await choice.getByRole('button', { name: '取消', exact: true }).click()
  await complete('已取消，本轮后续操作未执行。')
  assert.deepEqual(await list(), beforeQuestionCancel)
  await task('通过 Escape 取消本次方案', [question()])
  await choice.waitFor()
  await choice.getByRole('button', { name: '取消', exact: true }).press('Escape')
  await choice.waitFor({ state: 'hidden' }); await page.getByText('准备就绪', { exact: true }).waitFor()
  assert.equal(commands.length, 2)
  await task('等待中的确认到期后不可再点击', [question()])
  await choice.waitFor()
  await page.evaluate(() => { window.__qaDateNow = Date.now; const shifted = Date.now() + 301000; Date.now = () => shifted })
  const expiredChoice = page.locator('.ai-confirmation[data-state="expired"][aria-label="AI 事项确认"]')
  await expiredChoice.waitFor()
  assert.equal(await expiredChoice.getByRole('button').count(), 0)
  assert.match(await expiredChoice.innerText(), /已超时/)
  await expiredChoice.screenshot({ path: path.join(directory, 'question-expired.png') })
  await page.evaluate(() => { Date.now = window.__qaDateNow; delete window.__qaDateNow })
  await page.getByRole('button', { name: '停止任务', exact: true }).click()
  await page.getByText('准备就绪', { exact: true }).waitFor()
  assert.equal(commands.length, 2)
  await task('确认方案仍需单独确认命令', [question(), operation, done('仅取消了 SSH 命令，命令没有执行。')])
  await choice.waitFor(); await choice.getByRole('button', { name: '确定', exact: true }).click()
  await approval.waitFor(); assert.equal(commands.length, 2)
  await approval.getByRole('button', { name: '取消', exact: true }).click()
  await complete('仅取消了 SSH 命令，命令没有执行。')
  assert.equal(commands.length, 2)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }))
  await page.getByRole('button', { name: '清空对话', exact: true }).click()
  await page.locator('.ai-welcome').waitFor()
  await page.getByLabel('选择 生产 Linux', { exact: true }).check()
  const overview = [
    '## 服务器概览：192.0.2.10',
    '',
    '资源余量充足，**有 2 个服务需要确认**。',
    '',
    '### 系统',
    '- Ubuntu 22.04.5 LTS，内核 `5.15.0-92-generic`，x86_64',
    '- 已连续运行 **658 天**。',
    '',
    '### 资源',
    '| 项目 | 当前状态 | 说明 |',
    '| --- | --- | --- |',
    '| CPU | 16 核 | 负载 2.16 / 2.44 / 2.66 |',
    '| 内存 | 16.9 / 31 GB | 可用 14.2 GB |',
    '| 根分区 | **61%** | 仍有 37 GB 可用 |',
    '',
    '### 网络与进程',
    '- eth0：`192.0.2.10/24`；默认网关 `192.0.2.1`。',
    '- 运行 Docker、uwsgi、uvicorn 和 Redis。',
    '  - `proxy_checker` 正在消耗 CPU。',
    '',
    '### 需要关注',
    '> nginx.service 和 console-setup.service 处于 failed 状态。请先确认业务入口，再决定是否处理。',
    '',
    '1. 确认业务是否由容器或 uwsgi 提供服务。',
    '2. 如需执行自定义命令，仍须逐条确认。',
    '',
    '```bash',
    'systemctl status nginx.service --no-pager',
    '# ' + 'long-output-'.repeat(32),
    '```',
    '',
    '[内部管理](http://192.0.2.75:47831/admin/)',
    '',
    '- [x] 完成只读查询',
    '- [ ] 等待人工确认异常服务'
  ].join('\n')
  let finishOverview
  const overviewGate = new Promise(resolve => { finishOverview = resolve })
  await task('对选中的服务器做一轮只读概览', [
    { ...tool(call('list_servers', {})), content: '我先做一轮只读概览。' },
    tool(...['system', 'resources', 'disks', 'network', 'processes', 'services'].map(topic => call('inspect_linux', { server_id: records[0].id, topic }))),
    async () => { await overviewGate; return done(overview) }
  ])
  const history = page.locator('.ai-activity-group')
  await history.locator(':scope > summary').filter({ hasText: '6 次只读查询 · 13 条记录' }).waitFor()
  assert.equal(await history.count(), 1)
  assert.equal(await history.getAttribute('open'), null)
  assert(await history.locator('.ai-activity-current').isVisible(), 'Collapsed progress must remain visible')
  await page.screenshot({ path: path.join(directory, 'overview-running.png') })
  finishOverview()
  await complete('服务器概览：192.0.2.10')
  const report = page.locator('.ai-message-assistant').last()
  assert.equal(await report.locator('h2').innerText(), '服务器概览：192.0.2.10')
  assert.equal(await report.locator('h3').count(), 4)
  assert.equal(await report.locator('strong').count(), 3)
  assert.equal(await report.locator('table tbody tr').count(), 3)
  assert.equal(await report.locator('blockquote').count(), 1)
  assert.equal(await report.locator('ol > li').count(), 2)
  assert.equal(await report.locator('ul ul').count(), 1)
  assert.equal(await report.locator('pre code.language-bash').count(), 1)
  assert.equal(await report.locator('input[type="checkbox"][disabled]').count(), 2)
  assert(!(await report.locator('.ai-markdown').innerText()).includes('##'))
  assert.equal(await history.locator('.ai-activity > summary:visible').count(), 0, 'Repeated records should be collapsed')
  await report.getByRole('button', { name: '复制回复', exact: true }).click()
  await report.getByRole('status').filter({ hasText: '已复制' }).waitFor()
  assert.equal((await application.evaluate(({ clipboard }) => clipboard.readText())).replaceAll('\r\n', '\n'), overview)
  await history.locator(':scope > summary').click()
  assert.equal(await history.locator('.ai-activity').count(), 13)
  const result = history.locator('.ai-activity').filter({ hasText: 'Linux 查询结果' }).first()
  await result.locator('summary').click()
  assert.match(await result.locator('pre').innerText(), /Filesystem/)
  assert(!(await result.locator('pre').innerText()).includes(password))
  await page.screenshot({ path: path.join(directory, 'overview-details.png') })
  await history.locator(':scope > summary').click()
  await report.locator('h2').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await page.screenshot({ path: path.join(directory, 'overview-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: path.join(directory, 'overview-dark.png'), animations: 'disabled' })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 960, height: 720 }))
  await report.locator('pre').scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  assert.equal(await page.locator('.ai-transcript').evaluate(element => element.scrollWidth > element.clientWidth), false)
  assert(await report.locator('pre').evaluate(element => element.scrollWidth > element.clientWidth), 'Long code must scroll inside its block')
  await page.screenshot({ path: path.join(directory, 'overview-narrow.png') })
  await application.evaluate(({ shell }) => { globalThis.__aiQaExternal = []; shell.openExternal = async url => { globalThis.__aiQaExternal.push(url) } })
  const beforeLink = page.url()
  await report.getByRole('link', { name: '内部管理', exact: true }).click()
  await page.waitForFunction(() => document.hasFocus())
  assert.deepEqual(await application.evaluate(() => globalThis.__aiQaExternal), ['http://192.0.2.75:47831/admin/'])
  assert.equal(page.url(), beforeLink)
  const unsafe = '安全显示检查\n\n<script>window.__aiInjected = true</script>\n\n<img src="http://127.0.0.1:1/leak" onerror="window.__aiInjected = true">\n\n[危险脚本](javascript:alert%281%29) [本地文件](file:///C:/Windows/win.ini) [相对路径](../../settings) [协议路径](//example.com)\n\n![外部图片](http://127.0.0.1:1/image)'
  await task('验证回复内容的显示边界', [done(unsafe)])
  await complete('安全显示检查')
  const safeReport = page.locator('.ai-message-assistant').last()
  assert.equal(await safeReport.locator('script, img, a, iframe').count(), 0)
  assert.equal(await page.evaluate(() => window.__aiInjected), undefined)
  assert.match(await safeReport.innerText(), /危险脚本/)
  assert.match(await safeReport.innerText(), /外部图片/)
  await page.getByLabel('选择 生产 Linux', { exact: true }).uncheck()
  await page.getByLabel('选择 团队 Windows', { exact: true }).check()
  await task('检查 Windows 服务器的基本状态', [body => {
    const names = body.tools.map(item => item.function.name)
    assert(names.includes('inspect_windows') && !names.includes('inspect_linux') && !names.includes('run_ssh'))
    return tool(call('inspect_windows', { server_id: records[1].id, topic: 'system' }), call('inspect_windows', { server_id: records[1].id, topic: 'disks' }))
  }, done('Windows 管理通道当前不可达，需要配置远程 WMI。')])
  await complete('Windows 管理通道当前不可达，需要配置远程 WMI。')
  const failure = page.locator('.ai-activity.is-error summary')
  assert.equal(await failure.count(), 1)
  assert.match(await failure.innerText(), /Windows 管理通道不可达/)
  assert.match(await failure.innerText(), /135/)
  assert.equal((await getState()).pending, null)
  await page.screenshot({ path: path.join(directory, 'windows-management-unavailable.png') })
  for (const body of requests) {
    for (const secret of [password, apiKey, ...records.map(record => record.credentialRef)]) if (secret) assert(!JSON.stringify(body).includes(secret), 'Secret entered AI request')
  }
  await application.close(); application = undefined
  await launch(); await page.getByRole('button', { name: /^AI 助手/ }).click()
  assert.equal((await page.evaluate(() => window.omnidesk.ai.configuration())).data.model, 'qa-ui-model')
  assert.equal((await page.evaluate(() => window.omnidesk.ai.configuration())).data.hasApiKey, true)
  assert((await getState()).messages.length > 0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  if (await page.locator('[data-settings-section="ai"]').getAttribute('open') === null) await page.locator('[data-settings-section="ai"] > summary').click()
  await page.getByRole('region', { name: 'AI 模型配置', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: real Electron IPC/preload AI settings, encrypted key persistence and connectivity test; independent assistant navigation')
  console.log('PASS: target selection, real model tool loop, metadata refresh, real SSH and host-key UI; command approval/rejection/cancellation')
  console.log('PASS: no secrets in model body; dark/light/narrow screenshots, restart persistence and encrypted conversations; no renderer errors')
  console.log('PASS: Windows-only tools, real RPC failure, visible reason in collapsed activity summary, and duplicate query suppression')
  console.log('PASS: Markdown headings/lists/emphasis/code/tables/quotes/tasks, exact reply copy, grouped six-query history, live progress and expandable raw output')
  console.log('PASS: report light/dark/narrow layout, code overflow, HTTP external-link routing; HTML/images/unsafe and relative URLs blocked')
  console.log('PASS: pending approval buttons remain inside the transcript viewport after window resize; expired UI hides all decision buttons')
  console.log('PASS: inline host-key confirmation/cancellation, inline SSH cards and retained outcomes; general confirm/cancel/Escape, skipped metadata after cancel, independent command approval')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await application?.close(); model.closeAllConnections(); for (const peer of peers) peer.end()
  await Promise.all([new Promise(resolve => model.close(resolve)), new Promise(resolve => ssh.close(resolve))])
})
