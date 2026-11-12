const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),http=require('node:http'),{once}=require('node:events'),{spawnSync}=require('node:child_process'),esbuild=require('esbuild')
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'omnidesk-windows-command-'))
const built=esbuild.buildSync({entryPoints:[path.join(root,'src/main/services/monitor-windows-installer.ts')],bundle:true,write:false,platform:'node',format:'cjs'})
const mod=new Module(path.join(root,'src/main/services/monitor-windows-installer.ts'),module);mod.paths=module.paths;mod._compile(built.outputFiles[0].text,path.join(root,'src/main/services/monitor-windows-installer.ts'))
const {windowsMonitorCommand,windowsMonitorBundle}=mod.exports
const nodeId='1234567890abcdef12345678',agentToken='synthetic-node-token-at-least-24',ticket='s'.repeat(43),installationId='b'.repeat(32)
const script=Buffer.from('# synthetic installer; never executed\n'),sha256=crypto.createHash('sha256').update(script).digest('hex')
function fixture(origin,options={}) {
 let generation=1,rotated=0,remembered=0
 const connection={id:'qa-rdp',kind:'rdp',updatedAt:12},requests=[]
 const monitoring={
  agentInstallation:()=>({url:origin+'/v1/monitor',token:options.noToken?undefined:agentToken,revision:1,defaultIntervalSeconds:60,allowInsecure:true}),
  assertInstallRevision:revision=>{if(revision!==generation)throw new Error('stale account')},
  rotateAgentToken:async()=>{rotated++;return {token:agentToken}},
  rememberAgentConnection:()=>{remembered++},
  request:async(route,method,body)=>{requests.push({route,method,body});if(route==='/v1/nodes'){if(options.switchAccount)generation++;return [{id:nodeId,intervalSeconds:77}]};return {downloadPath:'/v1/monitor/install/windows/download',ticket,sha256:options.badHash?'0'.repeat(64):sha256,installationId,expiresAt:Date.now()+900000}}
 }
 return {monitoring,connections:{get:()=>connection},requests,counts:()=>({rotated,remembered}),run:input=>windowsMonitorCommand(monitoring,{get:()=>connection},{nodeId,connectionId:connection.id,...input})}
}
async function main(){
 const server=http.createServer((req,res)=>{assert.equal(req.url,'/v1/monitor/install/windows/download');assert.equal(req.headers['x-omnidesk-install'],ticket);res.end(script)})
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port
 try {
  const f=fixture(origin),result=await f.run()
  assert(result.command.includes(origin+'/v1/monitor/install/windows/download'));assert(!result.command.includes(agentToken));assert.equal(result.installationId,installationId)
  assert.equal(f.requests[1].body.serverUrl,origin+'/v1/monitor');assert.equal(f.requests[1].body.intervalSeconds,77)
  assert.deepEqual(f.counts(),{rotated:0,remembered:1})
  const missing=fixture(origin,{noToken:true});await assert.rejects(()=>missing.run(),/同意更换/);assert.equal(missing.requests.length,0)
  await missing.run({renewToken:true});assert.equal(missing.counts().rotated,1)
  const switched=fixture(origin,{switchAccount:true});await assert.rejects(()=>switched.run({renewToken:true}),/stale account/);assert.equal(switched.counts().rotated,0)
  // Execute the actual generated PowerShell download/hash/cleanup command, with
  // powershell.exe replaced by a harmless function. No installer is executed.
  for(const mode of ['success','bad-hash','child-failure']) {
   const value=await fixture(origin,{badHash:mode==='bad-hash'}).run(),marker=path.join(directory,mode+'.txt'),driver=path.join(directory,mode+'.ps1')
   fs.writeFileSync(driver,`$ErrorActionPreference='Stop'\nfunction global:powershell.exe { [IO.File]::WriteAllText($env:QA_MARKER,$args[-1]); $global:LASTEXITCODE=${mode==='child-failure'?9:0} }\ntry { ${value.command} } catch { Write-Output $_.Exception.Message; exit 1 }\n`)
   const child=await new Promise(resolve=>{const {spawn}=require('node:child_process');const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',driver],{windowsHide:true,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules'),QA_MARKER:marker}});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('close',status=>resolve({status,output}))})
   assert.equal(child.status,mode==='success'?0:1,child.output)
   if(mode==='bad-hash'){assert(!fs.existsSync(marker));assert.match(child.output,/integrity check failed/)}
   else {assert(fs.existsSync(marker));assert(!fs.existsSync(fs.readFileSync(marker,'utf8')),'temporary downloaded script must be deleted')}
  }
  const local=fixture(origin),bundle=await windowsMonitorBundle(local.monitoring,local.connections,path.join(root,'out/monitor-agent'),{nodeId,connectionId:'qa-rdp'})
  const payload=JSON.parse(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(bundle.contents)[1],'base64').toString())
  assert.equal(payload.config.installationId,bundle.installationId);assert.equal(payload.config.intervalSeconds,77);assert.equal(payload.config.serverUrl,origin+'/v1/monitor')
  assert.equal(crypto.createHash('sha256').update(Buffer.from(payload.binary,'base64')).digest('hex'),payload.sha256)
  const manual=path.join(directory,'manual.ps1');fs.writeFileSync(manual,'\ufeff'+bundle.contents)
  const parsed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile($env:QA_SCRIPT,[ref]$t,[ref]$e)|Out-Null;if($e.Count){exit 1}"],{windowsHide:true,env:{...process.env,QA_SCRIPT:manual}})
  assert.equal(parsed.status,0);fs.unlinkSync(manual)
  console.log('PASS Windows commands: exact service/port, no account or node token in command, download/hash/cleanup, child failure, token consent, stale-account guard, manual bundle/marker and PowerShell syntax')
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
