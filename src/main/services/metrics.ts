/**
 * 指标采集服务
 *
 * 流程：把内置的采集脚本推到远端 → 执行 → 解析 JSON → 归一化成结构化数据。
 * 目标机零依赖，只要能跑 POSIX sh。
 *
 * 这是"给 AI 提供 Linux 数据"的数据源 —— MCP 与 HTTP API 都从这里取数。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ServerMetrics, CpuMetrics, MemoryMetrics, DiskMetrics, NetworkInterfaceMetrics, ProcessMetrics } from '@shared/types.js'
import { REMOTE_AGENT_DIR } from '@shared/constants.js'
import type { SshService } from './ssh.js'
// 采集脚本在构建期就被内联成字符串。
// 不走运行时读文件 —— 打包后 asar 内的路径布局会变，运行时按路径找很容易失效。
import windowsScript from '../assets/scripts/collect.ps1?raw'
import collectScript from '../assets/scripts/collect.sh?raw'

/** 远端脚本路径 */
const REMOTE_SCRIPT = `${REMOTE_AGENT_DIR}/collect.sh`

/** 上一次采集的网络计数，用于算速率 */
interface NetSnapshot {
  timestamp: number
  counters: Map<string, { rx: number; tx: number }>
}

/** 远端返回的原始结构（脚本直出，字段名与脚本一致） */
interface RawMetrics {
  hostname?: string
  os?: string
  kernel?: string
  arch?: string
  uptime?: number
  virtualization?: string
  cpu?: {
    usage?: number
    cores?: number
    model?: string
    perCore?: number[]
    loadAvg?: [number, number, number]
  }
  memory?: {
    total?: number
    used?: number
    free?: number
    available?: number
    buffers?: number
    cached?: number
    swapTotal?: number
    swapUsed?: number
    usagePercent?: number
  }
  disks?: Array<{
    device?: string
    mount?: string
    fsType?: string
    total?: number
    used?: number
    available?: number
    usagePercent?: number
  }>
  network?: Array<{ name?: string; rxBytes?: number; txBytes?: number }>
  processes?: Array<{ pid?: number; user?: string; cpu?: number; mem?: number; command?: string }>
}

export class MetricsService {
  /** 每个连接上一次的网络计数快照 */
  private netSnapshots = new Map<string, NetSnapshot>()

  private platforms = new Map<string, 'linux' | 'windows'>()
  private recent = new Map<string, { value: ServerMetrics; processes: boolean }>()
  private pending = new Map<string, { withProcesses: boolean; operation: Promise<ServerMetrics> }>()

  constructor(private ssh: SshService) {
    ssh.on('close', (sessionId: string) => this.forget(sessionId))
  }

  /** 内置采集脚本（构建时已内联） */
  private script(): string {
    return collectScript.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  }

  /**
   * 确保远端脚本是最新的。
   * 用内容哈希比对，避免每次采集都重传。
   */
  private async ensureRemoteScript(sessionId: string, force = false): Promise<void> {
    const content = this.script()
    if (force) {
      await this.pushScript(sessionId, content)
      return
    }
    const check = await this.ssh.exec(
      sessionId,
      `test -f ~/${REMOTE_SCRIPT} && md5sum ~/${REMOTE_SCRIPT} 2>/dev/null | cut -d' ' -f1 || echo MISSING`,
      { timeoutMs: 8000 }
    )
    const remoteHash = check.stdout.trim()
    const localHash = createMd5(content)
    if (remoteHash !== localHash) {
      await this.pushScript(sessionId, content)
    }
  }

