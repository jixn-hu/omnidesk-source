const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { Server, utils } = require('ssh2')
const { _electron } = require('playwright')
const { OPEN_MODE, STATUS_CODE } = utils.sftp
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'docs/同事介绍/images')
fs.mkdirSync(output, { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'tmp/colleague-guide-'))
const remoteRoot = path.join(directory, 'remote'); fs.mkdirSync(remoteRoot)
for (const folder of ['apps', 'backups', 'logs', 'scripts']) fs.mkdirSync(path.join(remoteRoot, folder))
fs.writeFileSync(path.join(remoteRoot, 'README.md'), '# 应用服务\n\n这是 OmniDesk 界面介绍使用的演示目录。\n')
fs.writeFileSync(path.join(remoteRoot, 'nginx.conf'), 'server {\n  listen 80;\n  server_name app.demo.local;\n}\n')
fs.writeFileSync(path.join(remoteRoot, 'release-notes.txt'), '2026-11-03 演示版本\n连接、文件管理、监控与 AI 协作。\n')
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const scriptHash = crypto.createHash('md5').update(fs.readFileSync(path.join(root, 'src/main/assets/scripts/collect.sh'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).digest('hex')
const clients = new Set(), errors = []
let application, page, samples = 0, serial = 0
function sftpSession(stream, root) {
  const handles = new Map()
  let nextHandle = 0
  const local = remote => {
    const resolved = path.resolve(root, '.' + path.posix.normalize('/' + remote))
    assert(resolved === root || resolved.startsWith(root + path.sep))
    return resolved
  }
  const attrs = stat => ({ mode: stat.isDirectory() ? 0o040755 : 0o100644, size: stat.size, uid: 1000, gid: 1000, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) })
  const status = (request, operation) => { try { operation(); stream.status(request, STATUS_CODE.OK) } catch (error) { stream.status(request, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE) } }
  const handle = (request, value) => { const token = Buffer.alloc(4); token.writeUInt32BE(++nextHandle); handles.set(token.toString('hex'), value); stream.handle(request, token) }
  stream.on('REALPATH', (request, remote) => stream.name(request, [{ filename: path.posix.resolve('/', remote), longname: '', attrs: {} }]))
  for (const operation of ['STAT', 'LSTAT']) stream.on(operation, (request, remote) => { try { stream.attrs(request, attrs(fs.statSync(local(remote)))) } catch { stream.status(request, STATUS_CODE.NO_SUCH_FILE) } })
  stream.on('FSTAT', (request, token) => { try { stream.attrs(request, attrs(fs.fstatSync(handles.get(token.toString('hex')).descriptor))) } catch { stream.status(request, STATUS_CODE.FAILURE) } })
  stream.on('OPENDIR', (request, remote) => { try { const target = local(remote); handle(request, { directory: target, names: fs.readdirSync(target) }) } catch { stream.status(request, STATUS_CODE.NO_SUCH_FILE) } })
  stream.on('READDIR', (request, token) => {
    const entry = handles.get(token.toString('hex'))
    if (!entry?.names?.length) return stream.status(request, STATUS_CODE.EOF)
    stream.name(request, entry.names.splice(0).map(filename => ({ filename, longname: filename, attrs: attrs(fs.statSync(path.join(entry.directory, filename))) })))
  })
  stream.on('OPEN', (request, remote, flags) => { try {
    if (remote.endsWith('/readonly.txt') && flags & OPEN_MODE.WRITE) { stream.status(request, STATUS_CODE.PERMISSION_DENIED); return }
    handle(request, { descriptor: fs.openSync(local(remote), flags & OPEN_MODE.WRITE ? flags & OPEN_MODE.EXCL ? 'wx' : flags & OPEN_MODE.APPEND ? 'a' : 'w' : 'r') })
  } catch { stream.status(request, STATUS_CODE.FAILURE) } })
  stream.on('READ', (request, token, offset, length) => { try { const data = Buffer.alloc(length); const count = fs.readSync(handles.get(token.toString('hex')).descriptor, data, 0, length, offset); if (count) stream.data(request, data.subarray(0, count)); else stream.status(request, STATUS_CODE.EOF) } catch { stream.status(request, STATUS_CODE.FAILURE) } })
  stream.on('WRITE', (request, token, offset, data) => status(request, () => fs.writeSync(handles.get(token.toString('hex')).descriptor, data, 0, data.length, offset)))
  stream.on('CLOSE', (request, token) => status(request, () => { const entry = handles.get(token.toString('hex')); if (entry?.descriptor !== undefined) fs.closeSync(entry.descriptor); handles.delete(token.toString('hex')) }))
  stream.on('MKDIR', (request, remote) => status(request, () => fs.mkdirSync(local(remote))))
  stream.on('RMDIR', (request, remote) => status(request, () => fs.rmdirSync(local(remote))))
  stream.on('REMOVE', (request, remote) => status(request, () => fs.unlinkSync(local(remote))))
  stream.on('RENAME', (request, from, to) => status(request, () => fs.renameSync(local(from), local(to))))
  stream.on('close', () => { for (const entry of handles.values()) if (entry.descriptor !== undefined) try { fs.closeSync(entry.descriptor) } catch {} })
}

const rawMetrics = () => ({ hostname: 'app-prod-01', os: 'Ubuntu 24.04 LTS', arch: 'x86_64', kernel: '6.8.0-demo', uptime: 532800,
  cpu: { usage: 18.4, cores: 8, loadAvg: [0.48, 0.36, 0.31], perCore: [14, 22, 16, 20, 18, 15, 24, 18] },
  memory: { total: 16 * 1024 ** 3, used: 5.6 * 1024 ** 3, available: 10.4 * 1024 ** 3, free: 8.2 * 1024 ** 3, usagePercent: 35, swapTotal: 2 * 1024 ** 3, swapUsed: 0 },
  disks: [{ mount: '/', device: '/dev/vda1', fsType: 'ext4', total: 100 * 1024 ** 3, used: 38 * 1024 ** 3, available: 62 * 1024 ** 3, usagePercent: 38 }],
  network: [{ name: 'eth0', rxBytes: 10000000 + samples * 200000, txBytes: 3000000 + samples * 80000 }] })
const ssh = new Server({ hostKeys: [key] }, client => {
  clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
  client.on('authentication', context => context.method === 'password' && context.username === 'ops' && context.password === 'demo-password-only' ? context.accept() : context.reject(['password']))
  client.on('ready', () => client.on('session', accept => {
    const session = accept()
    session.on('pty', allow => allow())
    session.on('window-change', allow => allow?.())
    session.on('shell', allow => {
      const stream = allow(); stream.on('error', () => {})
      const prompt = '\x1b[38;5;79mops@app-prod-01\x1b[0m:\x1b[38;5;111m~\x1b[0m$ '
      stream.write('\x1b[2J\x1b[HWelcome to Ubuntu 24.04 LTS  |  OmniDesk 演示环境\r\n\r\n' + prompt)
      let command = ''
      stream.on('data', data => {
        for (const char of data.toString()) {
          if (char === '\r' || char === '\n') {
            stream.write('\r\n')
            if (command.trim() === 'hostnamectl') stream.write(' Static hostname: app-prod-01\r\n Operating System: Ubuntu 24.04 LTS\r\n          Kernel: Linux 6.8.0\r\n    Architecture: x86-64\r\n')
            else if (command.trim() === 'df -h') stream.write('Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/vda1       100G   38G   62G  38% /\r\n/dev/vdb1       200G   54G  146G  27% /data\r\n')
            else if (command.trim() === 'systemctl status nginx --no-pager') stream.write('\x1b[38;5;79m● nginx.service - A high performance web server\x1b[0m\r\n   Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\r\n   Active: \x1b[38;5;79mactive (running)\x1b[0m since Mon 2026-11-02 09:00:00 CST\r\n   Memory: 12.4M\r\n      CPU: 1.210s\r\n')
            command = ''; stream.write('\r\n' + prompt)
          } else if (char === '\x7f') { command = command.slice(0, -1); stream.write('\b \b') }
          else if (char >= ' ') { command += char; stream.write(char) }
        }
      })
    })
    session.on('sftp', allow => sftpSession(allow(), remoteRoot))
    session.on('exec', (allow, reject, info) => {
      const stream = allow(); stream.on('error', () => {}); stream.resume()
      if (info.command.startsWith('sh ') && info.command.includes('collect.sh')) { samples++; stream.write(JSON.stringify(rawMetrics())) }
      else stream.write(info.command === 'uname -s' ? 'Linux\n' : info.command.includes('md5sum') ? scriptHash + '\n' : info.command.includes('OMNIDESK_METRICS') ? 'OMNIDESK_METRICS\n' : info.command.trim() === 'pwd' ? '/\n' : '')
      stream.exit(0); stream.end()
    })
  }))
})
const model = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    let message
    if (body.messages.at(-1).role === 'user') message = { role: 'assistant', content: null, tool_calls: [{ id: 'demo_' + ++serial, type: 'function', function: { name: 'list_servers', arguments: JSON.stringify({ limit: 100 }) } }] }
    else message = { role: 'assistant', content: '已按环境整理当前 **7 台服务器**：**5 台 Linux SSH、2 台 Windows RDP**。\n\n| 环境 | 数量 | 主要用途 |\n| --- | ---: | --- |\n| 生产环境 | 3 | 应用服务、数据库、Windows 业务桌面 |\n| 测试环境 | 2 | Web 联调与 Windows 验证 |\n| 基础设施 | 2 | 运维跳板与团队文档 |\n\n### 日常管理建议\n\n- 用 **分组** 区分环境，用 **标签** 标记业务和负责人。\n- Linux 维护时，在 SSH 会话右侧打开文件管理或系统状态。\n- 需要修改资料时切换编辑权限；自定义命令会单独请求确认。\n\n本次仅整理本机服务器资料，未连接这些服务器或修改配置。' }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message }] }))
  } catch (error) { errors.push(error.message); response.writeHead(500); response.end('Demo model error') }
})
async function api(service, method, ...args) {
  return page.evaluate(async ({ service, method, args }) => { const result = await window.omnidesk[service][method](...args); if (!result.ok) throw new Error(result.message); return result.data }, { service, method, args })
}
async function shot(name) {
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(8, 8)
  await page.waitForTimeout(180)
  await page.screenshot({ path: path.join(output, name) })
  console.log('Captured ' + name)
}
async function settings(id) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const section = page.locator(`[data-settings-section="${id}"]`)
  if (!await section.evaluate(element => element.open)) await section.locator(':scope > summary').click()
  await section.scrollIntoViewIfNeeded()
}
async function main() {
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening')
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const env = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: require('electron'), args: [root, '--disable-gpu'], env })
  page = await application.firstWindow(); page.setDefaultTimeout(18000)
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 })
    ipcMain.removeHandler('metrics:probe')
    ipcMain.handle('metrics:probe', () => ({ ok: true, data: { latencyMs: 8, timestamp: Date.now() } }))
  })
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await api('updates', 'setAutoCheck', false)
  const linux = await api('shared', 'save', { name: 'Linux 运维账号', kind: 'password', username: 'ops', secret: 'demo-password-only', note: '演示用公共凭据；多台 Linux 可复用' })
  const windows = await api('shared', 'save', { name: 'Windows 管理账号', kind: 'password', username: 'Administrator', secret: 'demo-windows-only', note: '演示用公共凭据；用于 Windows 桌面' })
  const inputs = [
    { kind: 'ssh', name: '生产应用 · app-prod-01', host: '127.0.0.1', port: ssh.address().port, group: '公司 / 生产环境 / 应用服务', tags: ['生产', 'Web'], note: '业务应用与反向代理；负责人：应用组' },
    { kind: 'ssh', name: '生产数据库 · db-prod-01', host: '192.0.2.11', group: '公司 / 生产环境 / 数据库', tags: ['生产', '数据库'], note: '演示数据库连接资料' },
    { kind: 'rdp', name: '业务桌面 · win-prod-01', host: '192.0.2.20', group: '公司 / 生产环境 / Windows', tags: ['生产', 'Windows'], note: 'Windows 业务运维桌面' },
    { kind: 'ssh', name: '联调服务 · web-test-01', host: '192.0.2.31', group: '公司 / 测试环境', tags: ['测试', 'Web'], note: '接口联调与功能验证' },
    { kind: 'rdp', name: '测试桌面 · win-test-01', host: '192.0.2.32', group: '公司 / 测试环境', tags: ['测试', 'Windows'], note: 'Windows 测试与回归验证' },
    { kind: 'ssh', name: '运维跳板 · jump-01', host: '192.0.2.41', group: '公司 / 基础设施', tags: ['运维', '跳板'], note: '演示运维入口' },
    { kind: 'ssh', name: '团队文档 · docs-01', host: '192.0.2.42', group: '公司 / 基础设施', tags: ['内部服务', '文档'], note: '团队知识库' }
  ]
  const records = []
  for (const input of inputs) records.push(await api('connections', 'save', { ...input, port: input.port ?? (input.kind === 'ssh' ? 22 : 3389), username: input.kind === 'ssh' ? 'ops' : 'Administrator', sharedCredentialId: input.kind === 'ssh' ? linux.id : windows.id, ...(input.kind === 'ssh' ? { authMethod: 'password' } : { options: { performanceMode: 'balanced', enableClipboard: true } }) }))
  await page.evaluate(() => { localStorage.setItem('omnidesk.appearance', JSON.stringify({ theme: 'light', uiScale: 100, terminalFontSize: 15 })); localStorage.setItem('omnidesk.sidebar.width', '264') })
  await page.reload()
  await page.getByRole('button', { name: /^服务器管理/ }).first().click()
  await page.getByRole('heading', { name: '服务器管理', exact: true }).waitFor()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1120 }))
  await shot('01-servers.png')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }))

  await page.locator('.workspace-header').getByRole('button', { name: '新建连接', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新建连接', exact: true })
  await editor.getByRole('button', { name: 'RDP · Windows', exact: true }).click()
  await editor.getByLabel('连接名称', { exact: true }).fill('办公 Windows · 新连接')
  await editor.getByLabel('主机地址', { exact: true }).fill('192.0.2.60')
  await editor.getByLabel('用户名', { exact: true }).fill('Administrator')
  await editor.getByPlaceholder('生产环境', { exact: true }).fill('公司 / 办公环境')
  await shot('02-new-rdp.png')
  await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click()

  await page.locator('.sidebar').getByRole('button', { name: '打开连接 ' + records[0].name, exact: true }).click()
  await page.getByRole('button', { name: '信任并记住', exact: true }).click()
  const terminal = page.locator('.terminal-workspace:visible')
  await terminal.locator('.xterm-rows').filter({ hasText: '演示环境' }).waitFor()
  await terminal.locator('.xterm-helper-textarea').focus()
  for (const command of ['hostnamectl', 'df -h', 'systemctl status nginx --no-pager']) { await page.keyboard.type(command); await page.keyboard.press('Enter') }
  await terminal.locator('.xterm-rows').filter({ hasText: 'active (running)' }).waitFor()
  const tools = terminal.getByRole('complementary', { name: 'SSH 会话工具', exact: true })
  await tools.getByRole('button', { name: '文件管理', exact: true }).click()
  await tools.getByText('nginx.conf', { exact: true }).waitFor()
  await shot('03-ssh-files.png')
  await tools.getByRole('button', { name: '系统状态', exact: true }).click()
  await tools.getByRole('meter', { name: 'CPU', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.terminal-sidebar [aria-label="CPU"]')?.getAttribute('aria-valuenow') === '18.4')
  await page.waitForFunction(() => !document.querySelector('.terminal-sidebar')?.textContent.includes('采样中'))
  await shot('04-ssh-status.png')

  await page.locator('.sidebar-footer').getByRole('button', { name: /^公共凭据/ }).click()
  await page.getByRole('heading', { name: '公共凭据', exact: true }).waitFor()
  await page.getByText('Linux 运维账号', { exact: true }).waitFor()
  await shot('05-credentials.png')

  await api('ai', 'saveConfiguration', { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: '团队演示模型', maxModelCalls: 200, permissionMode: 'read' })
  await page.getByRole('button', { name: /^AI 助手/ }).click()
  const task = page.getByLabel('AI 任务', { exact: true })
  await task.fill('请按环境整理当前服务器清单，并给出管理建议。')
  await task.press('Enter')
  await page.locator('.ai-message-assistant').filter({ hasText: '7 台服务器' }).waitFor()
  await page.getByText('准备就绪', { exact: true }).waitFor()
  await page.locator('.ai-transcript').evaluate(element => { element.scrollTop = 0 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1120 }))
  await shot('06-ai-assistant.png')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 1000 }))

  await settings('appearance')
  await page.getByText('连接目录样式', { exact: true }).scrollIntoViewIfNeeded()
  await shot('07-appearance.png')
  await page.getByRole('radio', { name: /^标签分类/ }).check()
  for (const name of ['登录账号', '标签', '备注']) await page.getByRole('checkbox', { name, exact: true }).check()
  await shot('09-tags-directory.png')
  await page.getByRole('radio', { name: /^树状目录/ }).check()
  const appearance = page.locator('[data-settings-section="appearance"]')
  await appearance.locator('summary').click()
  await settings('backup')
  await shot('08-backup.png')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(directory, 'capture-info.json'), JSON.stringify({ capturedAt: new Date().toISOString(), output, syntheticProfile: directory, images: fs.readdirSync(output).filter(name => name.endsWith('.png')), rendererErrors: errors }, null, 2), 'utf8')
  console.log('OUTPUT_DIRECTORY=' + output)
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await application?.close()
  for (const client of clients) client.end()
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  await new Promise(resolve => ssh.close(resolve))
})
