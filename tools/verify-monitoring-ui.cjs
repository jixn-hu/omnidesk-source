const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const { once } = require('node:events')
const { Server, utils } = require('ssh2')
const { STATUS_CODE } = utils.sftp
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'tmp/monitoring-ui-'))
const adminToken = 'synthetic-admin-token-for-local-fixture-only'
let application, page, proxy, ssh
const errors = [], clients = new Set(), requests = []
let authentications = 0, samples = 0, node, installedConfig
const uploaded = new Map(), installCommands = []
let installations = 0, creations = 0, deletions = 0, probeFailure = true, serviceFailure = false, staleReports = false, deletionFailure = true
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const rawMetrics = () => ({ hostname: 'ssh-fixture', os: 'Ubuntu fixture', kernel: 'qa', arch: 'x86_64', uptime: 86400 * 32, cpu: { usage: 32.5, cores: 2, loadAvg: [0.4, 0.3, 0.2], perCore: [30, 35] }, memory: { total: 4 * 1024 ** 3, used: 2 * 1024 ** 3, available: 2 * 1024 ** 3, free: 1024 ** 3, usagePercent: 50, swapTotal: 1024 ** 3, swapUsed: 0 }, disks: [{ mount: '/', device: '/dev/vda1', fsType: 'ext4', total: 40 * 1024 ** 3, used: 10 * 1024 ** 3, available: 30 * 1024 ** 3, usagePercent: 25 }], network: [{ name: 'eth0', rxBytes: 100000 + samples * 5000, txBytes: 50000 + samples * 2000 }], processes: [{ pid: 42, user: 'qa', cpu: 12, mem: 2, command: 'synthetic-fixture-process' }] })
async function screenshot(name) {
  const image = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(directory, name), Buffer.from(image, 'base64'))
}
async function fixtures() {
  proxy = http.createServer(async (req, res) => {
    requests.push(req.url)
    let body = ''; for await (const chunk of req) body += chunk
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.authorization !== 'Bearer ' + adminToken) { res.writeHead(401); res.end('{}'); return }
    if (req.url === '/healthz') return res.end(JSON.stringify({ service: 'omnidesk-monitor', protocol: 1 }))
    if (req.url === '/v1/alerts') return res.end('[]')
    if (req.url === '/v1/nodes/123456789012345678901234' && req.method === 'DELETE') { if (deletionFailure) { res.writeHead(500); return res.end('{}') }; deletions++; node = undefined; return res.end('{"ok":true}') }
    if (req.url === '/v1/nodes' && req.method === 'POST') {
      creations++
      node = { ...JSON.parse(body), id: '123456789012345678901234', lastSeen: 0, upload: 0, download: 0, periodUpload: 0, periodDownload: 0, periodStart: Date.now() - 86400000, periodEnd: Date.now() + 86400000, coverageStart: Date.now(), incomplete: true }
      return res.end(JSON.stringify({ node, token: 'synthetic-node-token-for-local-fixture-only' }))
    }
    if (req.url === '/v1/nodes/123456789012345678901234' && req.method === 'PUT') { const input = JSON.parse(body); node.name = input.name; node.group = input.group; node.asset = input.asset; return res.end('{"ok":true}') }
    if (req.url === '/v1/nodes') { if (serviceFailure) { res.writeHead(503); return res.end('{}') }; if (installedConfig && node) { node.lastSeen = Math.max(Date.now(), node.lastSeen + 1); if (node.metrics) node.metrics.timestamp = staleReports ? Date.now() - 120000 : Date.now() }; return res.end(JSON.stringify(node ? [node] : [])) }
    if (req.url.includes('/history')) return res.end(JSON.stringify(node?.metrics ? [{ timestamp: node.metrics.timestamp, metrics: node.metrics, upload: 0, download: 0, incomplete: true }] : []))
    res.writeHead(404); res.end('{}')
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  const scriptHash = crypto.createHash('md5').update(fs.readFileSync(path.join(root, 'src/main/assets/scripts/collect.sh'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).digest('hex')
  ssh = new Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => { if (ctx.method === 'password' && ctx.username === 'qa' && ctx.password === 'synthetic-only') { authentications++; ctx.accept() } else ctx.reject(['password']) })
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', allow => allow()); session.on('window-change', allow => allow?.())
      session.on('shell', allow => { const stream = allow(); stream.on('error', () => {}); stream.resume(); stream.write('fixture ready\r\n$ ') })
      session.on('sftp', allow => {
        const stream = allow(), handles = new Map(); let next = 0
        stream.on('OPEN', (id, file, flags, attrs) => { assert.equal(attrs.mode & 0o777, 0o600); const handle = Buffer.from(String(++next)); handles.set(handle.toString(), { file, bytes: Buffer.alloc(0) }); stream.handle(id, handle) })
        stream.on('WRITE', (id, handle, offset, bytes) => { const entry = handles.get(handle.toString()); const buffer = Buffer.alloc(Math.max(entry.bytes.length, offset + bytes.length)); entry.bytes.copy(buffer); bytes.copy(buffer, offset); entry.bytes = buffer; stream.status(id, STATUS_CODE.OK) })
        stream.on('CLOSE', (id, handle) => { const entry = handles.get(handle.toString()); uploaded.set(path.posix.basename(entry.file), entry.bytes); handles.delete(handle.toString()); stream.status(id, STATUS_CODE.OK) })
      })
      session.on('exec', (allow, reject, info) => {
        const command = info.command
        const stream = allow(); stream.on('error', () => {}); stream.resume()
        if (command.includes('OMNIDESK_READY')) { installCommands.push(command); if (probeFailure) { stream.exit(45); stream.end(); return }; stream.write('OMNIDESK_READY\namd64\nroot\nssh-fixture\n'); stream.exit(0); stream.end(); return }
        if (command.includes('cat "$config"')) { installCommands.push(command); if (installedConfig) stream.write(JSON.stringify(installedConfig)); stream.exit(installedConfig ? 0 : 3); stream.end(); return }
        if (/sh '[^']+\/install.sh'/.test(command)) {
          installCommands.push(command)
          const localBinary = fs.readFileSync(path.join(root, 'out/monitor-agent/omnidesk-monitor-agent-linux-amd64'))
          assert.deepEqual(uploaded.get('agent'), localBinary)
          assert.deepEqual(uploaded.get('install.sh'), fs.readFileSync(path.join(root, 'assets/monitor-agent/install.sh')))
          installedConfig = JSON.parse(uploaded.get('agent.json'))
          assert.equal(installedConfig.nodeId, node.id); assert.equal(installedConfig.serverUrl, 'http://127.0.0.1:' + proxy.address().port)
          assert.equal(installedConfig.token, 'synthetic-node-token-for-local-fixture-only')
          const raw = rawMetrics(), timestamp = Date.now()
          node.metrics = { ...raw, discovered: { ip:'8.8.8.8', provider:'Synthetic Cloud', region:'Japan / Tokyo', country:'Japan', city:'Tokyo', timezone:'Asia/Tokyo', asn:'AS64500', source:'ipwho.is', detectedAt:timestamp }, system:{hostname:raw.hostname,os:raw.os,kernel:raw.kernel,arch:raw.arch,uptime:raw.uptime}, connectionId:node.id, timestamp, durationMs:1, cpu:{...raw.cpu,usage:12,steal:1,iowait:0.2}, network:[{name:'eth0',rxBytes:10e9,txBytes:5e9,rxRate:923.0474050505547,txRate:6e5}] }
          node.upload = node.periodUpload = 126e9; node.download = node.periodDownload = 352e9
          installations++; stream.write('OMNIDESK_INSTALL_OK\n'); stream.exit(0); stream.end(); return
        }
        if (command.startsWith('rm -f ')) { installCommands.push(command); uploaded.clear(); stream.exit(0); stream.end(); return }
        if (info.command.startsWith('sh ') && info.command.includes('collect.sh')) { samples++; stream.write(JSON.stringify(rawMetrics())) } else stream.write(info.command === 'uname -s' ? 'Linux\n' : info.command.includes('md5sum') ? scriptHash + '\n' : info.command.includes('OMNIDESK_METRICS') ? 'OMNIDESK_METRICS\n' : ''); stream.exit(0); stream.end() })
    }))
  })
  ssh.listen(0, '127.0.0.1'); await once(ssh, 'listening')
}

