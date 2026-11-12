const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { _electron } = require('playwright')
const { fixture, containers } = require('./docker-ssh-fixture.cjs')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'tmp/docker-ui-'))
const peer = fixture(path.join(directory,'peer')), other = fixture(path.join(directory,'other'))
const errors = []
let application, page
const panel = () => page.locator('.terminal-sidebar-docker:visible')
const refresh = async () => { await panel().getByRole('button',{name:'刷新 Docker',exact:true}).click(); await page.waitForFunction(() => !document.querySelector('.terminal-sidebar-docker:not([hidden]) button[aria-label="刷新 Docker"]')?.disabled) }
const entry = () => page.locator('.terminal-sidebar-rail:visible').getByRole('button',{name:'Docker 管理',exact:true})
const card = name => panel().locator('.docker-resource').filter({has:page.locator('strong',{hasText:name})})
const shot = async name => page.screenshot({path:path.join(directory,name),animations:'disabled'})
async function connect(id) {
  await page.locator(`.sidebar .conn-item[data-connection-id="${id}"]`).click()
  await page.getByRole('button',{name:'信任并记住',exact:true}).click()
  await entry().waitFor(); await page.waitForFunction(() => ![...document.querySelectorAll('.terminal-sidebar-rail button[aria-label="Docker 管理"]')].filter(element=>element.checkVisibility())[0]?.disabled)
}
async function main() {
  const port = await peer.start(), otherPort = await other.start(); other.mode = 'missing'
  const env = {...process.env,OMNIDESK_USER_DATA_DIR:path.join(directory,'profile')};delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({executablePath:process.env.OMNIDESK_QA_EXE||require('electron'), args:[...(process.env.OMNIDESK_QA_EXE?[]:[root]),'--disable-gpu'],env})
  page = await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message))
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setBounds({width:1400,height:950});window.focus()})
  await page.getByRole('button',{name:/暂不设置/}).click()
  const records = await page.evaluate(async ({port,otherPort})=>{
    const saved=[]
    for(const [name,p] of [['Docker QA Linux',port],['Docker QA absent',otherPort]]) {
      const result=await window.omnidesk.connections.save({name,kind:'ssh',host:'127.0.0.1',port:p,username:'qa',authMethod:'password'},{secret:'docker-qa-only'})
      if(!result.ok)throw Error(result.message);saved.push(result.data)
    }
    return saved
  },{port,otherPort})
  await page.reload();await connect(records[0].id)
  assert.equal(peer.commands.length,0,'Docker queries should be lazy')
  await page.evaluate(()=>{window.qaTerminal=document.querySelector('.xterm')})
  const labels=await page.locator('.terminal-sidebar-rail:visible button').evaluateAll(items=>items.map(item=>item.getAttribute('aria-label')))
  assert(labels.indexOf('Docker 管理')===labels.indexOf('文件管理')+1)
  await entry().click();await card('web-production').waitFor()
  assert.equal(await card('web-production').getByRole('button',{name:'删除容器 web-production'}).isDisabled(),true)
  await card('worker-retired').getByText('查看详情',{exact:true}).click();await card('worker-retired').getByText('创建时间',{exact:true}).waitFor()
  await panel().getByRole('textbox',{name:'搜索 Docker 资源'}).fill('nginx')
  assert.equal(await panel().locator('.docker-resource').count(),1)
  await panel().getByRole('textbox',{name:'搜索 Docker 资源'}).fill('not-a-resource')
  await panel().getByText('没有匹配的资源',{exact:true}).waitFor()
  await panel().getByRole('textbox',{name:'搜索 Docker 资源'}).fill('')
  await shot('containers-light.png')
  await card('worker-retired').getByRole('button',{name:'删除容器 worker-retired'}).click()
  const dialog=page.getByRole('dialog',{name:'删除容器',exact:true})
  await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:'取消',exact:true}).evaluate(element=>element===document.activeElement),true)
  await page.keyboard.press('Tab');assert.equal(await dialog.getByRole('button',{name:'确认删除',exact:true}).evaluate(element=>element===document.activeElement),true)
  await page.keyboard.press('Tab');assert.equal(await dialog.getByRole('button',{name:'取消',exact:true}).evaluate(element=>element===document.activeElement),true)
  const beforeCancel=peer.commands.length
  await shot('delete-confirmation.png');await page.keyboard.press('Escape')
  assert.equal(peer.commands.length,beforeCancel)
  await card('worker-retired').getByRole('button',{name:'删除容器 worker-retired'}).click()
  await dialog.getByRole('button',{name:'确认删除',exact:true}).click()
  await panel().getByRole('status').filter({hasText:'已删除容器'}).waitFor()
  await page.waitForFunction(()=>[...document.querySelectorAll('.terminal-sidebar-docker:not([hidden]) .docker-resource strong')].every(element=>element.textContent!=='worker-retired'))
  await panel().getByRole('button',{name:/^镜像/}).click()
  assert.equal(await panel().locator('.docker-resource').count(),2,'tags grouped by immutable image ID')
  await card('example/worker:2026').getByText('查看详情',{exact:true}).click()
  await card('example/worker:2026').getByText(/example\/worker:latest/).waitFor()
  peer.mode='conflict'
  await card('example/worker:2026').getByRole('button',{name:'删除镜像 example/worker:2026'}).click()
  await page.getByRole('dialog').getByRole('button',{name:'确认删除',exact:true}).click()
  await page.getByRole('dialog').getByRole('alert').filter({hasText:'in use'}).waitFor()
  await shot('image-conflict.png')
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();peer.mode='ready'
  await card('无标签镜像').getByRole('button',{name:'删除镜像 无标签镜像'}).click()
  await page.getByRole('dialog').getByRole('button',{name:'确认删除',exact:true}).click()
  await panel().getByRole('status').filter({hasText:'已删除镜像'}).waitFor()
  await refresh();assert.equal(await panel().locator('.docker-resource').count(),1)
  peer.setContainers([{ID:'malformed'}]);await refresh()
  await panel().getByRole('alert').filter({hasText:'无法解析 Docker'}).waitFor()
  assert.equal(await card('example/worker:2026').getByRole('button',{name:'删除镜像 example/worker:2026'}).isDisabled(),true)
  peer.setContainers(containers)
  for(const [mode,text] of [['missing','未检测到 Docker'],['permission','Docker 权限不足'],['daemon','Docker 暂不可用'],['remote','Docker 暂不可用']]) {
    peer.mode=mode;await refresh();await panel().getByText(text,{exact:true}).waitFor();assert.equal(await panel().locator('.docker-resource').count(),0)
    if(mode==='permission')await shot('permission.png')
  }
  peer.mode='ready';await refresh();await card('example/worker:2026').waitFor()
  await page.locator('.terminal-sidebar-rail:visible').getByRole('button',{name:'文件管理',exact:true}).click()
  const countBeforeReturn=peer.commands.length
  await entry().click();await refresh();assert(peer.commands.length>countBeforeReturn)
  assert.equal(await page.evaluate(()=>window.qaTerminal===document.querySelector('.xterm')),true,'same mounted terminal')
  assert.equal(peer.authentications,1);assert.equal(peer.shells,1)
  await connect(records[1].id)
  if(await entry().getAttribute('aria-expanded')!=='true')await entry().click();await panel().getByText('未检测到 Docker',{exact:true}).waitFor()
  assert.equal(await panel().locator('.docker-resource').count(),0)
  await page.locator('.tabbar .tab').filter({has:page.locator('.tab-title',{hasText:'Docker QA Linux'})}).click()
  await card('example/worker:2026').waitFor()
  await page.evaluate(()=>document.documentElement.dataset.theme='dark')
  await page.emulateMedia({reducedMotion:'reduce'})
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:950,height:800}))
  await shot('images-dark-narrow.png')
  assert.equal(await panel().evaluate(element=>element.scrollWidth<=element.clientWidth+1),true,'sidebar fits narrow width')
  assert.equal(peer.authentications,1)
  peer.delay=true
  await panel().getByRole('button',{name:'刷新 Docker',exact:true}).click()
  await page.evaluate(async id=>{const result=await window.omnidesk.ssh.list();if(!result.ok)throw Error(result.message);const session=result.data.find(item=>item.connectionId===id);if(!session)throw Error('Missing fixture session');await window.omnidesk.ssh.disconnect(session.id)},records[0].id)
  await panel().getByText('连接 SSH 后查看 Docker',{exact:true}).waitFor()
  assert.equal(await entry().isDisabled(),true)
  await new Promise(resolve=>setTimeout(resolve,600));assert.equal(await panel().locator('.docker-resource').count(),0,'late result cannot repopulate disconnected panel')
  await shot('disconnected.png')
  assert.deepEqual(errors,[])
  const result={ok:true,checks:['actual Electron SSH/IPC','lazy detection','entry below Files','search/details','cancel and focus trap','stopped-container deletion','running protection','image grouping/removal/conflict','stale failure disables delete','missing/permission/daemon/remote context','stable terminal and authentication','separate SSH sessions','dark/narrow/reduced motion','disconnect discards late result'],artifacts:directory}
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}
main().catch(async error=>{console.error(error);if(page)await shot('failure.png').catch(()=>{});console.error('Artifacts: '+directory);process.exitCode=1}).finally(async()=>{await application?.close().catch(()=>{});await peer.close();await other.close()})