  private async pushScript(sessionId: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const temporary = `~/${REMOTE_AGENT_DIR}/collect-${randomUUID()}`
    // 用 base64 传输避免任何转义/换行问题；分块写入防止超出命令长度限制
    const chunkSize = 60_000
    const chunks: string[] = []
    for (let i = 0; i < b64.length; i += chunkSize) {
      chunks.push(b64.slice(i, i + chunkSize))
    }

    const prepare = await this.ssh.exec(sessionId, `mkdir -p ~/${REMOTE_AGENT_DIR} && : > ${temporary}.b64`, { timeoutMs: 10_000 })
    if (prepare.code !== 0) throw new Error('无法写入监控脚本目录，请检查 ~/.omnidesk/ 权限')
    for (const chunk of chunks) {
      const append = await this.ssh.exec(sessionId, `printf '%s' '${chunk}' >> ${temporary}.b64`, { timeoutMs: 15_000 })
      if (append.code !== 0) throw new Error('监控脚本上传失败，请检查磁盘空间和目录权限')
    }
    const install = await this.ssh.exec(
      sessionId,
      `base64 -d ${temporary}.b64 > ${temporary}.sh && chmod 700 ${temporary}.sh && mv -f ${temporary}.sh ~/${REMOTE_SCRIPT} && rm -f ${temporary}.b64`,
      { timeoutMs: 15_000 }
    )
    if (install.code !== 0) throw new Error('监控脚本安装失败，请检查 base64 命令及 ~/.omnidesk/ 权限')
  }

  /**
   * 采集一次指标。
   * @param withProcesses 是否包含进程 TOP
   */
  async collect(sessionId: string, withProcesses = false): Promise<ServerMetrics> {
    const recent = this.recent.get(sessionId)
    if (recent && Date.now() - recent.value.timestamp < 2500 && (!withProcesses || recent.processes)) return recent.value
    const pending = this.pending.get(sessionId)
    if (pending) {
      const sample = await pending.operation
      return !withProcesses || pending.withProcesses ? sample : this.collect(sessionId, true)
    }
    const operation = this.sample(sessionId, withProcesses)
    this.pending.set(sessionId, { withProcesses, operation })
    try { const value = await operation; this.recent.set(sessionId, { value, processes: withProcesses }); return value } finally { this.pending.delete(sessionId) }
  }

