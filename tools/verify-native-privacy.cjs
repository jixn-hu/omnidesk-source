const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const verify = require('./verify-freerdp-package.cjs')
fs.mkdirSync(path.resolve(__dirname, '..', 'tmp'), { recursive: true })
const root = fs.mkdtempSync(path.resolve(__dirname, '..', 'tmp', 'native-privacy-'))
const directory = path.join(root, 'out/native-freerdp')
fs.mkdirSync(path.join(directory, 'licenses'), { recursive: true })
for (const name of ['FreeRDP-LICENSE', 'openssl-LICENSE']) fs.writeFileSync(path.join(directory, 'licenses', name), 'Synthetic test fixture')
const context = { electronPlatformName: 'win32', packager: { projectDir: root } }
const manifest = { protocol: 5, platform: 'win32-x64', dependencies: { openssl: 'OpenSSL 3.6.5' }, files: {} }
function save(bytes) {
  for (const name of ['omnidesk-freerdp.exe', 'legacy.dll']) {
    fs.writeFileSync(path.join(directory, name), bytes)
    manifest.files[name] = crypto.createHash('sha256').update(bytes).digest('hex')
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
}
async function main() {
  save(Buffer.from('Synthetic native runtime without local paths'))
  await verify(context)
  for (const value of [root, process.env.USERPROFILE].filter(Boolean)) {
    for (const variant of new Set([value.replaceAll('\\', '/'), value.replaceAll('/', '\\')])) {
      for (const encoding of ['utf8', 'utf16le']) {
        save(Buffer.from(variant, encoding))
        await assert.rejects(verify(context), /包含开发机路径/)
      }
    }
  }
  console.log('PASS native packaging rejects workspace/profile paths in both slash styles and UTF-8/UTF-16LE even with matching hashes; clean fixtures accepted')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
