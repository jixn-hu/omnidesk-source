const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
const source = process.env.OMNIDESK_MONITOR_SOURCE || path.resolve(root, 'monitor-agent')
const output = path.join(root, 'out/monitor-agent')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function verify(directory = output) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  if (manifest.protocol !== 1) throw new Error('Unsupported monitoring agent protocol')
  for (const [name, arch] of [['omnidesk-monitor-agent-linux-amd64', 62], ['omnidesk-monitor-agent-linux-arm64', 183], ['install.sh', 0], ['install-user.sh', 0], ['omnidesk-monitor-agent-windows-amd64.exe',0], ['install-windows.ps1',0]]) {
    const bytes = fs.readFileSync(path.join(directory, name))
    if (hash(bytes) !== manifest.files[name]) throw new Error('Monitoring agent hash mismatch: ' + name)
    if (arch && (bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes.readUInt16LE(18) !== arch)) throw new Error('Invalid monitoring agent architecture: ' + name)
  }
  if (!manifest.licenses?.['THIRD_PARTY.json'] || !manifest.licenses?.['Go-LICENSE']) throw new Error('Missing collector dependency licenses')
  for (const [name, expected] of Object.entries(manifest.licenses)) {
    if (!/^[\w.-]+$/.test(name) || hash(fs.readFileSync(path.join(directory, 'licenses', name))) !== expected) throw new Error('Collector license hash mismatch')
  }
  return manifest
}
function build() {
  fs.mkdirSync(output, { recursive: true })
  const sources = []
  function visit(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) { const file = path.join(directory, item.name); if (item.isDirectory()) visit(file); else if (item.name.endsWith('.go')) sources.push(path.relative(source, file), fs.readFileSync(file)) } }
  if (!fs.existsSync(path.join(source, 'go.mod'))) throw new Error('The monitor-agent source directory is missing; restore it or set OMNIDESK_MONITOR_SOURCE')
  for (const directory of ['cmd/agent', 'internal/agent', 'protocol']) visit(path.join(source, directory))
  for (const name of ['go.mod','go.sum']) sources.push(name,fs.readFileSync(path.join(source,name)))
  const fingerprint = hash(Buffer.concat(sources.map(item => Buffer.isBuffer(item) ? item : Buffer.from(item))))
  let cached = false
  try { cached = verify().sourceHash === fingerprint } catch {}
  if (!cached) for (const arch of ['amd64','arm64']) {
    const target = path.join(output, 'omnidesk-monitor-agent-linux-' + arch)
    const result = cp.spawnSync('go', ['build', '-buildvcs=false', '-trimpath', '-ldflags=-s -w', '-o', target, './cmd/agent'], { cwd: source, env: { ...process.env, GOOS:'linux', GOARCH:arch, CGO_ENABLED:'0' }, stdio:'inherit', windowsHide:true })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Monitoring agent build failed: ' + arch)
  }
  if(!cached) {
    const result=cp.spawnSync('go',['build','-buildvcs=false','-trimpath','-ldflags=-s -w','-o',path.join(output,'omnidesk-monitor-agent-windows-amd64.exe'),'./cmd/agent'],{cwd:source,env:{...process.env,GOOS:'windows',GOARCH:'amd64',CGO_ENABLED:'0'},stdio:'inherit',windowsHide:true})
    if(result.error||result.status!==0)throw result.error||new Error('Windows monitoring agent build failed')
  }
  fs.copyFileSync(path.join(root,'assets/monitor-agent/install-windows.ps1'),path.join(output,'install-windows.ps1'))
  fs.copyFileSync(path.join(root, 'assets/monitor-agent/install.sh'), path.join(output,'install.sh'))
  fs.writeFileSync(path.join(output, 'install-user.sh'), fs.readFileSync(path.join(root, 'assets/monitor-agent/install-user.sh'), 'utf8').replace(/\r\n/g, '\n'))
  const files = Object.fromEntries(['omnidesk-monitor-agent-linux-amd64','omnidesk-monitor-agent-linux-arm64','install.sh','install-user.sh','omnidesk-monitor-agent-windows-amd64.exe','install-windows.ps1'].map(name => [name, hash(fs.readFileSync(path.join(output,name)))]))
  const licensesDirectory = path.join(output, 'licenses')
  fs.mkdirSync(licensesDirectory, { recursive: true })
  const go = (args, arch = 'amd64', platform = 'linux') => {
    const result = cp.spawnSync('go', args, { cwd:source, env:{...process.env, GOOS:platform, GOARCH:arch, CGO_ENABLED:'0'}, encoding:'utf8', windowsHide:true })
    if (result.error || result.status !== 0) throw result.error || new Error('Cannot inspect collector dependency licenses: ' + result.stderr.trim())
    return result.stdout.trim()
  }
  const copyLicense = (sourceFile, target) => { if (fs.existsSync(target)) fs.chmodSync(target, 0o644); fs.writeFileSync(target, fs.readFileSync(sourceFile)) }
  copyLicense(path.join(go(['env','GOROOT']), 'LICENSE'), path.join(licensesDirectory, 'Go-LICENSE'))
  copyLicense(path.join(root,'LICENSE'), path.join(licensesDirectory, 'OmniDesk-LICENSE'))
  const modules = new Map()
  for (const [platform,arch] of [['linux','amd64'],['linux','arm64'],['windows','amd64']]) for (const line of go(['list','-buildvcs=false','-deps','-f','{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}','./cmd/agent'], arch,platform).split(/\r?\n/)) {
    const [name,version,directory] = line.split('|')
    if (version && directory) modules.set(name, {version,directory})
  }
  const dependencies = []
  for (const [name, {version,directory}] of modules) {
    const license = ['LICENSE','LICENSE.txt','LICENSE.md','COPYING'].find(file => fs.existsSync(path.join(directory,file)))
    if (!license) throw new Error('Collector dependency license missing: '+name)
    const filename = name.replace(/[^\w.-]/g,'_')+'-LICENSE'
    copyLicense(path.join(directory,license),path.join(licensesDirectory,filename))
    dependencies.push({module:name,version,license:filename})
  }
  fs.writeFileSync(path.join(licensesDirectory,'THIRD_PARTY.json'),JSON.stringify(dependencies,null,2))
  const licenses = Object.fromEntries(fs.readdirSync(licensesDirectory).map(name=>[name,hash(fs.readFileSync(path.join(licensesDirectory,name)))]))
  fs.writeFileSync(path.join(output,'manifest.json'), JSON.stringify({ protocol:1, sourceHash:fingerprint, files, licenses },null,2))
  verify()
  console.log('Verified Linux amd64/arm64 and Windows x64 monitoring agents and installers')
}
module.exports = { verify }
if (require.main === module) build()