async function main() {
  await fixtures()
  const serviceURL = 'http://127.0.0.1:' + proxy.address().port
  const env = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env })
  page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1500, height: 1000 }); BrowserWindow.getAllWindows()[0].focus() })
  await page.getByRole('button', { name: /暂不设置/ }).click()
  assert.equal(await page.locator('.sidebar').getByRole('button', { name: '服务器监控', exact: true }).count(), 0)
  assert.equal(await page.locator('.welcome-directory').count(), 0)
  const saved = await page.evaluate(async ({ port }) => {
    await window.omnidesk.updates.setAutoCheck(false)
    const records = []
    for (const input of [{ kind: 'ssh', name: '香港 SSH 测试节点', port }, { kind: 'rdp', name: '办公桌面', port: 3389 }]) {
      const result = await window.omnidesk.connections.save({ ...input, host: '127.0.0.1', username: 'qa', authMethod: 'password', group: '测试分组' }, { secret: 'synthetic-only' })
      if (!result.ok) throw new Error(result.message)
      records.push(result.data)
    }
    // A legacy SSH monitoring entry must be retained, but never polled or shown.
    const legacy = await window.omnidesk.monitoring.saveEntry({ connectionId: records[0].id, source: 'ssh', asset: { provider: '', region: '', expiresAt: '2099-11-20', price: 0, currency: 'CNY', billingCycle: 'monthly', vendorUrl: '', autoPay: false, trafficLimit: 0, trafficMode: 'sum', resetDay: 1, timezone: 'Asia/Shanghai', initialUpload: 0, initialDownload: 0, initialPeriod: '' } })
    if (!legacy.ok) throw new Error(legacy.message)
    return records
  }, { port: ssh.address().port })
  await page.reload()
  const homeDirectory = kind => page.locator('.welcome-directory').filter({ has: page.getByRole('button', { name: kind === 'ssh' ? /SSH 终端/ : /RDP 桌面/ }) })
  await homeDirectory('ssh').waitFor(); await homeDirectory('rdp').waitFor()
  assert.equal(await page.locator('.welcome-directory').count(), 2)
  await homeDirectory('ssh').locator('.welcome-directory-heading').click()
  assert.equal(await homeDirectory('ssh').locator('.welcome-connection-row').isVisible(), false)
  assert.equal(await homeDirectory('rdp').locator('.welcome-connection-row').isVisible(), true)
  await page.reload(); assert.equal(await homeDirectory('ssh').locator('.welcome-directory-heading').getAttribute('aria-expanded'), 'false')
  await screenshot('01-home-directories.png')
  await page.evaluate(async id => { const result = await window.omnidesk.connections.remove(id); if (!result.ok) throw new Error(result.message) }, saved[1].id)
  await page.reload()
  assert.equal(await homeDirectory('rdp').count(), 0)
  assert.equal(await page.locator('.sidebar-protocol[data-protocol="rdp"]').count(), 0)
  assert.equal(await homeDirectory('ssh').count(), 1)
  await page.evaluate(() => { localStorage.setItem('omnidesk.appearance', JSON.stringify({ sidebarLayout: 'flat' })) })
  await page.reload()
  assert.equal(await page.locator('.sidebar-protocol[data-protocol="ssh"]').count(), 1)
  assert.equal(await page.locator('.sidebar-protocol[data-protocol="rdp"]').count(), 0)
  await page.locator('.sidebar-protocol-heading').click()
  assert.equal(await page.locator('.sidebar .conn-item').count(), 0)
  await page.locator('.sidebar-protocol-heading').click()
  assert.equal(await page.locator('.sidebar .conn-item').count(), 1)
  assert.equal(authentications, 0); assert.equal(samples, 0); assert.equal(requests.length, 0)
  const dashboard = async () => { await page.locator('.sidebar').getByRole('button', { name: '服务器监控', exact: true }).click(); await page.locator('.monitor-dashboard').waitFor() }
  const settings = async () => { await page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }).click(); const section = page.locator('[data-settings-section="monitoring"]'); if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click(); return section }
  let section = await settings()
  await page.getByLabel('监控服务地址', { exact: true }).waitFor()
  assert.equal(await section.getByRole('switch', { name: '显示服务器监控' }).isDisabled(), true)
  await page.getByLabel('监控服务地址', { exact: true }).fill(serviceURL)
  await page.getByLabel('监控服务访问令牌', { exact: true }).fill(adminToken)
  assert.equal(await page.locator('.sidebar').getByRole('button', { name: '服务器监控', exact: true }).count(), 0, 'unsaved URL must not enable navigation')
  await page.getByRole('button', { name: '保存并测试连接' }).click()
  await page.getByText('连接成功，认证与协议正常', { exact: true }).waitFor()
  await screenshot('02-monitor-settings.png')
  await dashboard()
  assert.equal(await page.getByRole('button', { name: '添加 SSH 监控' }).count(), 0)
  assert.equal(await page.locator('.monitor-table tbody tr').count(), 0, 'legacy SSH entry must not be rendered')
  // Connected Linux terminal offers one-click enrollment; no manual node form.
  await page.getByRole('button', { name: '打开连接 香港 SSH 测试节点', exact: true }).click()
  await page.getByRole('button', { name: '信任并记住', exact: true }).click()
  await page.getByRole('button', { name: '加入服务器监控', exact: true }).waitFor()
  assert.equal(samples, 0)
  await page.getByRole('button', { name: '加入服务器监控', exact: true }).click()
  let dialog = page.getByRole('dialog')
  assert.equal(await dialog.getByLabel('采集端目标服务器').inputValue(), saved[0].id)
  assert.equal(await dialog.getByLabel('节点名称', { exact:true }).count(), 0)
  await dialog.getByRole('button', { name: '加入监控并安装', exact:true }).click()
  await dialog.getByRole('alert').filter({hasText:'免密码 sudo'}).waitFor()
  assert.equal(creations,1); assert.equal(installations,0); assert.equal(authentications,1)
  assert.equal(node.name,'香港 SSH 测试节点'); assert.equal(node.group,'测试分组')
  await screenshot('03-enroll-failed-retry.png')
  await dialog.getByRole('button', { name:'关闭采集端安装', exact:true }).click()
  // Closing a failed attempt leaves a permanent, visible installation entry.
  await page.getByRole('button', { name:'查看服务器监控',exact:true }).click()
  await page.getByRole('button', { name:'安装采集端',exact:true }).waitFor()
  await page.getByRole('button', { name:'← 返回总览',exact:true }).click()
  await page.getByRole('button',{name:'列表视图',exact:true}).click()
  const residentRow = () => page.locator('.monitor-table tbody tr').filter({has:page.getByRole('button',{name:'香港 SSH 测试节点',exact:true})})
  await residentRow().getByRole('button',{name:'安装采集端',exact:true}).click()
  dialog=page.getByRole('dialog')
  await page.waitForFunction(() => document.querySelector('[aria-label="采集端目标服务器"]')?.value)
  assert.equal(await dialog.getByLabel('采集端目标服务器').inputValue(),saved[0].id)
  assert.equal(await dialog.getByRole('checkbox').count(),0)
  probeFailure=false
  await dialog.getByRole('button',{name:'安装采集端',exact:true}).click()
  await dialog.getByText('采集端已安装并成功上报，已设置开机自启。',{exact:true}).waitFor()
  assert.equal(creations,1); assert.equal(installations,1); assert.equal(authentications,1,'must reuse terminal SSH session')
  assert(installCommands.every(command=>!command.includes(installedConfig.token)))
  await screenshot('04-enroll-success.png')
  await dialog.getByRole('button',{name:'完成',exact:true}).click()
  // An enrolled terminal reads service metrics and never runs SSH collection, even on errors.
  await page.getByRole('button',{name:'打开连接 香港 SSH 测试节点',exact:true}).click()
  await page.getByRole('button',{name:'查看服务器监控',exact:true}).waitFor()
  await page.getByRole('button',{name:'系统状态',exact:true}).click()
  await page.getByText('后台监控 · 10 秒刷新 · 无 SSH 采样',{exact:true}).waitFor()
  await page.locator('.terminal-system').getByText('ssh-fixture',{exact:true}).waitFor()
  assert.equal(samples,0)
  await screenshot('05-terminal-service-metrics.png')
  serviceFailure=true
  await page.getByRole('button',{name:'刷新系统状态',exact:true}).click()
  await page.getByText('后台监控暂不可用，未启动 SSH 采样',{exact:true}).waitFor()
  assert.equal(samples,0,'service failures must not silently start SSH collection')
  serviceFailure=false; staleReports=true
  await page.getByRole('button',{name:'刷新系统状态',exact:true}).click()
  await page.getByText('后台采集数据已失联，以下保留上次上报',{exact:true}).waitFor()
  assert.equal(samples,0)
  staleReports=false
  await page.getByRole('button',{name:'刷新系统状态',exact:true}).click()
  await page.getByRole('button',{name:'查看服务器监控',exact:true}).click()
  await page.getByRole('button',{name:'编辑资料',exact:true}).click()
  await page.getByLabel('到期日期',{exact:true}).fill('2099-11-20')
  await page.getByLabel('套餐流量（GB，0 表示不限）').fill('1000')
  await page.getByLabel('计费方向').selectOption('up')
  await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click()
  await page.getByText('Synthetic Cloud / Japan / Tokyo',{exact:true}).waitFor()
  await page.getByLabel('历史时间范围').selectOption('24')
  await page.locator('.monitor-chart svg circle').first().waitFor()
  assert.equal(node.asset.expiresAt,'2099-11-20')
  await screenshot('06-node-detail.png')
  // Reopening direct enrollment reuses the same node, including concurrent preparation calls.
  const prepared=await page.evaluate(async id=>Promise.all([window.omnidesk.monitoring.prepareAgentNode(id),window.omnidesk.monitoring.prepareAgentNode(id)]),saved[0].id)
  assert(prepared.every(result=>result.ok&&result.data.id===node.id)); assert.equal(creations,1)
  await page.getByRole('button',{name:'重新安装采集端',exact:true}).click()
  dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:'安装采集端',exact:true}).click()
  await dialog.getByText('采集端已安装并成功上报，已设置开机自启。',{exact:true}).waitFor()
  assert.equal(installations,2);assert.equal(creations,1);assert.equal(authentications,1)
  await dialog.getByRole('button',{name:'完成',exact:true}).click()
  await page.getByRole('button',{name:'删除节点',exact:true}).click()
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(deletions,0);assert(node)
  await page.getByRole('button',{name:'删除节点',exact:true}).click()
  dialog=page.getByRole('dialog')
  await dialog.getByRole('button',{name:'确认删除节点',exact:true}).click()
  await dialog.getByRole('alert').waitFor();assert(node)
  await screenshot('07-delete-error.png')
  deletionFailure=false
  const deletedId=node.id
  await dialog.getByRole('button',{name:'确认删除节点',exact:true}).click()
  await page.getByRole('dialog').waitFor({state:'detached'})
  await page.locator('.monitor-table tbody tr').waitFor({state:'detached'})
  assert.equal(deletions,1)
  const deletedInfo=await page.evaluate(id=>window.omnidesk.monitoring.agentInstallInfo(id),deletedId)
  assert(deletedInfo.ok&&!deletedInfo.data.hasToken&&!deletedInfo.data.connectionId)
  assert((await page.evaluate(()=>window.omnidesk.connections.list())).data.some(item=>item.id===saved[0].id))
  assert(installedConfig,'deleting a node must not silently uninstall VPS software')
  // The monitor list also offers the same SSH picker, without navigating to a creation wizard.
  await page.getByRole('button',{name:'添加监控服务器',exact:true}).click()
  dialog=page.getByRole('dialog')
  await dialog.getByLabel('采集端目标服务器').selectOption(saved[0].id)
  assert.equal(await dialog.getByLabel('节点名称',{exact:true}).count(),0)
  await screenshot('08-list-enrollment.png')
  await dialog.getByRole('button',{name:'完成',exact:true}).click()
  // Legacy nodes remain installable, but replacing an unknown token requires explicit consent.
  node={id:deletedId,name:'旧版未接入节点',group:'',asset:{...prepared[0].data.asset},lastSeen:0,upload:0,download:0,periodUpload:0,periodDownload:0,periodStart:0,periodEnd:0,coverageStart:0,incomplete:true}
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await page.locator('.monitor-table tbody tr').getByRole('button',{name:'安装采集端',exact:true}).click()
  dialog=page.getByRole('dialog')
  await dialog.getByRole('checkbox').waitFor()
  assert.equal(await dialog.getByRole('button',{name:'更换令牌并安装',exact:true}).isDisabled(),true)
  await dialog.getByLabel('采集端目标服务器').selectOption(saved[0].id)
  await dialog.getByRole('checkbox').check()
  assert.equal(await dialog.getByRole('button',{name:'更换令牌并安装',exact:true}).isEnabled(),true)
  await dialog.getByRole('button',{name:'完成',exact:true}).click()
  section=await settings();await section.getByRole('switch',{name:'显示服务器监控'}).click()
  await page.getByText('已隐藏服务器监控入口；远端采集继续运行',{exact:true}).waitFor()
  assert.equal(await page.locator('.sidebar').getByRole('button',{name:'服务器监控',exact:true}).count(),0)
  const count=requests.length
  await delay(300)
  assert.equal(requests.length,count)
  assert(!fs.readFileSync(path.join(directory,'profile/monitoring.json'),'utf8').includes(adminToken))
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({ok:true,checks:['SSH enrollment without manual node creation','failed/closed installation stays accessible in list and detail','saved binding and cached token restore selection','reuse current terminal session; no duplicate nodes','service metrics in terminal, zero SSH samples on success/error/stale data','asset edits after automatic discovery','reinstall without duplicate creation','delete confirmation/cancel/failure/retry and local cleanup','list picker and legacy token confirmation','monitor visibility and protocol folders'],artifacts:directory}))
}

main().catch(error => { console.error(error); if (errors.length) console.error('Renderer errors:', errors); process.exitCode = 1 }).finally(async () => {
  if (page && application && process.exitCode) { try { await screenshot('failure.png') } catch {} }
  if (application) await application.close().catch(() => {})
  for (const client of clients) client.end()
  if (ssh) await new Promise(resolve => ssh.close(resolve))
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }
})
