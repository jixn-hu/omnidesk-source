const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{once}=require('node:events'),{WebSocket}=require('ws'),esbuild=require('esbuild')
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(root,'tmp/rdp-resume-qa-')),libraries=path.join(root,'out/native-freerdp'),sdk=path.join(root,'tmp/freerdp-sdk'),msys='C:/msys64/ucrt64'
const env={...process.env,PATH:libraries+';'+msys+'/bin;'+process.env.PATH,OPENSSL_MODULES:libraries,WLOG_LEVEL:'OFF'}
const bundle=(source,name)=>{const outfile=path.join(directory,name+'.cjs');esbuild.buildSync({entryPoints:[path.join(root,source)],outfile,bundle:true,format:'cjs',platform:'node',packages:'external',alias:{'@shared':path.join(root,'src/shared')}});return require(outfile)}
const {FreeRdpService}=bundle('src/main/services/freerdp.ts','service'),{nativeCommand,nativeNumbers}=bundle('src/shared/freerdp-protocol.ts','protocol')
const wait=async(check,message)=>{for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,20))}throw Error(typeof message==='function'?message():message)}
async function main(){
 execFileSync(path.join(msys,'bin/openssl.exe'),['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{env,stdio:'ignore',windowsHide:true})
 execFileSync(path.join(msys,'bin/gcc.exe'),['native/freerdp/test-resume-peer.c','-I'+sdk+'/include/freerdp3','-I'+sdk+'/include/winpr3','-L'+sdk+'/lib','-lfreerdp3','-lwinpr3','-lws2_32','-D__STDC_NO_THREADS__','-Wno-deprecated-declarations','-o',path.join(directory,'resume-peer.exe')],{cwd:root,env,stdio:'inherit',windowsHide:true})
 const digest=execFileSync(path.join(msys,'bin/openssl.exe'),['dgst','-md4','-provider','legacy','-binary'],{input:Buffer.from('Synthetic-resume-password','utf16le'),env,windowsHide:true}).toString('hex');fs.writeFileSync(path.join(directory,'sam'),'qa-local-only:::'+digest+':\n')
 for(const scenario of ['success','success-nla','takeover','explicit','nocookie','cancel']){
  let text='',stderr='';const peer=spawn(path.join(directory,'resume-peer.exe'),[path.join(directory,'cert.pem'),path.join(directory,'key.pem'),scenario,path.join(directory,'sam')],{env,windowsHide:true});peer.stdout.on('data',b=>{text+=b});peer.stderr.on('data',b=>{stderr+=b})
  const service=new FreeRdpService(libraries,{verifyPem:async()=>{}},undefined,undefined,directory)
  let socket,transport
  try{
   await wait(()=>/port (\d+)/.test(text),'peer startup '+stderr);const port=Number(/port (\d+)/.exec(text)[1]);transport=await service.prepare('127.0.0.1',port,{username:'qa-local-only',password:'Synthetic-resume-password',domain:''},{engine:'freerdp',ignoreCertificate:true})
   socket=new WebSocket(transport.wsUrl);const packets=[];socket.on('message',b=>packets.push(Buffer.from(b)));await once(socket,'open');socket.send(nativeCommand(3,nativeNumbers(800,600,100)))
   await wait(()=>packets.some(p=>p[0]===1),()=> 'initial connection '+text+' '+stderr+' '+packets.filter(p=>p[0]===3).map(p=>p.subarray(5).toString()).join('; '))
   if(scenario==='cancel'){await wait(()=>packets.some(p=>p[0]===11),'no resume pending');socket.close();await new Promise(r=>setTimeout(r,1800));assert(!text.includes('client 1 '),text)}
   else if(scenario==='success'||scenario==='success-nla'){await wait(()=>packets.some(p=>p[0]===11&&p.readUInt32LE(1)===0),'resume failed '+text+' '+stderr);assert(text.includes('client 1 automatic=0 username=0 password=0 cookie=28 logon=42'),text)}
   else{await wait(()=>packets.some(p=>p[0]===3),'missing terminal state '+text+' '+stderr);if(scenario==='takeover'){assert(text.includes('client 1 automatic=0 username=0 password=0 cookie=28 logon=42'),text);assert(packets.filter(p=>p[0]===3).some(p=>p.subarray(5).toString().includes('恢复被拒绝')),packets.filter(p=>p[0]===3).map(p=>p.subarray(5).toString()).join('\n'))}else assert(!packets.some(p=>p[0]===11),scenario+' attempted recovery')}
   assert(!text.includes('UNSAFE_LOGON'),text);console.log('PASS: '+scenario)
  }finally{if(socket)socket.terminate();if(transport)service.release(transport.sessionId);await service.dispose();peer.kill()}
 }
 const log=fs.readFileSync(path.join(directory,'freerdp-diagnostics.jsonl'),'utf8');assert(!log.includes('Synthetic-resume-password'));assert(!log.includes('ArcRandom'));console.log('PASS: bounded structured diagnostics contain no credentials; '+directory)
}
main().catch(e=>{console.error(e);process.exitCode=1})