  private async sample(sessionId: string, withProcesses: boolean): Promise<ServerMetrics> {
    const started = Date.now()
    let platform = this.platforms.get(sessionId)
    if (!platform) {
      const probe = await this.ssh.exec(sessionId, 'uname -s', { timeoutMs: 8000 })
      if (probe.code === 0 && /Linux/i.test(probe.stdout)) platform = 'linux'
      else {
        const check = await this.ssh.exec(sessionId, 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Environment]::OSVersion.Platform"', { timeoutMs: 8000 })
        if (!check.stdout.includes('Win32NT')) throw new Error('资源监控支持 Linux 或已启用 OpenSSH 与 PowerShell 的 Windows')
        platform = 'windows'
      }
      this.platforms.set(sessionId, platform)
    }
    const latencyStart = Date.now()
    const echo = await this.ssh.exec(sessionId, 'echo OMNIDESK_METRICS', { timeoutMs: 8000 })
    const latencyMs = echo.stdout.includes('OMNIDESK_METRICS') ? Date.now() - latencyStart : undefined
    let command: string
    if (platform === 'windows') {
      const script = '& { ' + windowsScript + '\n }' + (withProcesses ? ' -WithProcesses' : '')
      command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')
    } else {
      await this.ensureRemoteScript(sessionId)
      command = `sh ~/${REMOTE_SCRIPT} ${withProcesses ? '--with-processes' : ''}`
    }
    const result = await this.ssh.exec(sessionId, command, {
      timeoutMs: platform === 'windows' ? 60_000 : 20_000,
      maxBytes: 2 * 1024 * 1024
    })

    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(`远端采集脚本执行失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
    }

    let raw: RawMetrics
    try {
      raw = JSON.parse(result.stdout.replace(/^\uFEFF/, '')) as RawMetrics
    } catch {
      throw new Error(`采集输出不是合法 JSON：${result.stdout.slice(0, 200)}`)
    }

    const connection = this.ssh.getConnection(sessionId)
    const now = Date.now()

    return {
      connectionId: connection.id,
      timestamp: now,
      latencyMs,
      durationMs: Date.now() - started,
      system: {
        hostname: raw.hostname ?? connection.host,
        os: raw.os ?? '',
        kernel: raw.kernel ?? '',
        arch: raw.arch ?? '',
        uptime: toNum(raw.uptime),
        virtualization: raw.virtualization || undefined
      },
      cpu: normalizeCpu(raw.cpu),
      memory: normalizeMemory(raw.memory),
      disks: (raw.disks ?? []).map(normalizeDisk),
      network: this.normalizeNetwork(sessionId, raw.network ?? [], now),
      processes: withProcesses ? (raw.processes ?? []).map(normalizeProcess) : undefined
    }
  }

  /** 用两次采样的计数差算速率 */
  private normalizeNetwork(
    connectionId: string,
    list: Array<{ name?: string; rxBytes?: number; txBytes?: number }>,
    now: number
  ): NetworkInterfaceMetrics[] {
    const prev = this.netSnapshots.get(connectionId)
    const counters = new Map<string, { rx: number; tx: number }>()
    const elapsed = prev ? (now - prev.timestamp) / 1000 : 0

    const out = list.map((n) => {
      const name = n.name ?? ''
      const rx = toNum(n.rxBytes)
      const tx = toNum(n.txBytes)
      counters.set(name, { rx, tx })

      let rxRate: number | undefined
      let txRate: number | undefined
      if (prev && elapsed > 0) {
        const p = prev.counters.get(name)
        if (p) {
          // 计数器回绕（网卡重连）时跳过，避免出现负值
          rxRate = rx >= p.rx ? Math.round((rx - p.rx) / elapsed) : undefined
          txRate = tx >= p.tx ? Math.round((tx - p.tx) / elapsed) : undefined
        }
      }
      return { name, rxBytes: rx, txBytes: tx, rxRate, txRate }
    })

    this.netSnapshots.set(connectionId, { timestamp: now, counters })
    return out
  }

  /** 清理某连接的快照 */
  forget(connectionId: string): void {
    this.recent.delete(connectionId)
    this.netSnapshots.delete(connectionId)
    this.platforms.delete(connectionId)
  }
}

/* ------------------------------------------------------------------ */
/* 归一化辅助                                                          */
/* ------------------------------------------------------------------ */

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function normalizeCpu(raw: RawMetrics['cpu']): CpuMetrics {
  const load = Array.isArray(raw?.loadAvg) ? raw.loadAvg : [0, 0, 0]
  return {
    usage: round1(toNum(raw?.usage)),
    cores: toNum(raw?.cores),
    perCore: Array.isArray(raw?.perCore) ? raw.perCore.map((x) => round1(toNum(x))) : [],
    model: raw?.model || undefined,
    loadAvg: [round2(toNum(load[0])), round2(toNum(load[1])), round2(toNum(load[2]))]
  }
}

function normalizeMemory(raw: RawMetrics['memory']): MemoryMetrics {
  const total = toNum(raw?.total)
  const used = toNum(raw?.used)
  return {
    total,
    used,
    free: toNum(raw?.free),
    available: toNum(raw?.available),
    cached: toNum(raw?.cached),
    buffers: toNum(raw?.buffers),
    swapTotal: toNum(raw?.swapTotal),
    swapUsed: toNum(raw?.swapUsed),
    usagePercent: raw?.usagePercent != null ? round1(toNum(raw.usagePercent)) : total > 0 ? round1((used / total) * 100) : 0
  }
}

function normalizeDisk(raw: NonNullable<RawMetrics['disks']>[number]): DiskMetrics {
  const total = toNum(raw.total)
  const used = toNum(raw.used)
  return {
    device: raw.device ?? '',
    mount: raw.mount ?? '',
    fsType: raw.fsType ?? '',
    total,
    used,
    available: toNum(raw.available),
    usagePercent: raw.usagePercent != null ? round1(toNum(raw.usagePercent)) : total > 0 ? round1((used / total) * 100) : 0
  }
}

function normalizeProcess(raw: NonNullable<RawMetrics['processes']>[number]): ProcessMetrics {
  return {
    pid: toNum(raw.pid),
    user: raw.user ?? '',
    cpu: round1(toNum(raw.cpu)),
    mem: round1(toNum(raw.mem)),
    command: (raw.command ?? '').slice(0, 300)
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 计算内容 md5，用于和远端脚本比对，避免每次采集都重传 */
function createMd5(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex')
}
