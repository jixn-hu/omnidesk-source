const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/agent-shell-'))
const script = fs.readFileSync(path.join(root, 'assets/monitor-agent/install.sh'), 'utf8')
const posix = directory.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,letter)=>'/'+letter.toLowerCase())
let fixture = script.replace(/\/(?:etc|usr\/local|var|run|tmp)\//g, prefix => posix + prefix)
fixture = fixture.replace(/^PATH=.*$/m, 'PATH="'+posix+'/bin:/usr/bin:/bin"')
const target = path.join(directory, 'install-fixture.sh')
fs.writeFileSync(target, fixture)
// Strip BOM/CRLF for portable shell fixture sources.
const harness = path.join(directory, 'harness.sh')
fs.writeFileSync(harness, fs.readFileSync(path.join(root, 'tools/monitor-agent-script-fixture.sh'),'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n'))
const result = cp.spawnSync('C:/Program Files/Git/bin/bash.exe', [harness, directory, target], {cwd:root,encoding:'utf8',windowsHide:true})
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
if(result.error) throw result.error
if(result.status !== 0) { console.error('Shell fixture failed; inspect isolated logs:',directory); process.exitCode=result.status || 1 }
