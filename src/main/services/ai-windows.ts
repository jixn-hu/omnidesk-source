import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { ExecResult, RdpConnection } from '@shared/types.js'
import { parseConnectionAddress } from '@shared/connection-identity.js'
import type { VaultService } from './vault.js'
import type { SharedCredentialStore } from './shared-credentials.js'
import type { VpnService } from './vpn.js'
import { resolveConnectionCredential } from './credential-resolver.js'
import { redactAiText, windowsQueries, type WindowsTopic } from './ai-tools.js'

// Only this static script appears in the process command line. Credentials travel over stdin.
export const windowsInspectionScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$session = $null
$result = $null
$stage = 'connect'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $password = ConvertTo-SecureString $request.password -AsPlainText -Force
  $credential = New-Object Management.Automation.PSCredential($request.username, $password)
  $options = New-CimSessionOption -PacketPrivacy -PacketIntegrity -Impersonation Impersonate
  $session = New-CimSession -ComputerName $request.host -Credential $credential -SessionOption $options -OperationTimeoutSec 20
  $stage = 'query'
  $data = @(switch ($request.topic) {
${Object.entries(windowsQueries).map(([topic, query]) => `    '${topic}' { ${query} }`).join('\n')}
    default { throw 'Unsupported Windows inspection topic' }
  })
  $output = ConvertTo-Json -InputObject $data -Depth 6 -Compress
  $truncated = $false
  if ([Text.Encoding]::UTF8.GetByteCount($output) -gt 32768) {
    $output = $output.Substring(0, [math]::Min($output.Length, 32768))
    while ([Text.Encoding]::UTF8.GetByteCount($output) -gt 32768) { $output = $output.Substring(0, $output.Length - 1) }
    $truncated = $true
  }
  $result = @{ ok=$true; stdout=$output; truncated=$truncated }
} catch {
  $result = @{ ok=$false; stage=$stage; message=$_.Exception.Message; hresult=('{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFFL)) }
} finally {
  if ($session) { Remove-CimSession $session -ErrorAction SilentlyContinue }
  if ($password) { $password.Dispose() }
  $request = $null
  $credential = $null
}
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 4 -Compress))
`

export function windowsUsername(username: string, domain?: string): string {
  return domain && !username.includes('\\') && !username.includes('@') ? domain + '\\' + username : username
}

function unavailable(message: string): Error { return Object.assign(new Error(message), { windowsUnavailable: true }) }

function checkRpc(host: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: 135 })
    const done = (error?: Error) => {
      socket.destroy()
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }
    const cancel = () => done(new Error('Windows 查询已取消'))
    socket.setTimeout(3000)
    socket.once('connect', () => done())
    socket.once('timeout', () => done(unavailable(`Windows 管理通道不可达：${host}:135 超时。请检查目标远程 WMI、RPC 防火墙规则及动态 RPC 端口；RDP 端口可连不代表管理通道可用。`)))
    socket.once('error', () => done(unavailable(`Windows 管理通道不可达：无法连接 ${host}:135。请检查目标远程 WMI、RPC 防火墙规则及动态 RPC 端口。`)))
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export async function inspectAiWindows(vault: VaultService, shared: SharedCredentialStore, vpn: VpnService,
  connection: RdpConnection, topic: WindowsTopic, signal: AbortSignal, beforeInspect: (username: string) => void): Promise<ExecResult> {
  if (vault.status() !== 'unlocked') throw new Error('请先解锁本机保险箱')
  signal.throwIfAborted()
  if (process.platform !== 'win32') throw new Error('Windows WMI 查询需要在 Windows 客户端运行')
  if (!Object.hasOwn(windowsQueries, topic)) throw new Error('请选择受支持的 Windows 只读查询')
  if (connection.proxy && connection.proxy.type !== 'none') throw new Error('Windows WMI 查询不支持 RDP 连接代理，请使用可直连目标管理通道的网络')
  if (connection.vpn?.name && !await vpn.isConnected(connection.vpn.name)) throw new Error('请先连接该服务器要求的系统 VPN，再重试')
  signal.throwIfAborted()
  const { host } = parseConnectionAddress(connection.host, connection.port)
  await checkRpc(host, signal)
  signal.throwIfAborted()
  if (vault.status() !== 'unlocked') throw new Error('请先解锁本机保险箱')
  const credential = resolveConnectionCredential(connection, shared, vault)
  if (!credential?.secret) throw new Error('此 Windows 连接未保存密码，请在连接编辑或公共凭据中保存后重试，不要在 AI 对话中填写密码')
  const username = windowsUsername(credential.username || connection.username, credential.domain ?? connection.domain)
  beforeInspect(username)
  signal.throwIfAborted()
  const secrets = [credential.secret, credential.passphrase].filter((value): value is string => !!value)
  const started = Date.now()
  const powerShellDirectory = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
  environment.PSModulePath = join(powerShellDirectory, 'Modules')
  return new Promise((resolve, reject) => {
    const helper = spawn(join(powerShellDirectory, 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsInspectionScript, 'utf16le').toString('base64')],
      { windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', bytes = 0, settled = false
    const finish = (error?: Error, result?: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      helper.kill()
      if (error) reject(Object.assign(new Error(redactAiText(error.message, secrets)), { windowsUnavailable: (error as { windowsUnavailable?: boolean }).windowsUnavailable === true }))
      else resolve(result!)
    }
    const cancel = () => finish(new Error('Windows 查询已取消'))
    const timer = setTimeout(() => finish(unavailable('Windows WMI 查询超时，请检查管理通道、动态 RPC 端口和账号权限')), 30000)
    signal.addEventListener('abort', cancel, { once: true })
    helper.on('error', () => finish(new Error('无法启动 Windows PowerShell，请检查本机系统组件')))
    helper.stdin.on('error', () => finish(new Error('Windows 查询辅助进程未能接收参数')))
    helper.stdout.setEncoding('utf8')
    helper.stdout.on('data', (text: string) => {
      bytes += Buffer.byteLength(text)
      if (bytes > 256 * 1024) finish(new Error('Windows 查询返回内容超过限制，请缩小查询范围'))
      else output += text
    })
    // PowerShell diagnostics are never forwarded raw; they can contain authentication data.
    helper.stderr.resume()
    helper.on('close', code => {
      if (settled) return
      let result: any
      try { result = JSON.parse(output.replace(/^\uFEFF/, '')) } catch { finish(new Error('Windows PowerShell 未返回有效查询结果，请检查本机 CIM 组件')); return }
      if (code !== 0 || !result?.ok || typeof result.stdout !== 'string') {
        const reason = result?.hresult === '80070005' ? '访问被拒绝，请检查此账号的远程 WMI 权限及本地账号远程 UAC 限制'
          : result?.hresult === '8007052E' ? 'Windows 账号认证失败，请在连接编辑或公共凭据中核对账号、域和密码'
          : result?.hresult === '800706BA' ? 'RPC 服务不可用，请检查远程 WMI 服务、防火墙及动态 RPC 端口'
          : typeof result?.message === 'string' ? result.message : '系统未提供原因'
        finish(result?.stage === 'connect' ? unavailable('Windows WMI 查询失败：' + reason) : new Error('Windows WMI 查询失败：' + reason)); return
      }
      finish(undefined, { stdout: redactAiText(result.stdout, secrets), stderr: '', code: 0, durationMs: Date.now() - started, truncated: result.truncated === true })
    })
    helper.stdin.end(JSON.stringify({ host, username, password: credential.secret, topic }))
  })
}
