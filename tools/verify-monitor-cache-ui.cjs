const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { once } = require('node:events'), { _electron } = require('playwright')
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(root, 'tmp/monitor-cache-ui-'))
let application, page, server, otherServer, delayed = false, failed = false, calls = 0, otherCalls = 0
const held = [], heldOther = [], errors = []
const token = 'synthetic-monitor-cache-token-long-enough'
const asset = { provider: 'Cache fixture', region: 'Fixture region', expiresAt: '', price: 0, currency: 'USD', billingCycle: 'monthly', vendorUrl: '', autoPay: false, trafficLimit: 1000e9, trafficMode: 'sum', resetDay: 1, timezone: 'Asia/Shanghai', initialUpload: 0, initialDownload: 0, initialPeriod: '' }
const metrics = () => ({ timestamp: Date.now(), durationMs: 1, connectionId: 'cache-fixture', system: { hostname: 'cache-fixture', os: 'Debian fixture', kernel: 'fixture', arch: 'x86_64', uptime: 86400 }, cpu: { usage: 12, cores: 2, loadAvg: [0, 0, 0], perCore: [10, 14] }, memory: { used: 2 * 1024 ** 3, total: 4 * 1024 ** 3, available: 2 * 1024 ** 3, free: 2 * 1024 ** 3, usagePercent: 50, swapUsed: 0, swapTotal: 0 }, disks: [{ mount: '/', device: '/dev/vda1', fsType: 'ext4', used: 10 * 1024 ** 3, total: 40 * 1024 ** 3, available: 30 * 1024 ** 3, usagePercent: 25 }], network: [{ name: 'eth0', rxBytes: 100e9, txBytes: 50e9, rxRate: 100, txRate: 200 }] })
let node = { id: '1'.repeat(24), name: '缓存与流量测试节点', group: '', asset, metrics: metrics(), lastSeen: Date.now(), upload: 50e9, download: 100e9, periodUpload: 50e9, periodDownload: 100e9, periodStart: Date.now() - 86400000, periodEnd: Date.now() + 86400000, coverageStart: Date.now() - 86400000, incomplete: false }
const card = () => page.getByRole('article', { name: '缓存与流量测试节点监控卡片', exact: true })
const open = async () => { await page.locator('.sidebar, .sidebar-rail').getByRole('button', { name: '服务器监控', exact: true }).click(); await page.locator('.monitor-dashboard').waitFor() }
const away = async () => { await page.locator('.sidebar, .sidebar-rail').getByRole('button', { name: '设置', exact: true }).click(); await page.locator('.settings-page').waitFor() }
const waitFor = async (condition, description) => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw new Error(description) }
const release = queue => { for (const send of queue.splice(0)) send() }
async function main() {
 server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('{}') }
  if (req.url === '/v1/alerts') return res.end('[]')
  if (req.url === '/v1/nodes' && req.method === 'GET') {
   calls++; node.metrics = metrics(); node.lastSeen = Date.now()
   const body = JSON.stringify([node]), status = failed ? 503 : 200
   const send = () => { if (!res.destroyed) { res.writeHead(status); res.end(status === 200 ? body : '{}') } }
   if (delayed) held.push(send); else send(); return
  }
  if (req.url === '/v1/nodes/' + node.id && req.method === 'PUT') {
   const chunks = []; for await (const chunk of req) chunks.push(chunk)
   const body = JSON.parse(Buffer.concat(chunks).toString()); node = { ...node, name: body.name, group: body.group, asset: body.asset }; return res.end('{"ok":true}')
  }
  if (req.url.includes('/history')) return res.end('[]')
  res.writeHead(404); res.end('{}')
 }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
 otherServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/v1/alerts') return res.end('[]')
  if (req.url === '/v1/nodes') { otherCalls++; heldOther.push(() => { if (!res.destroyed) res.end(JSON.stringify([{ ...node, id: '2'.repeat(24), name: '另一个服务的新节点', metrics: metrics() }])) }); return }
  res.writeHead(404); res.end('{}')
 }); otherServer.listen(0, '127.0.0.1'); await once(otherServer, 'listening')
 const url = 'http://127.0.0.1:' + server.address().port, otherURL = 'http://127.0.0.1:' + otherServer.address().port
 const env = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
 application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env })
 page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
 await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1420, height: 1000 }))
 await page.getByRole('button', { name: /暂不设置/ }).click()
 await page.evaluate(async ({ url, token }) => { await window.omnidesk.updates.setAutoCheck(false); const r = await window.omnidesk.monitoring.configure({ enabled: true, url, token }); if (!r.ok) throw new Error(r.message); window.dispatchEvent(new Event('omnidesk:monitoring-changed')) }, { url, token })
 await open(); await card().waitFor()
 assert.match(await card().innerText(), /已用 150 GB\s*\/ 总量 1000 GB/)
 assert.match(await card().innerText(), /2 GB \/ 4 GB/)
 assert.equal(await card().locator('.monitor-period .monitor-resource-track > span').evaluate(el => el.style.width), '15%')
 // Editing 1000 must round-trip as 1000e9 bytes; no balance subtraction or 1024 conversion.
 await card().getByRole('button', { name: '编辑', exact: true }).click()
 await page.getByLabel('套餐流量（GB，0 表示不限）').fill('1000')
 await page.locator('.monitor-editor').getByRole('button', { name: '保存', exact: true }).click()
 await page.locator('.monitor-editor').waitFor({ state: 'hidden' }); await page.getByRole('button', { name: '刷新', exact: true }).waitFor()
 assert.equal(node.asset.trafficLimit, 1000e9)
 await page.getByRole('button', { name: '列表视图', exact: true }).click()
 assert.match(await page.locator('.monitor-node-table').innerText(), /已用 150 GB\s*\/ 总量 1000 GB/)
 await page.getByRole('button', { name: '缓存与流量测试节点', exact: true }).click()
 assert.match(await page.locator('.monitor-traffic').innerText(), /150 GB \/ 1000 GB/)
 assert.match(await page.locator('.monitor-traffic').innerText(), /今日上传/)
 await page.getByRole('button', { name: '← 返回总览', exact: true }).click()
 await page.getByRole('button', { name: '卡片视图', exact: true }).click()
 await away(); delayed = true; node.periodDownload = 150e9
 await open(); await waitFor(() => held.length === 1, 'Expected delayed refresh')
 assert.match(await card().innerText(), /已用 150 GB\s*\/ 总量 1000 GB/, 'warm cache must render before the network completes')
 assert.equal(await page.getByText('正在读取监控…', { exact: true }).count(), 0)
 await page.getByText('后台更新中 · 显示上次数据', { exact: true }).waitFor()
 const sharedCalls = calls
 await away(); await open(); assert.equal(calls, sharedCalls, 'quick page re-entry must share pending refresh')
 assert.match(await card().innerText(), /已用 150 GB/)
 await page.screenshot({ path: path.join(directory, '01-warm-cache-pending.png') })
 release(held)
 await page.waitForFunction(() => document.querySelector('.monitor-period-heading')?.textContent.includes('已用 200 GB'))
 assert.match(await card().innerText(), /总量 1000 GB/)
 assert.equal(await card().locator('.monitor-period .monitor-resource-track > span').evaluate(el => el.style.width), '20%')
 await page.screenshot({ path: path.join(directory, '02-background-updated.png') })
 // Fail a refresh: keep the previous nodes and total, show the error without switching to empty/loading.
 await away(); failed = true; await open(); await waitFor(() => held.length === 1, 'Expected failing refresh')
 assert.match(await card().innerText(), /已用 200 GB/); release(held)
 await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor(); assert.equal(await card().count(), 1)
 assert.match(await card().innerText(), /总量 1000 GB/)
 // Switch configuration while an old response is pending; the old cache/response must not leak into the new service.
 failed = false; await away(); await open(); await waitFor(() => held.length === 1, 'Expected old service request')
 await away()
 await page.evaluate(async ({ url, token }) => { const r = await window.omnidesk.monitoring.configure({ enabled: true, url, token }); if (!r.ok) throw new Error(r.message); window.dispatchEvent(new Event('omnidesk:monitoring-changed')) }, { url: otherURL, token })
 await open(); await waitFor(() => otherCalls === 1, 'Expected new service request')
 assert.equal(await card().count(), 0, 'another service must never show the prior cached nodes')
 release(held); release(heldOther)
 await page.getByRole('article', { name: '另一个服务的新节点监控卡片', exact: true }).waitFor()
 assert.equal(await card().count(), 0)
 assert.deepEqual(errors, [])
 assert(!await page.evaluate(() => Object.values(localStorage).some(value => value.includes('缓存与流量测试节点'))), 'node data should remain in memory rather than localStorage')
 console.log('PASS: decimal 1000 GB edit/card/list/detail, used/total and percentages, RAM units unchanged, immediate warm cache with blocked network, shared in-flight refresh, background update/failure, endpoint invalidation and stale response isolation')
 console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { release(held); release(heldOther); if (page && process.exitCode) try { await page.screenshot({ path: path.join(directory, 'failure.png') }) } catch {}; await application?.close(); server?.closeAllConnections(); otherServer?.closeAllConnections(); await Promise.all([server, otherServer].filter(Boolean).map(s => new Promise(resolve => s.close(resolve)))) })
