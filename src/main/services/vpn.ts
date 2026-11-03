/**
 * 系统 VPN 服务（Windows）
 *
 * 【先厘清概念，避免做错方向】
 *
 * 「VPN 连接」和「端口转发/代理」是两回事：
 *
 *   系统 VPN（本文件）—— Windows「设置 → 网络和 Internet → VPN」里配置的连接。
 *     它建立的是一个**系统级隧道**，一旦拨通，路由表就变了，
 *     所有应用（包括本程序的连接）自动走它。所以：
 *       ✅ 想让「所有连接都经过 VPN」→ 拨通系统 VPN 即可，本程序什么都不用做
 *       ❌ 想「只让某一个连接走 VPN」→ Windows 内置 VPN 做不到按应用分流，
 *          那需要更底层的方案（WireGuard 的 AllowedIPs、或 wintun 级的实现）
 *
 *   本模块做的事：把「拨号 / 断开 / 查状态」接进界面，
 *   并支持「连接某台机器前自动拨 VPN」，省掉手动拨号的步骤。
 *
 * 实现方式：调用系统自带的 rasdial。
 *   列出连接：rasdial
 *   拨号    ：rasdial "名称" [用户名 密码]
 *   断开    ：rasdial "名称" /disconnect
 *
 * 【安全提示】rasdial 把密码放在命令行上，会出现在进程列表里。
 * 所以默认只传连接名 —— 依赖 Windows 已保存的凭据。
 * 只有用户显式选择「每次输入密码」时才传，且在界面上说明这个代价。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VpnConnection, VpnConnectResult } from '@shared/types.js'

const execFileAsync = promisify(execFile)

interface RasResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

/**
 * 用 PowerShell 取数据。
 *
 * 【为什么不用 rasdial 的文本输出】
 * rasdial 按系统 ANSI 代码页输出（中文 Windows 是 GBK），而 Node 按 UTF-8 解码，
 * 结果中文连接名全是乱码。实测踩过这个坑。
 * PowerShell 可以强制 UTF-8 输出，而且 Get-VpnConnection 直接给结构化数据，
 * 不用去解析本地化的文本格式。
 */
