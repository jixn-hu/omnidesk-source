const { spawnSync, execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { resolve, join, basename, relative } = require('node:path')
const { createHash } = require('node:crypto')

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('FreeRDP 辅助进程当前仅支持 Windows x64')
const root = resolve(__dirname, '..')
const msys = process.env.OMNIDESK_MSYS2 || 'C:/msys64/ucrt64'
const openssl = process.env.OMNIDESK_OPENSSL_ROOT || msys
const source = join(root, 'tmp/freerdp-source')
const build = join(root, 'tmp/freerdp-build')
const sdk = join(root, 'tmp/freerdp-sdk')
const output = join(root, 'out/native-freerdp')
const version = '3.32.2'
const revision = '97eff6ddfbbfaa8e42a126d362686bd001ff8bdc'
const cmake = process.env.OMNIDESK_CMAKE || (existsSync(join(root, 'tmp/freerdp-build-tools/cmake/data/bin/cmake.exe')) ? join(root, 'tmp/freerdp-build-tools/cmake/data/bin/cmake.exe') : 'cmake')
process.env.PATH = `${join(openssl, 'bin')};${join(msys, 'bin')};${process.env.PATH}`
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: capture ? 'pipe' : 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} 失败：${result.error?.message || result.stderr || result.status}`)
  return result.stdout || ''
}
if (!existsSync(join(msys, 'bin/gcc.exe'))) throw new Error('请安装 MSYS2 UCRT64 GCC、OpenSSL、zlib；见 docs/FREERDP.md')
for (const filename of ['bin/openssl.exe', 'include/openssl/ssl.h', 'lib/libssl.dll.a', 'lib/libcrypto.dll.a', 'lib/ossl-modules/legacy.dll']) if (!existsSync(join(openssl, filename))) throw new Error(`OpenSSL 构建前缀不完整：${filename}`)
mkdirSync(join(root, 'tmp'), { recursive: true })
if (!existsSync(source)) run('git', ['clone', '--depth', '1', '--branch', version, 'https://github.com/FreeRDP/FreeRDP.git', source])
if (run('git', ['-C', source, 'rev-parse', 'HEAD'], true).trim() !== revision) throw new Error(`FreeRDP 源码必须为 ${version} (${revision})；请先更新临时源码目录`)
require('./patch-freerdp-resume.cjs')(source)
const disabled = ['SERVER', 'SAMPLE', 'WINPR_TOOLS', 'FFMPEG', 'SWSCALE', 'CAIRO', 'JPEG', 'OPENH264', 'AAD', 'URIPARSER', 'LIBUSB', 'SMARTCARD_EMULATE', 'MANPAGES', 'X11', 'WAYLAND', 'PULSE', 'ALSA', 'PCSC', 'ABSOLUTE_PLUGIN_LOAD_PATHS', 'DEBUG_ALL']
const channels = ['URBDRC', 'SMARTCARD', 'PRINTER', 'DRIVE', 'RDPDR', 'AUDIN', 'RDPSND', 'LOCATION', 'ENCOMSP', 'RDPEI', 'RAIL', 'VIDEO', 'GEOMETRY', 'AINPUT', 'ECHO', 'REMDESK']
run(cmake, ['-S', source, '-B', build, '-G', 'MinGW Makefiles', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX=C:/OmniDesk', `-DCMAKE_STAGING_PREFIX=${sdk.replaceAll('\\', '/')}`, `-DCMAKE_PREFIX_PATH=${msys.replaceAll('\\', '/')}`, `-DOPENSSL_ROOT_DIR=${openssl.replaceAll('\\', '/')}`, `-DOPENSSL_INCLUDE_DIR=${join(openssl, 'include').replaceAll('\\', '/')}`, `-DOPENSSL_CRYPTO_LIBRARY=${join(openssl, 'lib/libcrypto.dll.a').replaceAll('\\', '/')}`, `-DOPENSSL_SSL_LIBRARY=${join(openssl, 'lib/libssl.dll.a').replaceAll('\\', '/')}`, '-DCMAKE_C_FLAGS=-D__STDC_NO_THREADS__ -Wno-error=incompatible-pointer-types', '-DUSE_UNWIND=OFF', '-DWITH_CLIENT=OFF', '-DWITH_CLIENT_COMMON=ON', '-DWITH_MEDIA_FOUNDATION=ON', '-DWITH_JSON_DISABLED=ON', '-DWITH_CHANNELS=ON', '-DWITH_CHANNELS_STATIC=ON', '-DWITH_NATIVE_SSPI=ON', '-DBUILD_TESTING=OFF', ...disabled.map(name => `-DWITH_${name}=OFF`), ...channels.map(name => `-DCHANNEL_${name}=OFF`)])
run(cmake, ['--build', build, '--parallel', '6'])
run(cmake, ['--install', build])
mkdirSync(output, { recursive: true })
const executable = join(output, 'omnidesk-freerdp.exe')
run(join(msys, 'bin/gcc.exe'), ['native/freerdp/host.c', 'native/freerdp/file-clipboard.c', 'native/freerdp/virtual-files.c', `-I${relative(root, sdk)}/include/freerdp3`, `-I${relative(root, sdk)}/include/winpr3`, `-L${relative(root, sdk)}/lib`, '-lfreerdp-client3', '-lfreerdp3', '-lwinpr3', '-lws2_32', '-lshell32', '-luser32', '-lole32', '-luuid', '-lshlwapi', '-D__STDC_NO_THREADS__', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-Wno-unknown-pragmas', '-o', relative(root, executable)])
const libraries = new Map()
for (const directory of [join(openssl, 'bin'), join(sdk, 'bin'), join(msys, 'bin')]) for (const name of readdirSync(directory)) {
  if (name.toLowerCase().endsWith('.dll') && !libraries.has(name.toLowerCase())) libraries.set(name.toLowerCase(), join(directory, name))
}
const bundled = new Set()
const provider = join(openssl, 'lib/ossl-modules/legacy.dll')
if (!existsSync(provider)) throw new Error('缺少 OpenSSL legacy provider（RDP 授权与 NTLM 所需）')
copyFileSync(provider, join(output, 'legacy.dll'))
bundled.add('legacy.dll')
libraries.set('legacy.dll', provider)
const pending = [executable, provider]
while (pending.length) {
  const binary = pending.pop()
  const imports = run(join(msys, 'bin/objdump.exe'), ['-p', binary], true)
  for (const match of imports.matchAll(/DLL Name:\s*([^\r\n]+)/g)) {
    const name = match[1].trim().toLowerCase()
    if (bundled.has(name)) continue
    const library = libraries.get(name)
    if (!library) {
      if (!existsSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', name)) && !name.startsWith('api-ms-win-') && !name.startsWith('ext-ms-win-')) throw new Error(`缺少 DLL：${name}`)
      continue
    }
    bundled.add(name)
    const target = join(output, basename(library))
    copyFileSync(library, target)
    pending.push(target)
  }
}
const licenseDir = join(output, 'licenses')
mkdirSync(licenseDir, { recursive: true })
copyFileSync(join(source, 'LICENSE'), join(licenseDir, 'FreeRDP-LICENSE'))
if (existsSync(join(source, 'NOTICE'))) copyFileSync(join(source, 'NOTICE'), join(licenseDir, 'FreeRDP-NOTICE'))
for (const component of ['openssl', 'zlib', 'gcc-libs', 'libwinpthread']) {
  const directory = join(component === 'openssl' ? openssl : msys, 'share/licenses', component)
  if (existsSync(directory)) for (const name of readdirSync(directory, { withFileTypes: true })) if (name.isFile()) copyFileSync(join(directory, name.name), join(licenseDir, `${component}-${name.name}`))
}
const files = Object.fromEntries(['omnidesk-freerdp.exe', ...[...bundled].map(name => basename(libraries.get(name)))].map(name => [name, createHash('sha256').update(readFileSync(join(output, name))).digest('hex')]))
const privatePaths = [root, process.env.USERPROFILE].filter(Boolean).flatMap(value => [...new Set([value.replaceAll('\\', '/'), value.replaceAll('/', '\\')])]).flatMap(value => ['utf8', 'utf16le'].map(encoding => Buffer.from(value, encoding)))
for (const name of Object.keys(files)) {
  const binary = readFileSync(join(output, name))
  if (privatePaths.some(needle => binary.includes(needle))) throw new Error(`原生运行库包含开发机路径：${name}，请检查 CMake 安装前缀`)
}
const dependencies = { openssl: run(join(openssl, 'bin/openssl.exe'), ['version'], true).trim(), gcc: run(join(msys, 'bin/gcc.exe'), ['-dumpfullversion'], true).trim() }
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ protocol: 6, version, revision, platform: 'win32-x64', dependencies, files }, null, 2))
const check = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: join(process.env.SystemRoot || 'C:/Windows', 'System32') } }).trim()
if (!check.includes(`FreeRDP ${version} protocol=6`)) throw new Error('辅助进程版本检查失败')
console.log(`FreeRDP 已就绪：${check}，${bundled.size} 个运行库`)
