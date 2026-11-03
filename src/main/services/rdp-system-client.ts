import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RdpConnection } from '@shared/types.js'
import { rdpAddress } from './rdp-protocol.js'
import { rdpDisplaySize, rdpPerformanceOptions } from '@shared/rdp-display.js'
import { parseConnectionAddress } from '@shared/connection-identity.js'

interface SystemRdpDisplay {
  x: number
  y: number
  width: number
  height: number
}

interface SystemRdpCredential {
  username: string
  domain?: string
  secret: string
}

const launcherScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$leases = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$mutex = $null
$ownsMutex = $false
$request = $null
$client = $null
$stage = '读取启动参数'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.password) {
    $stage = '加载 Windows 凭据接口'
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class OmniDeskRdpCredential : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);
  private IntPtr previous;
  private readonly string target;
  private readonly string marker = "OmniDesk temporary RDP " + Guid.NewGuid().ToString("N");
  private bool disposed;

  public OmniDeskRdpCredential(string target, string username, string password) {
    this.target = target;
    if (!Read(target, 1, 0, out previous)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 1168) throw new Win32Exception(error);
    }
    IntPtr blob = Marshal.StringToCoTaskMemUni(password);
    try {
      Credential credential = new Credential {
        Type = 1, TargetName = target, UserName = username, Comment = marker,
        CredentialBlob = blob, CredentialBlobSize = checked((uint)password.Length * 2), Persist = 1
      };
      if (!Write(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } catch {
      if (previous != IntPtr.Zero) { CredFree(previous); previous = IntPtr.Zero; }
      throw;
    } finally {
      Marshal.ZeroFreeCoTaskMemUnicode(blob);
    }
  }

  public void Dispose() {
    if (disposed) return;
    disposed = true;
    try {
      IntPtr current;
      if (Read(target, 1, 0, out current)) {
        try {
          Credential credential = (Credential)Marshal.PtrToStructure(current, typeof(Credential));
          if (credential.Comment == marker) {
            if (previous == IntPtr.Zero) {
              if (!Delete(target, 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            } else {
              Credential original = (Credential)Marshal.PtrToStructure(previous, typeof(Credential));
              if (!Write(ref original, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
          }
        } finally { CredFree(current); }
      }
    } finally {
      if (previous != IntPtr.Zero) { CredFree(previous); previous = IntPtr.Zero; }
    }
  }
}
'@
    $hasher = [Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($request.host.ToLowerInvariant()))).Replace('-', '')
    $hasher.Dispose()
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object Threading.Mutex($false, "Local\OmniDesk-RDP-$sid-$hash")
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { throw '此目标已有系统远程桌面会话，请先关闭该会话后再切换账号。' }
    foreach ($target in $request.targets) {
      $stage = '写入临时 Windows 凭据'
      $leases.Add((New-Object OmniDeskRdpCredential($target, $request.username, $request.password)))
    }
    $request.password = $null
  }
  $client = New-Object Diagnostics.Process
  $stage = '启动 mstsc.exe'
  $client.StartInfo.FileName = $request.executable
  $client.StartInfo.Arguments = '"' + $request.file + '"'
  $client.StartInfo.UseShellExecute = $false
  if (!$client.Start()) { throw '无法启动系统远程桌面客户端。' }
  [Console]::Out.WriteLine('{"ok":true}')
  [Console]::Out.Flush()
  $client.WaitForExit()
} catch {
  [Console]::Out.WriteLine((@{ ok = $false; stage = $stage; message = $_.Exception.Message } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
} finally {
  for ($index = $leases.Count - 1; $index -ge 0; $index--) {
    try { $leases[$index].Dispose() } catch { [Console]::Error.WriteLine('无法恢复系统远程桌面凭据，请在 Windows 凭据管理器中检查 TERMSRV 记录。') }
  }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
  if ($client) { $client.Dispose() }
  if ($request.file) {
    try { [IO.File]::Delete($request.file); [IO.Directory]::Delete([IO.Path]::GetDirectoryName($request.file)) } catch {}
  }
}
`

export function systemRdpUsername(username: string, domain?: string): string {
  return domain && !username.includes('\\') && !username.includes('@') ? `${domain}\\${username}` : username
}

export function systemRdpContent(connection: RdpConnection, credential: SystemRdpCredential | null, display: SystemRdpDisplay = { x: 0, y: 0, width: 1920, height: 1080 }): string {
  connection = { ...connection, ...parseConnectionAddress(connection.host, connection.port) }
  const username = systemRdpUsername(credential?.username ?? connection.username, credential?.domain ?? connection.domain)
  if ([connection.host, username].some((value) => /[\r\n\0]/.test(value))) throw new Error('RDP 地址和账号不能包含换行符或空字符')
  const options = rdpPerformanceOptions(connection.options)
  const size = rdpDisplaySize(display.width, display.height, 1, options.performanceMode)
  const capped = options.performanceMode === 'smooth' || options.performanceMode === 'balanced'
  return [
    `full address:s:${rdpAddress(connection.host, connection.port)}`,
    `username:s:${username}`,
    `audiomode:i:${options.audioCaptureMode === 'none' ? 2 : options.audioCaptureMode === 'remote' ? 1 : 0}`,
    `redirectclipboard:i:${options.enableClipboard === false ? 0 : 1}`,
    `disable wallpaper:i:${options.showWallpaper === false ? 1 : 0}`,
    `allow font smoothing:i:${options.fontSmoothing === false ? 0 : 1}`,
    `allow desktop composition:i:${options.desktopComposition === false ? 0 : 1}`,
    `disable full window drag:i:${options.showDraggedWindow === false ? 1 : 0}`,
    `disable menu anims:i:${options.showMenuAnimations === false ? 1 : 0}`,
    `disable themes:i:${options.showThemes === false ? 1 : 0}`,
    `authentication level:i:${options.ignoreCertificate === false ? 2 : 0}`,
    `prompt for credentials:i:${credential?.secret ? 0 : 1}`,
    'enablecredsspsupport:i:1',
    'negotiate security layer:i:1',
    `screen mode id:i:${options.fullscreen ? 2 : 1}`,
    `desktopwidth:i:${size.width}`,
    `desktopheight:i:${size.height}`,
    `winposstr:s:0,3,${display.x},${display.y},${display.x + size.width},${display.y + size.height}`,
    `smart sizing:i:${options.systemSmartSizing === true ? 1 : 0}`,
    `dynamic resolution:i:${options.dynamicResolution === false || capped ? 0 : 1}`,
    'use multimon:i:0',
    `session bpp:i:${options.colorDepth ?? 32}`,
    ''
  ].join('\r\n')
}

export async function launchSystemRdp(connection: RdpConnection, credential: SystemRdpCredential | null, display?: SystemRdpDisplay): Promise<boolean> {
  connection = { ...connection, ...parseConnectionAddress(connection.host, connection.port) }
  if (process.platform !== 'win32') throw new Error('系统远程桌面客户端仅在 Windows 上可用')
  if (connection.proxy && connection.proxy.type !== 'none') throw new Error('系统远程桌面客户端不支持此连接的 SOCKS / HTTP 代理，请使用内置桌面或先连接系统 VPN')
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const executable = ['System32', 'Sysnative'].map((directory) => join(systemRoot, directory, 'mstsc.exe')).find(existsSync)
  if (!executable) throw new Error('找不到系统远程桌面客户端（mstsc.exe）')
  const content = systemRdpContent(connection, credential, display)
  const directory = mkdtempSync(join(tmpdir(), 'omnidesk-rdp-'))
  const file = join(directory, 'connection.rdp')
  const cleanup = () => {
    try { unlinkSync(file) } catch {}
    try { rmdirSync(directory) } catch {}
  }
  try {
    writeFileSync(file, Buffer.from(`\uFEFF${content}`, 'utf16le'))
    const helper = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcherScript, 'utf16le').toString('base64')
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      let output = ''
      let settled = false
      const redact = (message: string) => credential?.secret ? message.split(credential.secret).join('[已隐藏]') : message
      const fail = (message: string) => {
        if (settled) return
        settled = true
        reject(new Error(redact(message)))
      }
      helper.once('error', (error) => fail(`无法启动 PowerShell 辅助进程：${error.message}`))
      helper.stdin.on('error', (error) => fail(`无法传递系统远程桌面启动参数：${error.message}`))
      helper.stderr.resume()
      helper.once('close', (code) => fail(`PowerShell 辅助进程未返回启动结果（退出码 ${code ?? '未知'}）；系统远程桌面尚未确认启动`))
      helper.stdout.setEncoding('utf8')
      helper.stdout.on('data', (text: string) => {
        if (settled) return
        output += text
        const newline = output.indexOf('\n')
        if (newline < 0) return
        try {
          const result = JSON.parse(output.slice(0, newline).replace(/^\uFEFF/, '')) as { ok: boolean; stage?: string; message?: string }
          settled = true
          if (!result.ok) reject(new Error(redact(`${result.stage ?? '启动系统远程桌面'}失败：${result.message || '辅助进程未提供原因'}`)))
          else resolve()
        } catch { fail('PowerShell 辅助进程返回了无效的启动结果') }
      })
      helper.stdin.end(JSON.stringify({
        host: connection.host,
        targets: [...new Set([`TERMSRV/${connection.host}`, `TERMSRV/${rdpAddress(connection.host, connection.port)}`])],
        username: systemRdpUsername(credential?.username ?? connection.username, credential?.domain ?? connection.domain),
        password: credential?.secret ?? '', executable, file
      }))
    })
    helper.unref()
    return true
  } catch (error) {
    cleanup()
    throw error
  }
}
