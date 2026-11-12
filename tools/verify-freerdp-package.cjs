const { readFileSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  require('./build-monitor-agent.cjs').verify(join(context.packager.projectDir, 'out/monitor-agent'))
  const directory = join(context.packager.projectDir, 'out/native-freerdp')
  const instruction = '请先运行 npm run build:freerdp，再打包 Windows 客户端'
  if (!existsSync(join(directory, 'manifest.json'))) throw new Error(instruction)
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const openssl = /^OpenSSL 3\.(\d+)\.(\d+)\b/.exec(manifest.dependencies?.openssl || '')
  if (!openssl || Number(openssl[1]) < 6 || Number(openssl[1]) === 6 && Number(openssl[2]) < 5) throw new Error('发布构建要求 OpenSSL 3.6.5 或更新的兼容 3.x 版本，请更新构建前缀后重新构建 FreeRDP；见 docs/FREERDP.md')
  if (manifest.protocol !== 6 || manifest.platform !== 'win32-x64' || !manifest.files?.['omnidesk-freerdp.exe'] || !manifest.files?.['legacy.dll']) throw new Error(`FreeRDP 运行库不完整或协议版本不匹配；${instruction}`)
  const privatePaths = [context.packager.projectDir, process.env.USERPROFILE].filter(Boolean).flatMap(value => [...new Set([value.replaceAll('\\', '/'), value.replaceAll('/', '\\')])]).flatMap(value => ['utf8', 'utf16le'].map(encoding => Buffer.from(value, encoding)))
  for (const name of readdirSync(directory)) if (/\.(?:exe|dll)$/i.test(name) && !manifest.files[name]) throw new Error(`发现未记录的旧运行文件：${name}，请先检查构建目录`)
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!/^[\w.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash) || createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') !== hash) throw new Error(`FreeRDP 运行库校验失败：${name}；${instruction}`)
    const binary = readFileSync(join(directory, name))
    if (privatePaths.some(needle => binary.includes(needle))) throw new Error(`FreeRDP 运行库包含开发机路径：${name}；${instruction}`)
  }
  if (!existsSync(join(directory, 'licenses/FreeRDP-LICENSE')) || !existsSync(join(directory, 'licenses/openssl-LICENSE'))) throw new Error('FreeRDP 依赖许可证不完整')
}
