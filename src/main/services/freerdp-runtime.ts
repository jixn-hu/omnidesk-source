import { execFile } from 'node:child_process'
import { join } from 'node:path'

export function nativeEnvironment(directory: string): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: join(process.env.SystemRoot || 'C:/Windows', 'System32'), OPENSSL_MODULES: directory, WLOG_LEVEL: 'OFF' }
}

export function nativeStartupError(code?: number | string | null, signal?: string | null): string {
  if (typeof code === 'string') {
    const reason = code === 'ENOENT' ? '辅助程序或依赖文件不存在，可能安装不完整或文件被隔离' : /^(EACCES|EPERM)$/.test(code) ? '系统拒绝启动辅助程序，请检查安装目录权限或安全软件记录' : '辅助程序未能正常启动'
    return `FreeRDP ${reason}（${/^[A-Z0-9_]{1,64}$/.test(code) ? code : 'START_FAILED'}）`
  }
  const status = typeof code === 'number' ? code >>> 0 : undefined
  const reason = status === 0xc0000135 ? '缺少辅助程序所需的 DLL，请重新安装完整安装包' : status === 0xc000007b ? '运行库架构不匹配或文件损坏，请重新安装 x64 完整安装包' : status === 0xc0000142 ? '本机运行库初始化失败，请检查系统和安全软件记录' : status === 0xc000001d ? '辅助程序使用了当前 CPU 不支持的指令' : '辅助程序意外退出'
  return `FreeRDP ${reason}（${status === undefined ? signal === 'SIGTERM' ? '启动超时或已终止' : 'UNKNOWN_EXIT' : '0x' + status.toString(16).toUpperCase().padStart(8, '0')}）`
}

export function checkNativeRuntime(directory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(join(directory, 'omnidesk-freerdp.exe'), ['--version'], { cwd: directory, env: nativeEnvironment(directory), windowsHide: true, timeout: 8000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) { reject(new Error(nativeStartupError(error.code, error.signal))); return }
      if (!/^OmniDesk FreeRDP [\d.]+ protocol=6\s*$/.test(stdout.trim())) { reject(new Error('FreeRDP 辅助程序协议不匹配，请重新安装完整安装包')); return }
      resolve()
    })
  })
}
