const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync } = require('node:fs')
const { resolve, join } = require('node:path')

if (process.platform !== 'win32') {
  console.log('Windows native RDP host: skipped on this platform')
  process.exit(0)
}
const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(compiler)) throw new Error('Windows native RDP host requires the .NET Framework 4.x C# compiler')
const output = resolve('out/native')
mkdirSync(output, { recursive: true })
const run = (file, arguments) => execFileSync(file, arguments, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
run(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${join(output, 'ImportTypeLibrary.exe')}`, resolve('native/rdp/ImportTypeLibrary.cs')])
run(join(output, 'ImportTypeLibrary.exe'), [output])
run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${join(output, 'OmniDesk.RdpHost.exe')}`,
  `/win32manifest:${resolve('native/rdp/rdp.manifest')}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/r:System.Web.Extensions.dll', '/r:Microsoft.CSharp.dll', `/r:${join(output, 'Interop.MSTSCLib.dll')}`, resolve('native/rdp/RdpHost.cs')])
const result = run(join(output, 'OmniDesk.RdpHost.exe'), ['--self-test']).toString('utf8').trim()
if (JSON.parse(result).phase !== 'self-test') throw new Error('Windows native RDP host self-test failed')
console.log('Built and initialized Windows native RDP host; no connection or clipboard access')
