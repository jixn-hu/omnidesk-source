const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { once } = require('node:events'), { _electron } = require('playwright')
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(root, 'tmp/monitor-views-'))
const token = 'synthetic-monitor-views-only'
let application, page, server, failure = false
const errors = [], calls = []
const asset = { provider:'',region:'',expiresAt:'2099-11-20',price:9.99,currency:'USD',billingCycle:'monthly',vendorUrl:'',autoPay:false,trafficLimit:1000*1e9,trafficMode:'sum',resetDay:1,timezone:'Asia/Shanghai',initialUpload:0,initialDownload:0,initialPeriod:'' }
const metrics = () => ({connectionId:'views-fixture',timestamp:Date.now(),durationMs:3,system:{hostname:'edge-hkg-01',os:'Debian 12',kernel:'6.1',arch:'x86_64',uptime:86400*32+3600*4},cpu:{usage:12.3333333333333,cores:2,loadAvg:[0.123456789,0.23456789,0.056789],perCore:[12,13],model:'Intel Xeon fixture'},memory:{used:2*1024**3,total:4*1024**3,free:2*1024**3,available:2*1024**3,usagePercent:50,swapUsed:256*1024**2,swapTotal:1024**3},disks:[{mount:'/',device:'/dev/vda1',fsType:'ext4',used:10*1024**3,total:40*1024**3,available:30*1024**3,usagePercent:25}],network:[{name:'eth0',rxRate:923.0474050505547,txRate:1234567.8912345,rxBytes:100*1024**3,txBytes:30*1024**3}],discovered:{ip:'203.0.113.10',provider:'Example Cloud',region:'Hong Kong',country:'HK',city:'Hong Kong',timezone:'Asia/Hong_Kong',asn:'AS64500',source:'ipwho.is',detectedAt:Date.now()}})
const baseNode = (id,name,group) => ({id:id.repeat(24),name,group,asset:{...asset},metrics:metrics(),lastSeen:Date.now(),upload:30*1e9,download:100*1e9,periodUpload:10*1e9,periodDownload:20*1e9,periodStart:Date.now()-86400000,periodEnd:Date.now()+86400000*29,coverageStart:Date.now()-86400000,incomplete:false})
const nodes = [baseNode('1','香港 · 轻量服务','生产'),baseNode('2','东京 · 数据处理','生产'),baseNode('3','洛杉矶 · 备用节点','备用'),baseNode('4','新加坡 · 等待接入','备用')]
nodes[1].metrics.cpu.usage = 94.567891; nodes[1].asset.provider = '自定义服务商'; nodes[1].asset.region='Tokyo'; nodes[1].periodUpload=980*1e9
nodes[2].metrics.timestamp = Date.now()-120000
nodes[3].metrics=undefined; nodes[3].lastSeen=0; nodes[3].asset.trafficLimit=0; nodes[3].asset.expiresAt=''
async function shot(name) { await page.screenshot({path:path.join(directory,name),animations:'disabled'}) }
async function launch(first) {
 const env={...process.env,OMNIDESK_USER_DATA_DIR:path.join(directory,'profile')}; delete env.ELECTRON_RUN_AS_NODE
 application=await _electron.launch({executablePath:process.env.OMNIDESK_QA_EXE||require('electron'),args:[...(process.env.OMNIDESK_QA_EXE?[]:[root]),'--disable-gpu'],env})
 page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message))
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1500,height:1000}))
 if(first)await page.getByRole('button',{name:/暂不设置/}).click()
}
const entry=()=>page.locator('.sidebar, .sidebar-rail').getByRole('button',{name:'服务器监控',exact:true})
async function open() { await entry().click(); await page.locator('.monitor-dashboard').waitFor() }
async function main(){
 server=http.createServer((req,res)=>{
  calls.push(req.url);res.setHeader('Content-Type','application/json')
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);return res.end('{}')}
  if(req.url==='/healthz')return res.end('{"service":"omnidesk-monitor","protocol":1}')
  if(req.url==='/v1/alerts')return res.end('[]')
  if(req.url==='/v1/nodes'){if(failure){res.writeHead(503);return res.end('{}')};for(const n of nodes.slice(0,2)){n.metrics.timestamp=Date.now();n.lastSeen=Date.now()};return res.end(JSON.stringify(nodes))}
  if(req.url.includes('/history'))return res.end(JSON.stringify([{timestamp:Date.now(),metrics:metrics(),upload:0,download:0,incomplete:false}]))
  res.writeHead(404);res.end('{}')
 }); server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port
 await launch(true)
 assert.equal(await entry().count(),0)
 assert.equal(await page.locator('.sidebar').getByRole('button',{name:'共享服务器',exact:true}).count(),0)
 assert.equal(calls.length,0)
 await page.evaluate(async({url,token})=>{await window.omnidesk.updates.setAutoCheck(false);const result=await window.omnidesk.monitoring.configure({enabled:true,url,token,allowInsecure:true});if(!result.ok)throw Error(result.message);window.dispatchEvent(new Event('omnidesk:monitoring-changed'))},{url,token})
 await open();await page.locator('.monitor-node-card').nth(3).waitFor()
 assert.equal(await page.getByRole('button',{name:'卡片视图',exact:true}).getAttribute('aria-pressed'),'true')
 assert.equal(await page.locator('.monitor-node-card').count(),4)
 const card=()=>page.getByRole('article',{name:'香港 · 轻量服务监控卡片',exact:true})
 const text=await card().innerText()
 for(const value of ['Example Cloud · Hong Kong','2 GB / 4 GB','10 GB / 40 GB','256 MB / 1 GB','923 B/s','1.2 MB/s','12.3%','负载 0.12 / 0.23 / 0.06','运行 32 天 4 小时','30 GB','1000 GB','100 GB','9.99 USD / 月'])assert(text.includes(value),value+' missing: '+text)
 assert(!/\d+\.\d{3,}/.test(await card().locator('.monitor-card-resources, .monitor-card-network').allTextContents().then(values=>values.join(' '))))
 assert.match(await page.getByRole('article',{name:'东京 · 数据处理监控卡片',exact:true}).innerText(),/自定义服务商 · Tokyo/)
 assert.equal(await page.locator('.monitor-node-card[data-status="失联"] .monitor-resource-track[aria-valuenow]').count(),0)
 assert.match(await page.locator('.monitor-node-card[data-status="待接入"]').innerText(),/未设额度/)
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark'})
 await shot('01-cards-dark.png')
 await page.evaluate(()=>{document.documentElement.dataset.theme='light'})
 await shot('02-cards-light.png')
 await page.getByLabel('搜索监控服务器').fill('203.0.113.10');assert.equal(await page.locator('.monitor-node-card').count(),3)
 await page.getByLabel('搜索监控服务器').fill('自定义服务商');assert.equal(await page.locator('.monitor-node-card').count(),1)
 await page.getByLabel('搜索监控服务器').fill('Hong Kong');assert.equal(await page.locator('.monitor-node-card').count(),2)
 await page.getByLabel('搜索监控服务器').fill('无匹配节点');await page.getByText('没有匹配的服务器',{exact:true}).waitFor()
 await page.getByLabel('搜索监控服务器').fill('');await page.getByLabel('监控分组').selectOption('备用');assert.equal(await page.locator('.monitor-node-card').count(),2)
 await page.getByLabel('监控分组').selectOption('');await page.getByLabel('监控排序').selectOption('cpu')
 assert.match(await page.locator('.monitor-node-card').first().innerText(),/东京/)
 await card().getByRole('button',{name:'香港 · 轻量服务',exact:true}).click();await page.locator('.monitor-detail').waitFor()
 assert.match(await page.locator('.monitor-detail').innerText(),/923 B\/s/)
 await page.getByRole('button',{name:'← 返回总览',exact:true}).click();assert.equal(await page.getByRole('button',{name:'卡片视图',exact:true}).getAttribute('aria-pressed'),'true')
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:960,height:760}))
 await shot('03-cards-narrow.png')
 assert(await page.locator('.monitor-dashboard').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Card dashboard must not overflow')
 for(const el of await page.locator('.monitor-node-card').all())assert(await el.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Card contents must fit')
 await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:1500,height:1000}))
 await page.getByRole('button',{name:'列表视图',exact:true}).click();assert.equal(await page.locator('.monitor-node-table tbody tr').count(),4)
 const row=page.locator('.monitor-node-table tbody tr').filter({has:page.getByRole('button',{name:'香港 · 轻量服务',exact:true})})
 for(const value of ['2 GB / 4 GB','10 GB / 40 GB','256 MB / 1 GB','923 B/s','Example Cloud'])assert((await row.innerText()).includes(value),value)
 await shot('04-list-light.png')
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});await shot('05-list-dark.png')
 await page.getByLabel('监控排序').selectOption('name')
 await application.close();application=undefined
 await launch(false);await open();await page.locator('.monitor-node-table tbody tr').nth(3).waitFor()
 assert.equal(await page.getByRole('button',{name:'列表视图',exact:true}).getAttribute('aria-pressed'),'true')
 await page.getByRole('button',{name:'卡片视图',exact:true}).click();await card().waitFor()
 nodes[0].metrics.network=[{name:'eth0',rxBytes:0,txBytes:0}]
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="香港 · 轻量服务监控卡片"] .monitor-card-network')?.textContent==='↓ 下载—↑ 上传—')
 failure=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.locator('.monitor-node-card[data-status="采集异常"]').nth(3).waitFor()
 assert.equal(await card().locator('[role="meter"][aria-valuenow]').count(),0)
 await shot('06-service-error.png')
 assert.deepEqual(errors,[])
 console.log('PASS: fresh/error/offline/unreported cards; memory/disk/Swap capacities, bounded rates, CPU loads, quota and traffic totals, automatic/manual asset fallback')
 console.log('PASS: list/card switching and persistence, IP/provider/region search, group/sort, detail navigation; dark/light/narrow layouts without card overflow; no phantom zero rates')
 console.log('QA_DIRECTORY='+directory)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(page&&process.exitCode)try{await shot('failure.png')}catch{};await application?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve))})
