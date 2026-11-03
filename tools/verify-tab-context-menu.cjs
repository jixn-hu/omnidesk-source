const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/tab-context-menu-qa-'))
require('esbuild').buildSync({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client'
      import TabBar from './src/renderer/src/components/TabBar'
      import { useApp } from './src/renderer/src/store/app'
      import './src/renderer/src/styles/design-system.css'
      import './src/renderer/src/styles/app.css'
      import './src/renderer/src/styles/workspace.css'
      window.calls = { disconnect: [], release: [] }
      window.omnidesk = {
        ssh: { disconnect: async id => { window.calls.disconnect.push(id); return { ok: true, data: true } } },
        account: { release: async id => { window.calls.release.push(id); return { ok: true, data: true } } }
      }
      window.qaApp = useApp
      createRoot(document.getElementById('root')).render(<TabBar />)
    `,
    loader: 'tsx', resolveDir: root
  },
  bundle: true, platform: 'browser', jsx: 'automatic', outfile: path.join(directory, 'fixture.js'),
  alias: { '@shared': path.join(root, 'src/shared') }
})
fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="UTF-8"><link rel="stylesheet" href="./fixture.css"><div id="root"></div><script src="./fixture.js"></script></html>')
let browser
let page
const errors = []
const tab = (id, kind = 'rdp', status = 'connected', extra = {}) => ({ id, kind, status, title: id, ...extra })
const menu = () => page.getByRole('menu', { name: '服务器窗口操作', exact: true })
const item = label => menu().getByRole('menuitem', { name: label, exact: true })
const ids = () => page.evaluate(() => window.qaApp.getState().tabs.map(tab => tab.id))
const active = () => page.evaluate(() => window.qaApp.getState().activeTabId)
async function seed(tabs, activeTabId = tabs.at(-1)?.id ?? null, sessions = []) {
  await page.keyboard.press('Escape')
  await page.evaluate(({ tabs, activeTabId, sessions }) => {
    window.calls = { disconnect: [], release: [] }
    window.qaApp.setState({ tabs, activeTabId, sessions })
  }, { tabs, activeTabId, sessions })
  await page.waitForFunction(count => document.querySelectorAll('[role=tab]').length === count, tabs.length)
}
async function open(id) {
  await page.getByRole('tab').filter({ has: page.locator('.tab-title', { hasText: new RegExp(`^${id}$`) }) }).click({ button: 'right' })
  await menu().waitFor()
}
async function main() {
  browser = await chromium.launch({ headless: true, ...(process.env.OMNIDESK_QA_BROWSER_CHANNEL ? { channel: process.env.OMNIDESK_QA_BROWSER_CHANNEL } : {}) })
  page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(path.join(directory, 'index.html')).href)
  await page.waitForLoadState('networkidle')

  await seed([tab('one'), tab('two'), tab('three')])
  await open('one')
  assert.equal(await active(), 'three', 'right-clicking another tab must preserve the active window')
  await item('关闭当前窗口').click()
  assert.deepEqual(await ids(), ['two', 'three'])
  assert.equal(await active(), 'three')
  await seed([tab('one'), tab('two'), tab('three')], 'one')
  await open('two')
  await item('关闭其他窗口').click()
  assert.deepEqual(await ids(), ['two'])
  assert.equal(await active(), 'two')
  await seed([tab('one'), tab('two'), tab('three')])
  await open('two')
  await item('关闭右侧窗口').click()
  assert.deepEqual(await ids(), ['one', 'two'])
  assert.equal(await active(), 'two')
  await open('two')
  assert(await item('关闭右侧窗口').isDisabled())
  console.log('PASS current/other/right window actions use the clicked tab and keep a valid active tab')

  await seed([
    tab('ssh-connected', 'ssh', 'connected', { sessionId: 'live-ssh' }),
    tab('ssh-pending', 'ssh', 'connecting'),
    tab('ssh-closed', 'ssh', 'idle'),
    tab('ssh-error', 'ssh', 'error'),
    tab('stale-connected', 'ssh', 'connected', { sessionId: 'closed-ssh' }),
    tab('stale-error', 'ssh', 'error', { sessionId: 'reconnecting-ssh' }),
    tab('rdp-connected'), tab('rdp-pending', 'rdp', 'connecting'),
    tab('rdp-closed', 'rdp', 'idle'), tab('rdp-error', 'rdp', 'error'),
    tab('shared-closed', 'shared-session', 'error', { sessionId: 'closed-share' }),
    tab('shared-live', 'shared-session'), tab('settings', 'settings', 'idle'),
    tab('files', 'files', 'idle')
  ], 'ssh-connected', [
    { id: 'live-ssh', status: 'connected' },
    { id: 'closed-ssh', status: 'disconnected' },
    { id: 'reconnecting-ssh', status: 'connecting' }
  ])
  await open('ssh-connected')
  await item('关闭已断开连接的服务器').click()
  assert.deepEqual(await ids(), ['ssh-connected', 'ssh-pending', 'stale-error', 'rdp-connected', 'rdp-pending', 'shared-live', 'settings', 'files'])
  assert.equal(await active(), 'ssh-connected')
  assert.deepEqual(await page.evaluate(() => window.calls), { disconnect: ['closed-ssh'], release: ['closed-share'] })
  await open('ssh-connected')
  assert(await item('关闭已断开连接的服务器').isDisabled())
  await page.evaluate(() => window.qaApp.getState().updateTab('rdp-connected', { status: 'error' }))
  await page.waitForFunction(() => [...document.querySelectorAll('[role=menuitem]')].some(button => button.textContent === '关闭已断开连接的服务器' && !button.disabled))
  await item('关闭已断开连接的服务器').click()
  assert(!(await ids()).includes('rdp-connected'))
  console.log('PASS disconnected filtering covers SSH/RDP/shared failures, respects current session state, and keeps live/pending/management windows')

  await seed([
    tab('ssh', 'ssh', 'connected', { sessionId: 'ssh-session' }),
    tab('ssh-pending', 'ssh', 'connecting'), tab('desktop'),
    tab('share', 'shared-session', 'connected', { sessionId: 'share-session' }),
    tab('settings', 'settings', 'idle')
  ], 'desktop', [{ id: 'pending-session', ownerId: 'ssh-pending', status: 'connecting' }])
  await open('desktop')
  await item('关闭所有窗口').click()
  assert.deepEqual(await ids(), [])
  assert.equal(await active(), null)
  assert.deepEqual(await page.evaluate(() => window.calls), { disconnect: ['ssh-session', 'pending-session'], release: ['share-session'] })
  await page.locator('.tabbar').click({ button: 'right' })
  assert(await item('关闭所有窗口').isDisabled())
  assert(await item('关闭已断开连接的服务器').isDisabled())
  await page.keyboard.press('Escape')
  console.log('PASS close-all releases SSH, pending SSH, and shared sessions and returns to an empty workspace')

  await seed([tab('keyboard')])
  const keyboardTab = page.getByRole('tab')
  await keyboardTab.focus()
  await page.keyboard.press('Shift+F10')
  await menu().waitFor()
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '关闭所有窗口', 'keyboard navigation must skip disabled actions')
  await page.keyboard.press('Escape')
  await menu().waitFor({ state: 'hidden' })
  assert(await keyboardTab.evaluate(element => element === document.activeElement))
  await open('keyboard')
  await page.mouse.click(20, 300)
  await menu().waitFor({ state: 'hidden' })
  await page.locator('.tabbar').click({ button: 'right', position: { x: 700, y: 10 } })
  assert.equal(await menu().getByRole('menuitem').count(), 2)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 480, height: 320 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await keyboardTab.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 1, clientY: innerHeight - 1 })))
  const bounds = await menu().evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight } })
  assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, JSON.stringify(bounds))
  await page.screenshot({ path: path.join(directory, 'light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: path.join(directory, 'dark.png') })
  await page.setViewportSize({ width: 500, height: 340 })
  await menu().waitFor({ state: 'hidden' })
  await open('keyboard')
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
  await menu().waitFor({ state: 'hidden' })
  await open('keyboard')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await menu().waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  console.log('PASS keyboard access, disabled actions, focus restoration, outside/resize/scroll/blur dismissal, blank-bar menu, viewport bounds, and light/dark themes:', directory)
}
main().catch(async error => {
  console.error(error)
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {})
  process.exitCode = 1
}).finally(async () => { await browser?.close() })
