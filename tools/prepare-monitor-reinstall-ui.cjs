// Bundle the real React dialog with an isolated IPC fixture for browser QA.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const directory = process.env.OMNIDESK_REINSTALL_QA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-reinstall-ui-'))
fs.mkdirSync(directory, { recursive: true })
const entry = `
import React from 'react'
import {createRoot} from 'react-dom/client'
import MonitorAgentDialog from './src/renderer/src/features/monitor/MonitorAgentDialog'
import './src/renderer/src/styles/design-system.css'
import './src/renderer/src/styles/app.css'
import './src/renderer/src/styles/motion.css'
const root=createRoot(document.getElementById('root'))
const old={nodeId:'b'.repeat(24),nodeName:'原有监控节点',serverUrl:'https://old.example.test/v1/monitor'}
const base=[{id:'cloud',kind:'ssh',name:'CloudSilk德国',host:'203.0.113.5',port:22},{id:'other',kind:'ssh',name:'其他服务器',host:'203.0.113.6',port:22},{id:'windows',kind:'rdp',name:'Windows',host:'203.0.113.7',port:3389}]
let sequence=0,options={}
window.qa={calls:[],closed:0,open(value={}){
 options=value;this.calls=[]
 window.__qaState={connections:structuredClone(base),sessions:[],accountUser:{id:'qa-user',username:'jixn'},accountServerUrl:'https://monitor.example.test',openTab(){}}
 const node={id:'a'.repeat(24),name:'CloudSilk德国',metrics:{system:{os:'Linux',hostname:'cloud-host'},discovered:{ip:'203.0.113.5'}}}
 if(value.ambiguous){node.metrics=undefined;window.__qaState.connections[1].name=node.name}
 root.render(<MonitorAgentDialog key={++sequence} node={node} connectionId={value.explicit} onClose={()=>{this.closed++;root.render(null)}} />)
},resolveInfo(){this.infoResolve?.()},resolveInstall(){this.installResolve?.()}}
window.omnidesk={monitoring:{
 async agentInstallInfo(){if(options.delayInfo)await new Promise(resolve=>window.qa.infoResolve=resolve);return{ok:true,data:{hasToken:!!options.hasToken,connectionId:options.binding}}},
 onAgentInstallProgress(){return()=>{}},
 async local(){return{ok:true,data:{config:{enabled:true}}}},
 async installAgent(input){window.qa.calls.push(input);if(options.sudo && !input.sudoPassword && input.installMode!=='user')return{ok:true,data:{active:false,reported:false,needsSudoPassword:true,message:'请输入 sudo 密码，或以当前用户安装'}};if(options.sudo && input.sudoPassword==='wrong-password')return{ok:true,data:{active:false,reported:false,needsSudoPassword:true,message:'sudo 提权失败，请重试或使用当前用户'}};if(options.sudo && (input.sudoPassword || input.installMode==='user'))return{ok:true,data:{active:true,reported:true,message:input.installMode==='user'?'用户级安装已成功上报；未配置开机启动':'本次安装已成功上报'}};if(options.delayInstall)await new Promise(resolve=>window.qa.installResolve=resolve);return{ok:true,data:input.replaceBinding||options.same?{active:true,reported:true,message:'本次安装已成功上报'}:{active:false,reported:false,message:'确认后备份旧配置和状态，旧节点历史保留，新绑定重新统计流量。',replacement:old}}}
}}
window.qa.open()
`
fs.writeFileSync(path.join(directory, 'store.ts'), 'export function useApp(select:any){return select((window as any).__qaState)};useApp.getState=()=> (window as any).__qaState')
esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, outfile: path.join(directory, 'dialog.js'), platform: 'browser', format: 'iife', jsx: 'automatic', plugins: [{name:'isolated-store',setup(build){build.onResolve({filter:/store\/app$/},()=>({path:path.join(directory,'store.ts')}))}}],alias:{'@shared':path.join(root,'src/shared')} }).then(() => {
fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="dialog.css"><body><div id="root"></div><script src="dialog.js"></script></body></html>')
console.log(directory)
}).catch(error=>{console.error(error);process.exitCode=1})
