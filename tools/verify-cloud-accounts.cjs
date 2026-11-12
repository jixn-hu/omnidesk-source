const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
process.env.NODE_PATH=path.resolve('node_modules');require('node:module').Module._initPaths()
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'omnidesk-accounts-'))
require('esbuild').buildSync({entryPoints:['official-account','vault','monitoring'].map(n=>'src/main/services/'+n+'.ts'),outdir:path.join(directory,'modules'),bundle:true,format:'cjs',platform:'node',packages:'external',alias:{'@shared':path.resolve('src/shared')}})
const {OfficialAccountService}=require(path.join(directory,'modules/official-account.js'))
const {VaultService}=require(path.join(directory,'modules/vault.js'))
const {MonitoringService}=require(path.join(directory,'modules/monitoring.js'))
const vault=new VaultService(directory);vault.init('Synthetic-vault-password')
const backup={create:async()=>'{"synthetic":"encrypted"}',restore:async()=>null}
const service=new OfficialAccountService(directory,vault,backup,async()=>true)
let logouts=0,pending
service.transport.request=async(url,method,headers,body)=>{
 const route=new URL(url).pathname
 if(route==='/v1/auth/login'){const username=JSON.parse(body).username;return {status:200,contents:Buffer.from(JSON.stringify({user:{id:'id_'+username,username,role:'user'},token:'synthetic-token-'+username,syncKey:'synthetic-key-'+username,expiresAt:Date.now()+3600000}))}}
 if(route==='/v1/logout'){logouts++;return {status:200,contents:Buffer.from('{}')}}
 if(route.includes('/monitor/'))return new Promise(resolve=>{pending=()=>resolve({status:200,contents:Buffer.from('[{"name":"stale B"}]')})})
 return {status:200,contents:Buffer.from('{}')}
}
async function main(){
 await service.configure('https://one.example.com');await service.authenticate('login','alice','synthetic-password')
 service.persist({...service.state,revision:7,lastSync:1234})
 const a=service.status().activeAccountId
 await service.authenticate('login','bob','synthetic-password');const b=service.status().activeAccountId
 assert.equal(service.status().accounts.length,2);assert(service.status().accounts.every(p=>p.signedIn));assert.equal(logouts,0)
 await service.switchAccount(a);assert.equal(service.status().revision,7);assert.equal(service.status().lastSync,1234)
 const scopeA=service.monitorContext().key;await service.switchAccount(b);assert.notEqual(service.monitorContext().key,scopeA);assert.equal(service.status().revision,0)
 assert.deepEqual(service.status().serverHistory,['https://one.example.com'])
 const monitor=new MonitoringService(directory,vault,{get:()=>null},fetch,()=>{})
 monitor.setAccountProvider(()=>service.monitorContext(),(p,m,b)=>service.monitorRequest(p,m,b));service.onContextChanged=()=>monitor.accountChanged()
 monitor.configure({enabled:true,mode:'account'})
 assert.equal(monitor.local().config.url,'https://one.example.com/v1/monitor')
 const old=monitor.request('/v1/nodes');const rejected=assert.rejects(old,/账号已切换|配置已切换/)
 await service.switchAccount(a);pending();await rejected
 const legacyPrefix='omnidesk-monitor-agent:'+require('node:crypto').createHash('sha256').update('https://one.example.com').digest('hex')+':'
 const foreignPrefix='omnidesk-monitor-agent:'+require('node:crypto').createHash('sha256').update('https://two.example.com').digest('hex')+':'
 monitor.data.agentConnections[foreignPrefix+'2'.repeat(24)]={connectionId:'foreign-service',host:'192.0.2.99',port:22}
 vault.setCredential(foreignPrefix+'2'.repeat(24),'synthetic-foreign-token')
 monitor.data.agentConnections[legacyPrefix+'2'.repeat(24)]={connectionId:'legacy-owned',host:'192.0.2.2',port:22}
 monitor.data.agentConnections[legacyPrefix+'3'.repeat(24)]={connectionId:'not-owned',host:'192.0.2.3',port:22}
 vault.setCredential(legacyPrefix+'2'.repeat(24),'synthetic-preserved-token')
 monitor.migrateOwnedAgentBindings([{id:'2'.repeat(24)}])
 assert.equal(vault.getCredential(monitor.agentTokenRef('2'.repeat(24))).secret,'synthetic-preserved-token')
 assert.equal(vault.getCredential(legacyPrefix+'2'.repeat(24)),null)
 assert(monitor.data.agentConnections[legacyPrefix+'3'.repeat(24)])
 assert.equal(vault.getCredential(foreignPrefix+'2'.repeat(24)).secret,'synthetic-foreign-token')
 assert.equal(monitor.data.agentConnections[foreignPrefix+'2'.repeat(24)].connectionId,'foreign-service')
 assert.equal(monitor.data.agentConnections[monitor.agentTokenRef('2'.repeat(24))].connectionId,'legacy-owned')
 assert.equal(monitor.agentInstallation('2'.repeat(24)).url,'https://one.example.com/v1/monitor')
 const refA=monitor.agentTokenRef('1'.repeat(24))
 monitor.data.agentConnections[refA]={connectionId:'saved',host:'192.0.2.1',port:22}
 const monitorBackup=monitor.backupConfiguration();assert(Object.hasOwn(monitorBackup.agentConnections,refA))
 const restoredMonitor=monitor.prepareBackup(monitorBackup,new Map([['saved','restored']]))
 assert.equal(JSON.parse(restoredMonitor.contents).agentConnections[refA].connectionId,'restored')
 await service.switchAccount(b);assert.notEqual(monitor.agentTokenRef('1'.repeat(24)),refA)
 assert.equal(Object.keys(monitor.backupConfiguration().agentConnections).length,0)
 assert.throws(()=>monitor.prepareBackup(monitorBackup,new Map()),/备份对应的账号/)
 assert.throws(()=>monitor.configure({enabled:true,mode:'legacy',url:'https://old.example.com'}),/当前账号/)

 await service.configure('https://two.example.com');await service.authenticate('login','alice','synthetic-password');assert.equal(service.status().revision,0)
 assert.equal(service.status().accounts.length,3);assert.notEqual(service.status().activeAccountId,a)
 monitor.migrateOwnedAgentBindings([{id:'2'.repeat(24)}])
 assert.equal(monitor.agentInstallation('2'.repeat(24)).url,'https://two.example.com/v1/monitor')
 assert.equal(monitor.agentInstallation('2'.repeat(24)).token,'synthetic-foreign-token')
 await service.switchAccount(a)
 assert.equal(monitor.agentInstallation('2'.repeat(24)).token,'synthetic-preserved-token')
 await service.configure('https://two.example.com');await service.authenticate('login','alice','synthetic-password')
 const persisted=fs.readFileSync(path.join(directory,'official-account.json'),'utf8');assert(!persisted.includes('synthetic-token'));assert(!persisted.includes('synthetic-key'))
 await service.logout();assert.equal(logouts,1);assert.equal(service.status().user,null)
 await service.switchAccount(a);assert.equal(service.status().user.username,'alice');assert.equal(service.status().revision,7)
 service.dispose()
 const restarted=new OfficialAccountService(directory,vault,backup,async()=>true)
 assert.deepEqual(restarted.status().serverHistory,['https://one.example.com','https://two.example.com']);assert.equal(restarted.status().accounts.length,3);assert.equal(restarted.status().user.username,'alice');assert.equal(restarted.status().revision,7);restarted.dispose()
 fs.mkdirSync(path.join(directory,'history'));const history=new OfficialAccountService(path.join(directory,'history'),vault,backup,async()=>true)
 await history.configure('https://EXAMPLE.com/');await history.configure('https://example.com')
 assert.deepEqual(history.status().serverHistory,['https://example.com'])
 await assert.rejects(history.configure('https://bad.example.com?secret=hidden'))
 assert.equal(history.status().serverHistory.length,1)
 for(let n=0;n<12;n++)await history.configure('https://history'+n+'.example.com')
 assert.equal(history.status().serverHistory.length,10);assert.equal(history.status().serverHistory[0],'https://history11.example.com')
 await history.configure('');assert.equal(history.status().serverHistory.length,10);history.dispose()
 const historyRestart=new OfficialAccountService(path.join(directory,'history'),vault,backup,async()=>true)
 assert.equal(historyRestart.status().serverHistory.length,10);assert.equal(historyRestart.status().serverHistory[0],'https://history11.example.com');historyRestart.dispose()
 // Legacy single-session installations migrate on the first account change.
 const legacy=path.join(directory,'legacy');fs.mkdirSync(legacy)
 const oldVault=new VaultService(legacy);oldVault.init('Synthetic-legacy-vault-password')
 oldVault.setCredential('official-account-session',JSON.stringify({serverUrl:'https://legacy.example.com',user:{id:'legacy',username:'legacy',role:'user'},token:'synthetic-legacy-token',syncKey:'synthetic-legacy-key',expiresAt:Date.now()+3600000}))
 fs.writeFileSync(path.join(legacy,'official-account.json'),JSON.stringify({serverUrl:'https://legacy.example.com',userId:'legacy',revision:9}))
 const migrated=new OfficialAccountService(legacy,oldVault,backup,async()=>true);await migrated.configure('https://new.example.com')
 const legacyId=migrated.status().accounts[0].id;assert(migrated.status().accounts[0].signedIn);await migrated.switchAccount(legacyId);assert.equal(migrated.status().revision,9);assert.equal(migrated.status().user.username,'legacy');migrated.dispose()
 // An expired or revoked saved account must remain selectable for reauthentication.
 const reauthDir=path.join(directory,'reauth');fs.mkdirSync(reauthDir)
 const reauthVault=new VaultService(reauthDir);reauthVault.init('Synthetic-reauth-vault-password')
 const reauth=new OfficialAccountService(reauthDir,reauthVault,backup,async()=>true)
 let rejectedPassword=false,revoked=false,reauthLogouts=0;const authTargets=[]
 reauth.transport.request=async(url,method,headers,body)=>{
  const target=new URL(url)
  if(target.pathname==='/v1/auth/login'){
   const credentials=JSON.parse(body);authTargets.push([target.origin,credentials.username])
   if(rejectedPassword)return{status:401,contents:Buffer.from('{"error":"synthetic wrong password"}')}
   const user={id:target.hostname,username:credentials.username,role:'user'}
   return{status:200,contents:Buffer.from(JSON.stringify({user,token:'synthetic-'+target.hostname,syncKey:'synthetic-key-'+target.hostname,expiresAt:Date.now()+60000}))}
  }
  if(target.pathname==='/v1/logout')reauthLogouts++
  if(target.pathname==='/v1/me' && revoked)return{status:401,contents:Buffer.from('{"error":"synthetic revoked session"}')}
  return{status:200,contents:Buffer.from('{}')}
 }
 await reauth.configure('https://first.example.test');await reauth.authenticate('login','same_user','secret1')
 reauth.persist({...reauth.state,revision:11,lastSync:4321});const first=reauth.status().activeAccountId
 await reauth.configure('http://192.0.2.75:47831');await reauth.authenticate('login','same_user','secret2')
 reauth.persist({...reauth.state,revision:23,lastSync:9876});const second=reauth.status().activeAccountId
 const firstRef='official-account-session:'+first,secondRef='official-account-session:'+second
 const session=JSON.parse(reauthVault.getCredential(firstRef).secret);session.expiresAt=Date.now()-1
 reauthVault.setCredential(firstRef,JSON.stringify(session));const secondCredential=reauthVault.getCredential(secondRef).secret
 assert.equal(reauth.status().accounts.find(p=>p.id===first).signedIn,false)
 const selected=await reauth.switchAccount(first)
 assert.equal(selected.user,null);assert.equal(selected.activeAccountId,first);assert.equal(selected.serverUrl,'https://first.example.test');assert.equal(selected.revision,11);assert.equal(selected.lastSync,4321)
 assert.equal(reauth.monitorContext().token,undefined);assert.equal(reauthVault.getCredential(secondRef).secret,secondCredential)
 await assert.rejects(()=>reauth.request('/v1/me'),/请先登录/)
 rejectedPassword=true;await assert.rejects(()=>reauth.authenticate('login','same_user','wrong1'),/synthetic wrong password/)
 assert.equal(reauth.status().user,null);assert.equal(reauth.status().activeAccountId,first);assert.equal(reauthVault.getCredential(secondRef).secret,secondCredential)
 rejectedPassword=false;await reauth.authenticate('login','same_user','secret1')
 assert.equal(reauth.status().activeAccountId,first);assert.equal(reauth.status().revision,11);assert.equal(reauth.status().accounts.length,2)
 assert.deepEqual(authTargets.at(-1),['https://first.example.test','same_user'])
 revoked=true;await assert.rejects(()=>reauth.request('/v1/me'),/synthetic revoked session/);revoked=false
 assert.equal(reauthVault.getCredential(firstRef),null)
 await reauth.switchAccount(second);const missing=await reauth.switchAccount(first)
 assert.equal(missing.user,null);assert.equal(missing.activeAccountId,first);assert.equal(missing.accounts.find(p=>p.id===second).signedIn,true)
 await reauth.authenticate('login','same_user','secret1');await reauth.switchAccount(second)
 assert.equal(reauth.status().serverUrl,'http://192.0.2.75:47831');assert.equal(reauth.status().revision,23);assert.equal(reauth.status().lastSync,9876)
 assert.equal(reauthLogouts,0);reauth.dispose()
 console.log('PASS: expired/revoked saved accounts can be selected and reauthenticated at the correct server; other sessions and per-account revisions survive')
 console.log('PASS: multi-account sessions survive switching/restart, revisions and keys stay isolated, stale requests are rejected, logout is scoped, legacy session migrates')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>service.dispose())
