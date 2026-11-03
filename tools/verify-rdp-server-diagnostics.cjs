const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const scriptPath = resolve(__dirname, 'diagnose-rdp-server.ps1').replaceAll("'", "''")
const source = readFileSync(resolve(__dirname, 'diagnose-rdp-server.ps1'), 'utf8')
assert.doesNotMatch(source, /\b(?:Set-ItemProperty|New-ItemProperty|Set-CimInstance|Set-WmiInstance|Invoke-CimMethod|Restart-Service|Stop-Service|Start-Service|Enable-PSRemoting|Set-ExecutionPolicy|Invoke-Expression|Start-Process)\b/i)

function scenario({ failWmi = false, missingPolicy = false, missingTls = false, denyRegistry = false, omitListener = false, fallbackWmi = false, modern = false } = {}) {
  const mock = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
function Get-Command { param($Name, $ErrorAction); if ('${fallbackWmi}' -eq 'false') { [pscustomobject]@{ Name = $Name } } }
function Read-MockedWmi {
    param($Class, $Namespace, $Filter)
    if ('${failWmi}' -eq 'true') { throw 'Synthetic WMI access denied' }
    if ($Class -eq 'Win32_OperatingSystem') {
        return [pscustomobject]@{ Caption = 'Synthetic Windows Server'; Version = '10.0.20348'; BuildNumber = '20348'; OSArchitecture = '64-bit'; Password = 'do-not-collect' }
    }
    if ('${omitListener}' -eq 'true') { return }
    [pscustomobject]@{ TerminalName = 'RDP-tcp'; SecurityLayer = ${modern ? 2 : 0}; UserAuthenticationRequired = 1; MinEncryptionLevel = 3; PolicySourceSecurityLayer = 1; PolicySourceUserAuthenticationRequired = 0; SSLCertificateSHA1Hash = 'SYNTHETIC'; SSLCertificateSHA1HashType = 1; Password = 'do-not-collect' }
}
function Get-CimInstance { param($Class, $Namespace, $Filter, $ErrorAction); Read-MockedWmi -Class $Class -Namespace $Namespace -Filter $Filter }
function Get-WmiObject { param($Class, $Namespace, $Filter, $ErrorAction, $Authentication, $Impersonation); if ($Authentication -ne 'PacketPrivacy') { throw 'PacketPrivacy required' }; Read-MockedWmi -Class $Class -Namespace $Namespace -Filter $Filter }
function Get-ItemProperty {
    param($LiteralPath, $ErrorAction)
    if ('${denyRegistry}' -eq 'true') { throw 'Synthetic registry access denied' }
    if ($LiteralPath -like '*Policies*') {
        if ('${missingPolicy}' -eq 'true') { throw (New-Object System.Management.Automation.ItemNotFoundException 'Synthetic absent policy') }
        return [pscustomobject]@{ SecurityLayer = ${modern ? 2 : 0}; UserAuthentication = 1; MinEncryptionLevel = 3 }
    }
    if ($LiteralPath -like '*SCHANNEL*') {
        if ('${missingTls}' -eq 'true') { throw (New-Object System.Management.Automation.ItemNotFoundException 'Synthetic system defaults') }
        return [pscustomobject]@{ Enabled = 1 }
    }
    [pscustomobject]@{ SecurityLayer = 0; UserAuthentication = 1; MinEncryptionLevel = 3; PortNumber = 3389 }
}
function Get-Service { param($Name, $ErrorAction); [pscustomobject]@{ Status = 'Running' } }
& '${scriptPath}'
`
  const encoded = Buffer.from(mock, 'utf16le').toString('base64')
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true })
  assert.doesNotMatch(output, /do-not-collect/)
  return JSON.parse(output.replace(/^\uFEFF/, ''))
}

const configured = scenario()
assert.equal(configured.readOnly, true)
assert.equal(configured.operatingSystem.data.BuildNumber, '20348')
assert.equal(configured.listener.data.SecurityLayer, 0)
assert.equal(configured.listener.data.UserAuthenticationRequired, 1)
assert.equal(configured.policyRegistry.data.SecurityLayer, 0)
assert.equal(configured.tls12ServerRegistry.data.DisabledByDefault, null)
assert.equal(configured.remoteDesktopService.data.status, 'Running')

const modern = scenario({ modern: true })
assert.equal(modern.listener.data.SecurityLayer, 2)
assert.equal(modern.listenerRegistry.data.SecurityLayer, 0)
assert.equal(modern.policyRegistry.data.SecurityLayer, 2)
assert.equal(modern.listener.data.UserAuthenticationRequired, 1)

const defaults = scenario({ missingPolicy: true, missingTls: true })
assert.equal(defaults.policyRegistry.ok, true)
assert.equal(defaults.policyRegistry.data.state, 'notConfigured')
assert.equal(defaults.tls12ServerRegistry.data.state, 'notConfigured')
assert.equal(defaults.tls12ServerRegistry.data.Enabled, undefined)

const denied = scenario({ failWmi: true, denyRegistry: true })
assert.equal(denied.listener.ok, false)
assert.equal(denied.listener.data, null)
assert.equal(denied.operatingSystem.ok, false)
assert.equal(denied.policyRegistry.ok, false)
assert.match(denied.policyRegistry.error, /access denied/)
assert.equal(denied.remoteDesktopService.ok, true)

const absent = scenario({ omitListener: true })
assert.equal(absent.listener.ok, false)
assert.match(absent.listener.error, /not found/)

const fallback = scenario({ fallbackWmi: true })
assert.equal(fallback.listener.ok, true)
assert.equal(fallback.operatingSystem.data.Caption, 'Synthetic Windows Server')
console.log('PASS read-only server diagnostics: explicit legacy policy, TLS defaults, access denial, absent listener, WMI fallback, no credential collection or mutations')
