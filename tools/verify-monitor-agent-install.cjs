const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { Writable } = require('node:stream')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
function load(file) {
  const compiled = esbuild.buildSync({ entryPoints:[path.join(root,file)], bundle:true, write:false, platform:'node', format:'cjs', alias:{'@shared':path.join(root,'src/shared')} })
  const mod = new Module(path.join(root,file),module); mod.paths=module.paths; mod._compile(compiled.outputFiles[0].text,file); return mod.exports
}
const { MonitorAgentInstaller } = load('src/main/services/monitor-agent-installer.ts')
const { MonitoringService } = load('src/main/services/monitoring.ts')
const { EMPTY_ASSET } = load('src/shared/monitoring.ts')
const { monitorInstallTarget } = load('src/renderer/src/features/monitor/monitor-install-target.ts')
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'omnidesk-agent-test-'))
const runtime = path.join(directory,'runtime'); fs.mkdirSync(runtime)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const files = {}
for (const [arch,machine] of [['amd64',62],['arm64',183]]) {
  const bytes = Buffer.alloc(64); bytes.write('7f454c46',0,'hex'); bytes.writeUInt16LE(machine,18)
  const name='omnidesk-monitor-agent-linux-'+arch; fs.writeFileSync(path.join(runtime,name),bytes); files[name]=hash(bytes)
}
fs.writeFileSync(path.join(runtime,'install.sh'),'fixture-script'); files['install.sh']=hash(Buffer.from('fixture-script'))
fs.writeFileSync(path.join(runtime,'install-user.sh'),'fixture-user-script'); files['install-user.sh']=hash(Buffer.from('fixture-user-script'))
fs.writeFileSync(path.join(runtime,'manifest.json'),JSON.stringify({protocol:1,files}))
const nodeId = '123456789012345678901234', token='synthetic-node-token-never-in-commands'
const config = {nodeId,serverUrl:'https://fixture.invalid',statePath:'/var/lib/omnidesk-monitor-agent/state.json',intervalSeconds:17,includeNics:['eth0'],disableDiscovery:true,token:'old-synthetic-token'}
function fixture(options={}) {
  const ssh=new EventEmitter(), commands=[], progress=[], uploads=new Map(), disconnected=[]
  let connected=false, boundId, revision=1, rotated=0, installed=false, seen=100, sftpEnded=0, activeToken=options.noToken?undefined:token
  const connection={id:'ssh-fixture',kind:'ssh',name:'QA VPS',group:'QA',updatedAt:1}
  const connections={get:()=>connection}
  const monitoring={
    local:()=>({config:{enabled:true,url:options.url??'https://fixture.invalid'}}),
    agentNodeForConnection:()=>boundId,
    forgetAgentConnection:()=>{boundId=undefined},
    rememberAgentConnection:id=>{boundId=id},
    agentInstallation:()=>({url:options.url??'https://fixture.invalid',allowInsecure:false,token:activeToken,revision:1}),
    assertInstallRevision:current=>{if(current!==revision)throw new Error('changed')},
    rotateAgentToken:async()=>{rotated++;activeToken=token;return{token}},
    request:async()=>[{id:nodeId,lastSeen:installed && !options.noReport ? ++seen:seen,metrics:{installationId:installed && !options.staleInstallation ? JSON.parse(uploads.get('agent.json')).installationId : 'old-installation',system:{hostname:options.wrongHostname?'other-host':'qa-vps'}}},...(options.oldNodePresent?[{id:options.existing.nodeId}]:[])]
  }
  ssh.list=()=>options.reuse?[{id:'user-session',connectionId:connection.id,status:'connected'}]:connected?[{id:'owned-session',connectionId:connection.id,status:'connected'}]:[]
  ssh.getConnection=()=>({...connection})
  ssh.connect=async(conn,ownerId)=>{connected=true;ssh.emit('sessionEvent',{id:'owned-session',ownerId}); if(options.connectError)throw new Error(token);return{id:'owned-session'}}
  ssh.disconnect=id=>{connected=false;disconnected.push(id)}
  ssh.getClient=()=>({sftp:callback=>callback(null,{
    createWriteStream:(name,mode)=>{assert.equal(mode.flags,'wx');assert.equal(mode.mode,0o600);const chunks=[];return new Writable({write(chunk,encoding,done){chunks.push(chunk);if(options.uploadError)done(new Error(token));else done()},final(done){uploads.set(path.posix.basename(name),Buffer.concat(chunks));done()}})},
    end:()=>sftpEnded++
  })})
  ssh.exec=async(id,command,opts={})=>{
    commands.push(command);assert(!command.includes(token),'token leaked in command');assert(!command.includes('qa-sudo-password'),'sudo password leaked in command')
    if(command.startsWith("sudo -S -k -p '' -- ")){assert.equal(opts.stdin,'qa-sudo-password\n');if(options.badPassword)return{code:1,stdout:''}}
    if(command==='uname -s')return{code:0,stdout:'Linux\n'}
    if(command.includes('OMNIDESK_READY')) {if(options.gate)await options.gate; if(options.changeRevision)revision++;if(options.editConnection)connection.updatedAt++;return{code:options.probeCode??0,stdout:`OMNIDESK_READY\n${options.arch??'amd64'}\n${options.privilege??(options.sudo?'sudo':'root')}\nqa-vps\n/home/qa\n${options.noSystemd?'0':'1'}\n${options.userPresent?'1':'0'}\n`}}
    if(command.includes('cat "$config"') && (options.userInstall||options.noSystemd||options.userPresent||options.privilege==='user') && !command.includes('Managed by OmniDesk user installer'))return{code:options.systemPresent?4:3,stdout:''}
    if(command.includes('cat "$config"'))return{code:options.readCode??(options.existing?0:3),stdout:options.existing?JSON.stringify(options.existing):''}
    if(command.includes("'/install.sh'"))throw new Error('bad quote')
    if(/sh '[^']+\/install.sh'/.test(command)){if(options.deployError)return{code:1,stdout:'OMNIDESK_INSTALL_ROLLED_BACK\n'+token};installed=true;return{code:0,stdout:'OMNIDESK_STARTUP='+(options.startup??'none')+'\nOMNIDESK_INSTALL_OK\n'}}
    if(command.endsWith("/start.sh' status")||command.startsWith('systemctl is-active'))return{code:options.inactive?1:0,stdout:''}
    return{code:0,stdout:''}
  }
  const installer=new MonitorAgentInstaller(monitoring,connections,ssh,runtime,value=>{assert(!JSON.stringify(value).includes(token));progress.push(value)}, {reportTimeoutMs:3,reportPollMs:1})
  return{installer,commands,uploads,progress,disconnected,connection,get rotated(){return rotated},get sftpEnded(){return sftpEnded},run:(extra={})=>installer.install({nodeId,connectionId:connection.id,...extra})}
}
async function main(){
  for(const options of [{},{arch:'arm64',sudo:true},{reuse:true,existing:config},{url:'http://192.0.2.75:47831/v1/monitor'},{url:'https://public.example.test/v1/monitor'}]) {
    const f=fixture(options),result=await f.run();assert.equal(result.reported,true);assert.equal(result.active,true)
    assert.deepEqual(f.progress.map(x=>x.stage),['connecting','checking','uploading','installing','reporting'])
    assert.equal(f.uploads.get('agent').readUInt16LE(18),options.arch==='arm64'?183:62)
    const saved=JSON.parse(f.uploads.get('agent.json'));assert.equal(saved.token,token);assert.equal(saved.nodeId,nodeId);assert.equal(saved.serverUrl,options.url??'https://fixture.invalid')
    if(options.existing){assert.equal(saved.intervalSeconds,17);assert.deepEqual(saved.includeNics,['eth0']);assert.equal(saved.disableDiscovery,true)}
    assert.equal(f.sftpEnded,1);assert.deepEqual(f.disconnected,options.reuse?[]:['owned-session'])
    if(options.sudo)assert(f.commands.some(x=>x.startsWith('sudo -n -- sh ')&&x.includes('/install.sh')))
    assert(f.commands.at(-1).startsWith('rm -f '),'private staging cleanup missing')
  }
  for(const code of [41,43,44,46,47]){const f=fixture({noToken:true,probeCode:code});await assert.rejects(()=>f.run({renewToken:true}));assert.equal(f.rotated,0);assert.equal(f.uploads.size,0)}
  for(const options of [{readCode:4},{existing:{...config,statePath:'/other/state.json'}},{existing:{...config,serverUrl:'file:///etc/secret'}},{existing:{...config,serverUrl:'https://user:password@example.invalid'}}]){const f=fixture({...options,noToken:true});await assert.rejects(()=>f.run({renewToken:true}));assert.equal(f.rotated,0);assert.equal(f.uploads.size,0)}
  const reenroll=fixture({existing:{...config,nodeId:'ffffffffffffffffffffffff'}});const preview=await reenroll.run();assert(preview.replacement);assert.equal(reenroll.uploads.size,0);const renewed=await reenroll.run({replaceBinding:preview.replacement});assert(renewed.reported);assert.match(renewed.message,/重新接入/);assert(reenroll.commands.some(command=>/install.sh.* 1$/.test(command)))
  for (const existing of [{...config,nodeId:'ffffffffffffffffffffffff'}, {...config,serverUrl:'https://other.invalid'}]) {
    const f=fixture({existing,oldNodePresent:true,noToken:true}), offered=await f.run({renewToken:true})
    assert.deepEqual(offered.replacement,{nodeId:existing.nodeId,serverUrl:existing.serverUrl})
    assert.equal(f.rotated,0);assert.equal(f.uploads.size,0)
    const stale=await f.run({renewToken:true,replaceBinding:{...offered.replacement,nodeId:'eeeeeeeeeeeeeeeeeeeeeeee'}})
    assert.deepEqual(stale.replacement,offered.replacement);assert.equal(f.rotated,0);assert.equal(f.uploads.size,0)
    const overwritten=await f.run({renewToken:true,replaceBinding:offered.replacement})
    assert(overwritten.reported);assert.equal(f.rotated,1);assert(f.commands.some(command=>/install.sh.* 1$/.test(command)))
    assert(!overwritten.message.includes('原节点已删除'));assert(JSON.parse(f.uploads.get('agent.json')).installationId)
  }
  const missing=fixture({noToken:true});await assert.rejects(()=>missing.run(),/令牌/);assert.equal(missing.commands.length,0)
  const renew=fixture({noToken:true});await renew.run({renewToken:true});assert.equal(renew.rotated,1)
  for(const options of [{noReport:true},{wrongHostname:true},{staleInstallation:true},{noReport:true,inactive:true}]){const f=fixture(options),result=await f.run();assert.equal(result.reported,false);assert.equal(result.active,!options.inactive)}
  for(const options of [{connectError:true},{uploadError:true},{deployError:true}]){const f=fixture({...options,noToken:!!options.deployError});await assert.rejects(()=>f.run(options.deployError?{renewToken:true}:{}),error=>{assert(!error.message.includes(token));if(options.deployError)assert.match(error.message,/令牌已更换/);return true});assert.deepEqual(f.disconnected,['owned-session'])}
  for(const options of [{changeRevision:true},{editConnection:true}]){const f=fixture(options);await assert.rejects(()=>f.run());assert.equal(f.uploads.size,0)}
  let release;const gate=new Promise(resolve=>release=resolve),concurrent=fixture({gate});const pending=concurrent.run();await new Promise(resolve=>setImmediate(resolve));await assert.rejects(()=>concurrent.run(),/正在安装/);release();await pending
  const targets=[{id:'ssh',kind:'ssh',name:'Old local name',host:'203.0.113.5'},{id:'rdp',kind:'rdp',name:'Windows',host:'203.0.113.5'}]
  const reported={name:'Cloud',metrics:{system:{os:'Linux'},publicIP:{ipv4:'203.0.113.5'}}}
  assert.equal(monitorInstallTarget(reported,targets),'ssh')
  assert.equal(monitorInstallTarget({...reported,metrics:{...reported.metrics,system:{os:'Windows'}}},targets),'rdp')
  assert.equal(monitorInstallTarget(reported,[...targets,{...targets[0],id:'same-host-second-port'}]),undefined)
  assert.equal(monitorInstallTarget({name:'Unknown'},targets),undefined)
  const needPassword=fixture({privilege:'password',noToken:true});const challenge=await needPassword.run({renewToken:true});assert(challenge.needsSudoPassword);assert.equal(needPassword.rotated,0);assert.equal(needPassword.uploads.size,0)
  const badPassword=fixture({privilege:'password',badPassword:true,noToken:true});assert((await badPassword.run({sudoPassword:'qa-sudo-password',renewToken:true})).needsSudoPassword);assert.equal(badPassword.rotated,0);assert.equal(badPassword.uploads.size,0)
  assert((await fixture({privilege:'password'}).run({sudoPassword:'qa-sudo-password'})).reported)
  for(const options of [{privilege:'user'},{noSystemd:true},{privilege:'password',userInstall:true},{privilege:'user',startup:'cron'},{privilege:'user',startup:'user-systemd'}]) {
    const f=fixture(options), r=await f.run(options.userInstall?{installMode:'user'}:{})
    assert(r.reported);assert.match(r.message,/当前用户/);assert.equal(f.uploads.get('install.sh').toString(),'fixture-user-script');assert.equal(JSON.parse(f.uploads.get('agent.json')).statePath,'/home/qa/.local/share/omnidesk-monitor-agent/state.json')
    assert(!f.commands.some(c=>c.startsWith('sudo ')))
    if(options.startup==='cron')assert.match(r.message,/依赖系统 cron/)
    if(!options.startup)assert.match(r.message,/未找到可用的开机自启/)
  }
  const userConfig={...config,statePath:'/home/qa/.local/share/omnidesk-monitor-agent/state.json'}
  const userReinstall=fixture({userPresent:true,existing:userConfig});assert((await userReinstall.run()).reported);assert.equal(userReinstall.uploads.get('install.sh').toString(),'fixture-user-script')
  const userRebind=fixture({privilege:'user',existing:{...userConfig,serverUrl:'https://other.invalid'}}), userPreview=await userRebind.run()
  assert(userPreview.replacement);assert.equal(userRebind.uploads.size,0);assert((await userRebind.run({replaceBinding:userPreview.replacement})).reported)
  const blocked=fixture({privilege:'user',systemPresent:true,noToken:true});await assert.rejects(()=>blocked.run({renewToken:true}),/已有系统级/);assert.equal(blocked.rotated,0);assert.equal(blocked.uploads.size,0)
  await assert.rejects(()=>fixture().run({sudoPassword:'invalid\npassword'}),/无效/)
  const damaged=path.join(runtime,'omnidesk-monitor-agent-linux-amd64');fs.appendFileSync(damaged,'tampered');const invalid=fixture();await assert.rejects(()=>invalid.run(),/校验失败/);assert.equal(invalid.uploads.size,0)
  for (const reuse of [false,true]) {
    const f=fixture({reuse,existing:config})
    let calls=0
    f.installer.monitoring.prepareAgentNode=async()=>{calls++;assert.equal(f.installer.monitoring.agentNodeForConnection('ssh-fixture'),nodeId);return{id:nodeId}}
    const nodes=await Promise.all([f.installer.prepareNode('ssh-fixture'),f.installer.prepareNode('ssh-fixture')])
    assert(nodes.every(node=>node.id===nodeId));assert.equal(calls,1)
    assert.deepEqual(f.disconnected,reuse?[]:['owned-session'])
  }
  const preparationFailure=fixture({connectError:true})
  await assert.rejects(()=>preparationFailure.installer.prepareNode('ssh-fixture'),error=>!error.message.includes(token))
  assert.deepEqual(preparationFailure.disconnected,['owned-session'])
  assert.equal(preparationFailure.installer.connectionsInUse.size,0)
  // Real MonitoringService scopes node tokens by server URL and keeps them out of monitoring.json.
  const storage=path.join(directory,'profile');fs.mkdirSync(storage);const secrets=new Map(),vault={status:()=> 'unlocked',getCredential:id=>secrets.get(id),setCredential:(id,secret)=>secrets.set(id,{secret})}
  const service=new MonitoringService(storage,vault,{get:()=>null},fetch,()=>{})
  let context={key:'instance-one-alice',url:'http://192.0.2.75:47831/v1/monitor',token:'synthetic-session-one'}
  service.setAccountProvider(()=>context,async route=>route.endsWith('/token')?{token:token+'-rotated'}:{node:{id:nodeId},token})
  service.configure({enabled:true})
  await service.saveNode({name:'QA',group:'',asset:EMPTY_ASSET});assert.equal(service.agentInstallation(nodeId).token,token)
  await service.rotateAgentToken(nodeId);assert.equal(service.agentInstallation(nodeId).token,token+'-rotated')
  const original=context
  context={key:'instance-two-alice',url:'https://public.example.test/v1/monitor',token:'synthetic-session-two'};service.accountChanged()
  assert.equal(service.agentInstallation(nodeId).token,undefined);assert.equal(service.agentInstallation(nodeId).url,context.url)
  context=original;service.accountChanged();assert.equal(service.agentInstallation(nodeId).token,token+'-rotated')
  assert.equal(service.agentInstallation(nodeId).url,'http://192.0.2.75:47831/v1/monitor')
  assert(!fs.readFileSync(path.join(storage,'monitoring.json'),'utf8').includes(token))
  console.log('PASS collector installer: root/passwordless sudo/password sudo/user, ephemeral stdin, password challenge without rotation, user reinstall/rebind/system conflict, startup disclosure, amd64/arm64, session reuse/cleanup, private uploads, token scoping/renewal, preflight, managed reinstall, errors/rollback marker, locks, revisions, hashes, fresh installation markers, replacement consent/stale confirmation, cold SSH discovery without duplicate nodes, concurrent preparation and partial outcomes')
}
main().catch(error=>{console.error(error);process.exitCode=1})
