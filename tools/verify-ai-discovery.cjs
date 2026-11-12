const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { createServer } = require('node:http')
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(root, 'tmp/ai-discovery-qa-'))
require('esbuild').buildSync({ entryPoints: ['ai','connection-store','vault'].map(name => path.join(root, `src/main/services/${name}.ts`)), outdir: directory, bundle: true, platform: 'node', format: 'cjs', alias: { '@shared': path.join(root,'src/shared') } })
const { AiService } = require(path.join(directory,'ai.js')), { ConnectionStore } = require(path.join(directory,'connection-store.js')), { VaultService } = require(path.join(directory,'vault.js'))
const connections = new ConnectionStore(directory), vault = new VaultService(directory); vault.init('QA-discovery-vault')
let handler, serial = 0, ai, executionCount = 0
const requests = [], failures = []
const done = text => ({ role: 'assistant', content: text })
const tool = (name,args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'qa_discovery_'+ ++serial, type:'function', function:{ name, arguments:JSON.stringify(args) } }] })
const latest = body => JSON.parse(body.messages.filter(item=>item.role==='tool').at(-1).content)
const model = createServer(async (request,response) => {
  try {
    const chunks=[]; for await(const chunk of request) chunks.push(chunk)
    const body=JSON.parse(Buffer.concat(chunks)); requests.push(body)
    const message=await handler(body)
    response.writeHead(200,{'Content-Type':'application/json'}); response.end(JSON.stringify({ choices:[{message}] }))
  } catch(error) { failures.push(error); response.writeHead(500); response.end('QA discovery failure') }
})
const until = async (predicate,label='idle') => { const end=Date.now()+20000; while(!predicate()) { if(Date.now()>end) throw new Error('Timeout: '+label); await new Promise(resolve=>setTimeout(resolve,5)) } }
const idle = async () => { await until(()=>ai.state().status==='idle'); assert.deepEqual(failures,[]) }
async function run(steps, ids=[], text='QA discovery task') {
 let index=0; handler=body=>{ assert(index<steps.length,'unexpected model request');const step=steps[index++]; return typeof step==='function'?step(body):step }
 await ai.send(text,ids);await idle();assert.equal(index,steps.length)
}
const options={ execute:async()=>{ executionCount++;throw new Error('metadata tasks must not connect') } }
async function main() {
 model.listen(0,'127.0.0.1');await once(model,'listening')
 ai=new AiService(directory,connections,vault,options)
 ai.saveConfiguration({baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'qa-discovery'})
 await run([tool('list_servers',{}),body=>{assert.equal(latest(body).total,0);return done('No local servers')}])
 assert.equal(ai.state().scopeMode,'all');assert.equal(ai.state().scopeCount,0)
 const records=[]
 for(let index=0;index<245;index++) records.push(connections.save({kind:index===244?'rdp':'ssh',name:index===1||index===2?'QA 同名服务器':`QA Server ${index}`,host:`192.0.2.${index+1}`,port:index===244?3389:22,username:'qa',authMethod:'password',group:index===0?'QA 代理池':'QA Group',tags:index===0?['生产']:[],note:index<12?'x'.repeat(7500):'QA note',...(index===0?{credentialRef:'QA-secret-reference'}:{})}))
 vault.setCredential('QA-secret-reference','QA-connection-password')
 let collected=[],pages=0
 handler=body=>{
  if(body.messages.at(-1).role==='user') {
   assert.match(body.messages[0].content,/全部本机服务器/);assert(!body.messages[0].content.includes(records[0].id))
   assert.match(body.messages[0].content,/歧义/)
   return tool('list_servers',{})
  }
  const result=latest(body);assert(!result.truncated);assert.equal(result.total,245);assert.equal(result.scope,'all');assert(result.servers.length>0)
  collected.push(...result.servers.map(item=>item.id));pages++
  return result.nextOffset===null?done('All 245 servers read'):tool('list_servers',{offset:result.nextOffset})
 }
 await ai.send('查看所有服务器的信息',[]);await idle()
 assert.equal(new Set(collected).size,245);assert.equal(collected.length,245);assert(pages>5)
 assert.deepEqual(ai.state().selectedIds,[]);assert.equal(ai.state().scopeCount,245)
 await run([tool('list_servers',{query:'192.0.2.1:22 生产'}),body=>{const result=latest(body);assert.equal(result.total,1);assert.equal(result.servers[0].id,records[0].id);assert.equal(result.servers[0].address,'192.0.2.1:22');return done('Found by address/tag')}])
 let readStep=0
 handler=()=>readStep++===0?tool('update_metadata',{server_ids:[records[0].id],changes:{note:{mode:'replace',value:'needs confirmation'}}}):done('Read permission declined write')
 await ai.send('QA read mode mutation proposal',[])
 await until(()=>ai.state().pending?.kind==='edit','read mutation approval')
 assert.equal(connections.get(records[0].id).note,'x'.repeat(7500))
 ai.confirm(ai.state().pending.id,false);await idle()
 assert.equal(connections.get(records[0].id).note,'x'.repeat(7500))
 ai.setPermissionMode('edit')
 const unrelated=connections.get(records[1].id)
 await run([tool('list_servers',{query:'代理池'}),body=>{const result=latest(body);assert.equal(result.total,1);return tool('update_metadata',{server_ids:[result.servers[0].id],changes:{note:{mode:'replace',value:'QA 用户指定的新备注'}}})},body=>{assert.equal(latest(body).updated[0].note,'QA 用户指定的新备注');return done('Only requested server changed')}],[],'找到代理池服务器，把备注改为 QA 用户指定的新备注')
 assert.deepEqual(connections.get(records[1].id),unrelated);assert.equal(ai.state().scopeMode,'all');assert.deepEqual(ai.state().selectedIds,[])
 await run([tool('list_servers',{query:records[1].host}),body=>{assert.equal(latest(body).total,0);return tool('update_metadata',{server_ids:[records[1].id],changes:{note:{mode:'replace',value:'outside manual selection'}}})},body=>{assert.match(latest(body).error,/选中/);return done('Manual scope respected')}],[records[0].id],'QA limited task')
 assert.deepEqual(connections.get(records[1].id),unrelated);assert.equal(ai.state().scopeMode,'selected')
 await run([body=>{assert(!JSON.stringify(body.messages).includes('QA limited task'));return tool('list_servers',{query:records[1].host})},body=>{assert.equal(latest(body).servers[0].id,records[1].id);return done('All scope restored')}],[],'QA restored global scope')
 // Multiple matching names are reported with IDs/addresses and the model can ask before acting.
 handler=body=>{
  const last=body.messages.at(-1)
  if(last.role==='user') return tool('list_servers',{query:'QA 同名服务器'})
  const result=latest(body)
  if(result.servers){assert.equal(result.total,2);return tool('ask_user',{title:'确认目标服务器',message:'同名服务器有 192.0.2.2 和 192.0.2.3。是否仅修改 192.0.2.2？'})}
  assert.equal(result.confirmed,true);return done('Target confirmed without selecting in sidebar')
 }
 await ai.send('QA ambiguous target',[]);await until(()=>ai.state().pending)
 assert.equal(ai.state().pending.kind,'question');ai.confirm(ai.state().pending.id,true);await idle()
 // Unrelated concurrent edits do not break catalog discovery; target revisions remain protected.
 await run([tool('list_servers',{query:records[0].host}),body=>{const item=connections.get(records[0].id);connections.batchMetadata({items:[{id:item.id,updatedAt:item.updatedAt}],changes:{note:{mode:'replace',value:'QA external edit'}}});return tool('update_metadata',{server_ids:[item.id],changes:{note:{mode:'replace',value:'stale mutation'}}})},body=>{assert.match(latest(body).error,/其他操作修改/);return tool('list_servers',{query:records[0].host})},body=>{assert.equal(latest(body).servers[0].note,'QA external edit');return done('Fresh read after concurrent edit')}])
 for(const args of [{offset:-1},{offset:'0'},{limit:0},{limit:101},{query:'x'.repeat(501)}]) await run([tool('list_servers',args),body=>{assert(latest(body).error);return done('Bad query rejected')}])
 // A new unrelated connection added mid-task waits for the next all-server task.
 let added
 await run([body=>{added=connections.save({kind:'ssh',name:'QA Added Mid-task',host:'198.51.100.20',port:22,username:'qa',authMethod:'password'});return tool('update_metadata',{server_ids:[added.id],changes:{note:{mode:'replace',value:'not in task snapshot'}}})},body=>{assert(latest(body).error);return done('No mid-task scope widening')}])
 await run([tool('list_servers',{query:'QA Added Mid-task'}),body=>{assert.equal(latest(body).total,1);return done('Next task discovers new connection')}])
 // More than 200 existing servers do not prevent creating another connection in all-server mode.
 await run([tool('create_server',{kind:'ssh',name:'QA AI Created',host:'198.51.100.21',port:22,username:'qa'}),body=>{assert(latest(body).created);return done('Created with large catalog')}])
 assert.equal(ai.state().scopeCount,247);assert.deepEqual(ai.state().selectedIds,[])
 const globalId=ai.state().conversationId
 const selectedId=ai.createConversation().conversationId
 await run([done('QA selected persisted')],[records[0].id])
 ai.dispose();ai=new AiService(directory,connections,vault,options)
 assert.equal(ai.state().conversationId,selectedId);assert.equal(ai.state().scopeMode,'selected')
 ai.selectConversation(globalId);assert.equal(ai.state().scopeMode,'all');assert.deepEqual(ai.state().selectedIds,[])
 const serialized=JSON.stringify(requests)
 for(const secret of ['QA-secret-reference','QA-connection-password','credentialRef','sharedCredentialId']) {
  assert(!serialized.includes(secret),secret+' leaked')
 }
 assert.equal(executionCount,0)
 console.log('PASS no-selection read/edit tasks, empty and 245-server catalogs, complete adaptive pagination, address/tag/group lookup and exact-target metadata updates')
 console.log('PASS explicit manual limits, scope transitions/history reset, ambiguous target confirmation, concurrent edit guards, query validation, large-catalog creation and persisted scopes')
 console.log('PASS credential-free projection and no automatic SSH/Windows connections for catalog discovery')
 console.log('QA_DIRECTORY='+directory)
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{ai?.dispose();model.closeAllConnections();await new Promise(resolve=>model.close(resolve))})
