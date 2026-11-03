const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { _electron } = require('playwright')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-account-address-ui-'))
let requests = 0
const server = createServer((request, response) => {
  requests++
  assert.equal(request.url, '/v1/auth/providers')
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ registrationOpen: false, gitlab: { enabled: false } }))
})
let application
const errors = []
async function launch(fresh) {
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: directory }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [path.resolve('.')]), '--disable-gpu'], env: environment })
  const page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1320, height: 940 }) })
  if (fresh) await page.getByRole('button', { name: /暂不设置/ }).click()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByLabel('官方服务地址', { exact: true }).waitFor({ state: 'attached' })
  return page
}
async function main() {
  server.listen(0, '127.0.0.2')
  await once(server, 'listening')
  const origin = 'http://127.0.0.2:' + server.address().port
  let page = await launch(true)
  const address = page.getByLabel('官方服务地址', { exact: true })
  assert.equal(await address.inputValue(), '')
  assert.equal((await page.evaluate(() => window.omnidesk.account.status())).data.serverUrl, '')
  assert(await page.getByRole('button', { name: '登录账号', exact: true }).isDisabled())
  assert.equal(requests, 0)
  await address.fill(origin)
  await page.getByRole('button', { name: '保存服务地址', exact: true }).click()
  await page.getByText('服务地址已保存；更换服务后需重新登录。', { exact: true }).waitFor()
  await page.getByText('管理员已关闭新账号注册，已有账号仍可登录。', { exact: true }).waitFor()
  assert(await page.getByRole('tab', { name: '注册账号', exact: true }).isDisabled())
  assert.equal((await page.evaluate(() => window.omnidesk.account.status())).data.serverUrl, origin)
  await application.close()
  application = undefined
  page = await launch(false)
  await page.locator('.account-service summary').click()
  assert.equal(await page.getByLabel('官方服务地址', { exact: true }).inputValue(), origin)
  await page.getByLabel('官方服务地址', { exact: true }).fill('')
  await page.getByRole('button', { name: '保存服务地址', exact: true }).click()
  await page.getByText('已清空账号服务地址，本机连接不受影响。', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.omnidesk.account.status())).data.serverUrl, '')
  assert(await page.getByRole('button', { name: '登录账号', exact: true }).isDisabled())
  assert.deepEqual(errors, [])
  console.log('PASS: packaged client blank default address, no default provider requests, explicit non-default-loopback HTTP save, closed-registration UI, restart persistence and clear address')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { await application?.close(); await new Promise(resolve => server.close(resolve)) })
