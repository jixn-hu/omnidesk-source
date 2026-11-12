const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/monitoring-transport-'))
const token = 'synthetic-monitor-cache-regression-only'
let application, server, destination, mode = 'redirect', forwarded = 0
const requests = []
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
async function main() {
  destination = http.createServer((req, res) => { forwarded++; res.end('unexpected redirect target') })
  await listen(destination)
  server = http.createServer((req, res) => {
    requests.push({ path: req.url, authenticated: req.headers.authorization === 'Bearer ' + token })
    if (mode === 'redirect') {
      res.writeHead(301, { Location: `http://127.0.0.1:${server.address().port}${req.url}`, 'Content-Type': 'text/html' })
      return res.end('old HTTP-to-HTTPS origin redirect')
    }
    res.setHeader('Cache-Control', 'no-store')
    if (mode === 'cross-redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/must-not-receive-token` })
      return res.end('redirect')
    }
    if (mode === 'unauthorized') { res.writeHead(401); return res.end('{"error":"unauthorized"}') }
    if (mode === 'html') { res.setHeader('Content-Type', 'text/html'); return res.end('<html>wrong upstream</html>') }
    res.setHeader('Content-Type', 'application/json')
    res.end(req.url === '/healthz' ? '{"protocol":1,"service":"omnidesk-monitor"}' : '[]')
  })
  await listen(server)
  const url = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, OMNIDESK_USER_DATA_DIR: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [root]), '--disable-gpu'], env })
  const page = await application.firstWindow(); page.setDefaultTimeout(20000)
  await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.evaluate(async ({ url, token }) => {
    await window.omnidesk.updates.setAutoCheck(false)
    const saved = await window.omnidesk.monitoring.configure({ enabled: true, url, token })
    if (!saved.ok) throw new Error(saved.message)
  }, { url, token })
  const oldRequest = () => application.evaluate(async ({ net }, { url, token }) => {
    try {
      const response = await net.fetch(url + '/v1/nodes', { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, redirect: 'error' })
      return { status: response.status }
    } catch (error) { return { error: error.message } }
  }, { url, token })
  const first = await oldRequest(); assert.match(first.error, /redirect/i)
  assert.equal(requests.length, 1)
  mode = 'ok'
  const cached = await oldRequest(); assert.match(cached.error, /redirect/i)
  assert.equal(requests.length, 1, 'Old request must reproduce a redirect retained in the running Chromium session')
  const test = () => page.evaluate(() => window.omnidesk.monitoring.test())
  const recovered = await test(); assert.equal(recovered.ok, true, JSON.stringify(recovered))
  assert.equal(recovered.data.service, 'omnidesk-monitor')
  assert.equal(requests.length, 3, 'Fixed API must reach the repaired origin for nodes and health')
  assert(requests.every(item => item.authenticated))
  mode = 'cross-redirect'
  const redirect = await test(); assert.equal(redirect.ok, false); assert.match(redirect.message, /重定向/)
  assert.equal(forwarded, 0, 'Authorization must never be forwarded to a redirect target')
  mode = 'unauthorized'
  const unauthorized = await test(); assert.equal(unauthorized.ok, false); assert.match(unauthorized.message, /认证失败/)
  mode = 'html'
  const html = await test(); assert.equal(html.ok, false); assert.match(html.message, /无效 JSON/)
  for (const result of [redirect, unauthorized, html]) assert(!JSON.stringify(result).includes(token))
  const result = { ok: true, reproduced: 'Chromium retains the old redirect after origin repair', recovered, redirect, unauthorized, html, forwarded, requests }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2))
  console.log('PASS running Chromium redirect cache reproduced; fixed API recovers without restart, blocks cross-origin credential forwarding, distinguishes redirect/auth/invalid JSON')
  console.log('Artifacts: ' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (application) await application.close()
  for (const item of [server, destination]) if (item) await new Promise(resolve => item.close(resolve))
})