async function runPowerShell(script: string, timeoutMs = 20_000): Promise<string> {
  if (process.platform !== 'win32') return ''
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // 首行强制 UTF-8 输出，否则中文会乱码
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`
      ],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }
    )
    return stdout ?? ''
  } catch {
    return ''
  }
}

async function runRasdial(args: string[], timeoutMs = 45_000): Promise<RasResult> {
  if (process.platform !== 'win32') {
    return { ok: false, stdout: '', stderr: '系统 VPN 集成仅支持 Windows', code: null }
  }
  try {
    // rasdial 的输出是本地化文本且编码为 ANsi，这里只取退出码，
    // 具体状态一律回头用 PowerShell 查，避免乱码与解析脆弱
    await execFileAsync('rasdial.exe', args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'latin1' // 不按 UTF-8 解，反正不用它的文本
    })
    return { ok: true, stdout: '', stderr: '', code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      ok: false,
      stdout: '',
      stderr: String(e.stderr ?? e.message ?? ''),
      code: typeof e.code === 'number' ? e.code : null
    }
  }
}

export class VpnService {
  /**
   * 列出系统里配置的 VPN 连接。
   *
   * 用 Get-VpnConnection 而不是解析 rasdial 的文本输出 ——
   * 后者是本地化的、GBK 编码的，既难解析又会乱码。
   */
  async list(): Promise<VpnConnection[]> {
    const raw = await runPowerShell(
      'Get-VpnConnection -ErrorAction SilentlyContinue | ' +
        'Select-Object Name,ServerAddress,ConnectionStatus | ConvertTo-Json -Compress'
    )
    if (!raw.trim()) return []

    try {
      const parsed = JSON.parse(raw) as unknown
      // 单个结果时 PowerShell 返回对象而非数组，统一成数组
      const arr = Array.isArray(parsed) ? parsed : [parsed]

      return arr
        .map((item): VpnConnection | null => {
          const o = item as { Name?: string; ServerAddress?: string; ConnectionStatus?: string }
          if (!o?.Name) return null
          return {
            name: String(o.Name),
            serverAddress: o.ServerAddress ? String(o.ServerAddress) : undefined,
            connected: String(o.ConnectionStatus ?? '') === 'Connected'
          } satisfies VpnConnection
        })
        .filter((x): x is VpnConnection => x !== null)
    } catch {
      return []
    }
  }

  /** 已连接的 VPN 名称 */
  private async listConnectedNames(): Promise<string[]> {
    const raw = await runPowerShell(
      "Get-VpnConnection -ErrorAction SilentlyContinue | Where-Object {$_.ConnectionStatus -eq 'Connected'} | " +
        'Select-Object -ExpandProperty Name'
    )
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /** 查某个连接当前是否已连上 */
  async isConnected(name: string): Promise<boolean> {
    const list = await this.listConnectedNames()
    return list.some((n) => n.toLowerCase() === name.toLowerCase())
  }

  /**
   * 拨号。
   *
   * 不传凭据时依赖 Windows 已保存的账号密码 —— 这是推荐方式，
   * 因为 rasdial 的密码会出现在进程命令行里。
   */
  async connect(
    name: string,
    credentials?: { username: string; password: string }
  ): Promise<VpnConnectResult> {
    if (!name.trim()) return { ok: false, message: '未指定 VPN 连接名' }

    // 已经连上就不重复拨
    if (await this.isConnected(name)) {
      return { ok: true, message: '该 VPN 已处于连接状态' }
    }

    const args = [name]
    if (credentials?.username) {
      args.push(credentials.username, credentials.password ?? '')
    }

    // rasdial 的文本输出是 GBK 的，不用它 —— 只认退出码，状态靠 PowerShell 复核
    const res = await runRasdial(args, 60_000)

    // 拨号是异步的，给状态一点更新时间
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await this.isConnected(name)) {
        return { ok: true, message: `${name} 已连接` }
      }
    }

    if (res.code === 0) {
      // 退出码说成功但状态查不到，多半是还在协商
      return { ok: false, message: `${name} 拨号已发出，但未在预期时间内建立连接。请稍后在系统网络设置中确认。` }
    }

    return {
      ok: false,
      message:
        `${name} 拨号失败。常见原因：账号或密码不正确、协议与服务器不匹配、` +
        `或运营商阻断了该 VPN 协议（PPTP 被大量运营商封禁）。`
    }
  }

  /** 断开 */
  async disconnect(name: string): Promise<VpnConnectResult> {
    if (!name.trim()) return { ok: false, message: '未指定 VPN 连接名' }

    await runRasdial([name, '/disconnect'], 30_000)

    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 400))
      if (!(await this.isConnected(name))) {
        return { ok: true, message: `${name} 已断开` }
      }
    }

    return { ok: false, message: `${name} 断开失败，请到系统网络设置中手动断开。` }
  }

  /**
   * 确保某个 VPN 已连通 —— 供「连接前自动拨号」使用。
   * 已连上就直接返回，不会重复拨。
   */
  async ensureConnected(name: string, timeoutMs = 60_000): Promise<VpnConnectResult> {
    if (!name.trim()) return { ok: true, message: '未配置 VPN' }
    if (await this.isConnected(name)) {
      return { ok: true, message: `${name} 已连接` }
    }

    // 拨号是异步的，这里等一个上限时间，期间轮询状态
    const started = Date.now()
    const pending = this.connect(name)

    while (Date.now() - started < timeoutMs) {
      const res = await pending
      if (res.ok) return res
      // 拨号失败就没必要等了
      return res
    }

    return { ok: false, message: `等待 ${name} 连接超时` }
  }
}
