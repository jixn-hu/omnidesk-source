import type { DiskMetrics, ServerMetrics } from './types'

const images = new Set(['squashfs', 'iso9660', 'udf', 'erofs', 'cramfs', 'romfs'])
const virtual = new Set(['tmpfs', 'devtmpfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'nsfs', 'tracefs', 'debugfs', 'securityfs', 'configfs', 'fusectl', 'mqueue', 'pstore', 'hugetlbfs', 'autofs', 'rpc_pipefs', 'binfmt_misc', 'ramfs', 'bpf'])

export function diskExclusionReason(disk: Pick<DiskMetrics, 'fsType' | 'mount'>): string | undefined {
  const type = (disk.fsType ?? '').trim().toLowerCase()
  if (images.has(type) || !type && (disk.mount.startsWith('/snap/') || disk.mount.startsWith('/var/lib/snapd/snap/'))) return '只读镜像'
  if (virtual.has(type)) return '系统虚拟文件系统'
  return undefined
}
export function monitoredDisks(disks: DiskMetrics[]): DiskMetrics[] {
  return disks.filter(disk => !diskExclusionReason(disk) && disk.total > 0 && Number.isFinite(disk.usagePercent) && disk.usagePercent >= 0)
}
export function mostUsedDisk(disks: DiskMetrics[]): DiskMetrics | undefined {
  return monitoredDisks(disks).reduce<DiskMetrics | undefined>((max, disk) => !max || disk.usagePercent > max.usagePercent ? disk : max, undefined)
}
export function resourceAlert(metrics: ServerMetrics): string | undefined {
  const missing = metrics.unavailable ?? []
  if (!missing.includes('cpu.usage') && metrics.cpu.usage >= 90) return 'CPU 使用率达到 90%'
  if (!missing.includes('memory.usagePercent') && metrics.memory.usagePercent >= 90) return '内存使用率达到 90%'
  for (const disk of monitoredDisks(metrics.disks)) {
    if (disk.usagePercent >= 90) return `磁盘 ${disk.mount} 使用率达到 90%`
    if (!missing.includes('disk.inodes') && (disk.inodeUsagePercent ?? 0) >= 90) return `磁盘 ${disk.mount} inode 使用率达到 90%`
  }
  return undefined
}
