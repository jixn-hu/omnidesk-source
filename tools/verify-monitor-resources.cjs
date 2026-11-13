const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const root = path.resolve(__dirname, '..')
global.window = { addEventListener() {} }
const result = require('esbuild').buildSync({entryPoints:[path.join(root,'src/renderer/src/features/monitor/monitor-display.ts')],bundle:true,write:false,platform:'node',format:'cjs',alias:{'@shared':path.join(root,'src/shared')}})
const modulePath = path.join(root,'tmp/resources-check.cjs'), mod = new Module(modulePath,module)
mod.paths = module.paths; mod._compile(result.outputFiles[0].text,modulePath)
const {rowState,nodeDisplay,cpuCapacity} = mod.exports
const shared = require('esbuild').buildSync({entryPoints:[path.join(root,'src/shared/monitor-resources.ts')],bundle:true,write:false,platform:'node',format:'cjs'})
const policy = new Module(modulePath,module);policy.paths=module.paths;policy._compile(shared.outputFiles[0].text,modulePath)
const {diskExclusionReason,mostUsedDisk} = policy.exports
for(const c of JSON.parse(fs.readFileSync(path.join(root,'monitor-agent/protocol/testdata/filesystems.json'),'utf8')))assert.equal(!diskExclusionReason({fsType:c.fsType,mount:c.mount}),c.included,JSON.stringify(c))
const now=Date.now(), normal={mount:'/',device:'/dev/vda2',fsType:'ext4',used:18,total:68,available:50,usagePercent:28.4,inodeUsagePercent:4.2}
const images=['core20/2922','snapd/28254','core22/2987','lxd/41283'].map(mount=>({...normal,fsType:'squashfs',mount:'/snap/'+mount,usagePercent:100,inodeUsagePercent:100}))
const metrics={timestamp:now,cpu:{cores:4,usage:25,perCore:[],loadAvg:[0,0,0]},memory:{used:2,total:8,usagePercent:25},disks:[normal,...images],network:[],system:{uptime:0},unavailable:[]}
const row={id:'synthetic',name:'synthetic',metrics,node:{intervalSeconds:60,asset:{expiresAt:'',trafficMode:'sum',trafficLimit:0,timezone:'UTC'},periodUpload:0,periodDownload:0}}
assert.equal(rowState(row,now),'正常');assert.equal(nodeDisplay(row,now).disk.mount,'/');assert.equal(cpuCapacity(metrics),'1 / 4 核')
metrics.cpu.usage=12.5;assert.equal(cpuCapacity(metrics),'0.5 / 4 核')
metrics.cpu.usage=0.001;assert.equal(cpuCapacity(metrics),'<0.01 / 4 核')
metrics.cpu.usage=100;metrics.unavailable=['cpu.usage'];assert.equal(cpuCapacity(metrics),'— / 4 核');assert.equal(rowState(row,now),'正常')
metrics.unavailable=[];metrics.cpu.usage=0;normal.inodeUsagePercent=95;assert.equal(rowState(row,now),'资源告警')
normal.inodeUsagePercent=4.2;normal.usagePercent=95;assert.equal(rowState(row,now),'资源告警')
assert.equal(rowState(row,now+196000),'失联');assert.equal(nodeDisplay(row,now+196000).metrics,undefined)
assert.equal(mostUsedDisk(images),undefined)
const loop={...normal,device:'/dev/loop0',fsType:'ext4',mount:'/data',usagePercent:96};assert.equal(mostUsedDisk([normal,...images,loop]),loop)
assert.equal(mostUsedDisk([{...normal,total:0}]),undefined)
console.log('PASS: shared filesystem cases match Go policy; Snap images excluded; real disk/inode alerts, writable loop data, CPU used/total, unavailable and stale samples')
