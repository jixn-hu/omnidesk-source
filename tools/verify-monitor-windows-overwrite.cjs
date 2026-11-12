// Regression harness for Windows Agent overwrite.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

// Only temporary files and mocked service/ACL functions are used.
const template = fs.readFileSync(path.join(__dirname, '../assets/monitor-agent/install-windows.ps1'), 'utf8')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-overwrite-'))
const config = { managedBy: 'omnidesk-monitor-windows-v1', nodeId: 'a'.repeat(24), serverUrl: 'https://one.invalid/v1/monitor', token: 'synthetic-new-token', statePath: '', includeNics: [], intervalSeconds: 77, installationId: 'new-installation' }
const binary = Buffer.from('MZ-synthetic-new-binary'), oldBinary = Buffer.from('MZ-synthetic-old-binary')
const oldState = Buffer.from('{"epoch":"previous-flow","seq":19,"up":12345,"down":67890}')
function scenario(name, options = {}) {
 const area = path.join(directory, name), root = path.join(area, 'OmniDeskMonitor')
 fs.mkdirSync(root, { recursive: true })
 const old = { ...config, token: 'synthetic-old-token', statePath: path.join(root, 'state.json'), includeNics: ['Ethernet'], disableDiscovery: true, installationId: 'old-installation', ...options.old }
 if (!options.fresh && !options.noConfig) fs.writeFileSync(path.join(root, 'agent.json'), JSON.stringify(old))
 if (!options.fresh) fs.writeFileSync(path.join(root, 'omnidesk-monitor-agent.exe'), oldBinary)
 if (!options.fresh && !options.noState) fs.writeFileSync(path.join(root, 'state.json'), oldState)
 const before = fs.existsSync(path.join(root, 'agent.json')) ? fs.readFileSync(path.join(root, 'agent.json')) : null
 const payload = { config, binary: binary.toString('base64'), sha256: options.badHash ? '0'.repeat(64) : crypto.createHash('sha256').update(binary).digest('hex') }
 const script = path.join(area, 'install.ps1'), resultPath = path.join(area, 'result.json'), driver = path.join(area, 'driver.ps1')
 fs.writeFileSync(script, String.fromCharCode(0xfeff) + template.replace(/^#requires.*\r?\n/gm, '').replace('__OMNIDESK_BUNDLE__', Buffer.from(JSON.stringify(payload)).toString('base64')))
 fs.writeFileSync(driver, `
$ErrorActionPreference='Stop'
$env:ProgramData=$env:QA_AREA
$global:exists=$env:QA_EXISTS -eq '1'
$global:status='Running'
$global:starts=0; $global:stops=0; $global:creates=0; $global:deletes=0; $global:prompts=0; $global:stateAtStart=$null
$global:messages=@()
function global:Write-Host { param($Object,[string]$ForegroundColor) $global:messages+=@{text=[string]$Object;color=$ForegroundColor} }
function global:Get-Service {
 param($Name,$ErrorAction)
 if ($global:exists) {
  $value=[pscustomobject]@{Status=$global:status}
  $value | Add-Member ScriptMethod WaitForStatus { param($expected,$timeout) if ($global:status -ne $expected) { throw 'Unexpected service status' } }
  return $value
 }
}
function global:Stop-Service { param($Name,$ErrorAction) $global:stops++; $global:status='Stopped' }
function global:Start-Service {
 param($Name,$ErrorAction)
 $global:starts++
 $s=Join-Path (Join-Path $env:QA_AREA 'OmniDeskMonitor') 'state.json'
 if ($global:starts -eq 1) { $global:stateAtStart=Test-Path -LiteralPath $s }
 if ($env:QA_FAIL -eq '1' -and $global:starts -eq 1) { [IO.File]::WriteAllText($s,'failed-start state'); throw 'Synthetic start failure' }
 $global:status='Running'
}
function global:New-Service { param($Name,$DisplayName,$BinaryPathName,$StartupType,$Credential) $global:creates++; $global:exists=$true }
function global:icacls.exe { $global:LASTEXITCODE=0 }
function global:sc.exe { $global:deletes++; $global:LASTEXITCODE=0 }
function global:Read-Host { param($Prompt) $global:prompts++; return $env:QA_ANSWER }
$errorText=$null
try { & $env:QA_SCRIPT } catch { $errorText=$_.Exception.Message }
[IO.File]::WriteAllText($env:QA_RESULT,(@{error=$errorText;starts=$global:starts;stops=$global:stops;creates=$global:creates;deletes=$global:deletes;prompts=$global:prompts;stateAtStart=$global:stateAtStart;status=$global:status;messages=$global:messages}|ConvertTo-Json -Depth 5))
if ($errorText) { exit 1 }
`)
 const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], { windowsHide: true, encoding: 'utf8', env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'), QA_AREA: area, QA_SCRIPT: script, QA_RESULT: resultPath, QA_EXISTS: options.fresh ? '0' : '1', QA_FAIL: options.fail ? '1' : '0', QA_ANSWER: options.answer ?? 'Y' } })
 assert(fs.existsSync(resultPath), child.stderr || child.stdout)
 const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')), backups = fs.readdirSync(root).filter(item => item.startsWith('backup-'))
 const read = file => fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : null
 return {root,result,backups,read,before,child}
}
function success(v) {
 assert.equal(v.child.status,0,v.result.error||v.child.stderr);assert.equal(v.result.status,'Running');assert.deepEqual(v.read('omnidesk-monitor-agent.exe'),binary)
 const messages=v.result.messages, text=messages.map(item=>item.text).join('\n')
 assert(messages.some(item=>item.text.includes('INSTALLATION COMPLETE') && item.color==='Green'),'successful install has a green completion banner')
 assert(text.includes('采集端安装完成') && text.includes(config.serverUrl) && text.includes('77 秒'))
 assert(text.includes('首次上报') && text.includes('以监控页面收到上报为准'),'service startup must not claim a confirmed report')
 assert(!text.includes(config.token),'node credentials must not enter terminal output')
 return JSON.parse(v.read('agent.json'))
}
function original(v) { assert.deepEqual(v.read('agent.json'),v.before);assert.deepEqual(v.read('omnidesk-monitor-agent.exe'),oldBinary) }
const same = scenario('same')
const next = success(same)
assert.deepEqual(same.read('state.json'), oldState)
assert.equal(same.result.prompts, 0)
assert.equal(same.result.stateAtStart, true)
assert.equal(same.result.creates, 0)
assert.equal(next.token, config.token)
assert.equal(next.installationId, config.installationId)
assert.deepEqual(next.includeNics, ['Ethernet'])
assert.equal(next.disableDiscovery, true)
assert.equal(next.intervalSeconds, 77)
assert.deepEqual(fs.readFileSync(path.join(same.root, same.backups[0], 'state.json')), oldState)
const trailing = scenario('trailing', { old: { serverUrl: config.serverUrl + '/' } })
success(trailing)
assert.equal(trailing.result.prompts, 0)
assert.deepEqual(trailing.read('state.json'), oldState)
for (const [name, old] of [['node', { nodeId: 'b'.repeat(24) }], ['backend', { serverUrl: 'http://two.invalid/v1/monitor' }]]) {
 const v = scenario(name, { old })
 const value = success(v)
 assert.equal(v.result.prompts, 1)
 assert.equal(v.result.creates, 0)
 assert.equal(v.result.stateAtStart, false)
 assert.equal(v.read('state.json'), null)
 assert.equal(value.nodeId, config.nodeId)
 assert.equal(value.serverUrl, config.serverUrl)
 assert.deepEqual(fs.readFileSync(path.join(v.root, v.backups[0], 'state.json')), oldState)
 const failed = scenario(name + '-rollback', { old, fail: true })
 assert.match(failed.result.error, /Synthetic start failure/)
 assert(!failed.result.messages.some(item=>item.text.includes('INSTALLATION COMPLETE')),'failed install must not display success')
 original(failed)
 assert.deepEqual(failed.read('state.json'), oldState)
 assert.equal(failed.result.starts, 2)
 assert.equal(failed.result.status, 'Running')
}
for (const answer of ['', 'N']) {
 const v = scenario('cancel-' + (answer || 'empty'), { old: { nodeId: 'b'.repeat(24) }, answer })
 assert.match(v.result.error, /cancelled/)
 original(v)
 assert.deepEqual(v.read('state.json'), oldState)
 assert.equal(v.result.stops, 0)
 assert.equal(v.backups.length, 0)
}
const absent = scenario('no-state-rollback', { old: { nodeId: 'b'.repeat(24) }, fail: true, noState: true })
original(absent)
assert.equal(absent.read('state.json'), null)
const failed = scenario('same-rollback', { fail: true })
original(failed)
assert.deepEqual(failed.read('state.json'), oldState)
const fresh = scenario('new', { fresh: true })
success(fresh)
assert.equal(fresh.result.creates, 1)
assert.equal(fresh.result.prompts, 0)
const newFailure = scenario('new-rollback', { fresh: true, fail: true })
assert.match(newFailure.result.error, /Synthetic start failure/)
for (const file of ['agent.json', 'omnidesk-monitor-agent.exe', 'state.json']) assert.equal(newFailure.read(file), null)
assert.equal(newFailure.result.deletes, 1)
const unmanaged = scenario('unmanaged', { old: { managedBy: 'other-tool' } })
assert.match(unmanaged.result.error, /not managed/)
original(unmanaged)
assert.equal(unmanaged.result.stops, 0)
const missing = scenario('missing-config', { noConfig: true })
assert.match(missing.result.error, /not managed/)
assert.equal(missing.result.stops, 0)
const corrupt = scenario('bad-hash', { badHash: true })
assert.match(corrupt.result.error, /integrity/)
original(corrupt)
assert.equal(corrupt.result.stops, 0)
console.log('PASS Windows PowerShell installer: overwrite, token update, state/settings, replacement confirmation, cancel untouched, rollback, new install/failure cleanup and guards.')
const actual = fs.realpathSync(directory)
assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()))
assert(path.basename(actual).startsWith('omnidesk-overwrite-'))
fs.rmSync(actual, { recursive: true, force: true })
