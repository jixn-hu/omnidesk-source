const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module')
const esbuild=require('esbuild'),root=path.resolve(__dirname,'..')
const output=esbuild.buildSync({entryPoints:[path.join(root,'src/main/services/monitoring.ts')],bundle:true,write:false,platform:'node',format:'cjs',alias:{'@shared':path.join(root,'src/shared')}})
const mod=new Module(__filename,module);mod.paths=module.paths;mod._compile(output.outputFiles[0].text,__filename)
const {MonitoringService}=mod.exports
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'omnidesk-enroll-'))
const secrets=new Map(),vault={status:()=> 'unlocked',getCredential:id=>secrets.get(id),setCredential:(id,secret)=>secrets.set(id,{secret}),deleteCredential:id=>secrets.delete(id)}
const connection={id:'conn',kind:'ssh',name:'auto-name',group:'auto-group',host:'qa.invalid',port:22}
const connections={get:id=>id==='conn'?connection:undefined}
const nodes=[];let creates=0,failDelete=false
const fetcher=async(url,options)=>{
 if(options.method==='GET') return new Response(JSON.stringify(nodes))
 if(options.method==='POST'){
  creates++;const node={...JSON.parse(options.body),id:String(creates).padStart(24,'0')};nodes.push(node)
  return new Response(JSON.stringify({node,token:'fixture-node-token-'+String(creates).repeat(24)}))
 }
 if(options.method==='DELETE'){
  if(failDelete)return new Response('{}',{status:500})
  const index=nodes.findIndex(node=>url.endsWith(node.id));if(index>=0)nodes.splice(index,1)
  return new Response('{"ok":true}')
 }
 throw new Error('unexpected request')
}
async function main(){
 let service=new MonitoringService(directory,vault,connections,fetcher,()=>{})
 service.configure({enabled:true,url:'https://qa.invalid',token:'fixture-admin-token-with-minimum-length'})
 const first=service.prepareAgentNode('conn'),parallel=service.prepareAgentNode('conn')
 assert.equal(first,parallel)
 const node=await first;assert.equal(creates,1);assert.equal(node.name,'auto-name');assert.equal(node.group,'auto-group')
 assert.equal(service.agentNodeForConnection('conn'),node.id)
 const token=service.agentInstallation(node.id).token
 assert(token);assert.equal((await service.prepareAgentNode('conn')).id,node.id);assert.equal(creates,1)
 // Persisted target is scoped to both service URL and SSH endpoint.
 service=new MonitoringService(directory,vault,connections,fetcher,()=>{})
 assert.equal(service.agentNodeForConnection('conn'),node.id)
 connection.host='new-host.invalid';assert.equal(service.agentNodeForConnection('conn'),undefined);assert.equal(service.agentInstallation(node.id).connectionId,undefined)
 connection.host='qa.invalid';service.configure({enabled:true,url:'https://other.invalid'});assert.equal(service.agentNodeForConnection('conn'),undefined)
 service.configure({enabled:true,url:'https://qa.invalid'});assert.equal(service.agentNodeForConnection('conn'),node.id)
 failDelete=true;await assert.rejects(()=>service.removeNode(node.id));assert.equal(service.agentInstallation(node.id).token,token);assert.equal(service.agentNodeForConnection('conn'),node.id)
 failDelete=false;await service.removeNode(node.id);assert.equal(nodes.length,0);assert.equal(service.agentInstallation(node.id).token,undefined);assert.equal(service.agentNodeForConnection('conn'),undefined)
 assert(secrets.has('omnidesk-monitor-service'),'admin token erased')
 assert(!fs.readFileSync(path.join(directory,'monitoring.json'),'utf8').includes(token),'plaintext collector token')
 const next=await service.prepareAgentNode('conn');assert.notEqual(next.id,node.id);assert.equal(creates,2)
 console.log('PASS enrollment: concurrent creation deduplicated, names inherited, restart persistence, service/endpoint scoping, deletion failure preserves credentials, success clears only node data, re-enrollment works')
}
main().catch(error=>{console.error(error);process.exitCode=1})
