const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const root = path.resolve(__dirname, '..')
const version = require('../package.json').version
const release = process.env.OMNIDESK_QA_RELEASE_DIR ? path.resolve(process.env.OMNIDESK_QA_RELEASE_DIR) : path.join(root, 'release', 'ai-assistant')
const digest = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex')

async function main() {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const asar = await import('@electron/asar')
  const archive = path.join(release, 'win-unpacked/resources/app.asar')
  const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
  assert(entries.every(name => ['out', 'node_modules', 'package.json'].includes(name.split('/')[0])))
  assert(!entries.some(name => /^node_modules\/(?:playwright|playwright-core|typescript|electron-builder|electron-vite|tabby-rdp|ironrdp-wasm)(?:\/|$)/.test(name)))
  assert(!entries.some(name => /^(?:out\/native|src|native|official-server|tmp)(?:\/|$)|\.(?:rdo|odbackup|pem|pfx)$|(?:^|\/)(?:vault\.enc|vault-key\.json|connections\.json|shared-credentials\.json|webdav-sync\.json|ai-settings\.json|ai-conversations\.enc|official-account\.json|known-hosts\.json|rdp-legacy-consent\.json)$/.test(name)))
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, version)
  const publishing = require('../package.json').build.publish
  assert.equal(`${publishing.owner}/${publishing.repo}`, 'jixn-hu/omnidesk-releases')
  assert(asar.extractFile(archive, path.join('out', 'main', 'index.js')).toString().includes('jixn-hu/omnidesk-releases'))
  const updateConfiguration = fs.readFileSync(path.join(release, 'win-unpacked/resources/app-update.yml'), 'utf8')
  assert.match(updateConfiguration, /^owner: jixn-hu\r?$/m)
  assert.match(updateConfiguration, /^repo: omnidesk-releases\r?$/m)
  assert.match(updateConfiguration, /^releaseType: draft\r?$/m)
  assert.equal(require('../package-lock.json').version, version)
  let compared = 0
  const compare = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) compare(filename)
      else if (!filename.endsWith('.map')) {
        const relative = path.relative(root, filename)
        assert.equal(digest(asar.extractFile(archive, relative)), digest(fs.readFileSync(filename)), relative)
        compared++
      }
    }
  }
  for (const directory of ['out/main', 'out/preload', 'out/renderer']) compare(path.join(root, directory))
  for (const license of ['IronRDP-LICENSE', 'Tabby-RDP-LICENSE', 'Guacamole-LICENSE']) assert(fs.existsSync(path.join(release, 'win-unpacked/resources/licenses', license)))
  const native = path.join(release, 'win-unpacked/resources/freerdp')
  const privatePaths = [root, process.env.USERPROFILE].filter(Boolean).flatMap(value => [...new Set([value.replaceAll('\\', '/'), value.replaceAll('/', '\\')])]).flatMap(value => ['utf8', 'utf16le'].map(encoding => Buffer.from(value, encoding)))
  const manifest = JSON.parse(fs.readFileSync(path.join(native, 'manifest.json'), 'utf8'))
  assert.equal(manifest.protocol, 5)
  assert.equal(manifest.platform, 'win32-x64')
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.match(name, /^[\w.-]+$/)
    assert.equal(digest(fs.readFileSync(path.join(native, name))), hash, name)
    const binary = fs.readFileSync(path.join(native, name))
    assert(!privatePaths.some(needle => binary.includes(needle)), `Developer path in native runtime: ${name}`)
  }
  for (const name of fs.readdirSync(native)) if (/\.(?:exe|dll)$/i.test(name)) assert(manifest.files[name], name)
  for (const license of ['FreeRDP-LICENSE', 'openssl-LICENSE']) assert(fs.existsSync(path.join(native, 'licenses', license)))
  console.log(`PASS ASAR matches ${compared} built files; version ${version}; no personal profiles or dev-only dependencies; native hashes and licenses included`)

  const installer = `OmniDesk-${version}-ai-assistant-setup.exe`
  const portable = `OmniDesk-${version}-ai-assistant-portable.exe`
  const files = [installer, portable, `${installer}.blockmap`, 'latest.yml'].sort()
  for (const name of [installer, portable]) assert.equal(fs.readFileSync(path.join(release, name)).subarray(0, 2).toString(), 'MZ', name)
  const metadata = fs.readFileSync(path.join(release, 'latest.yml'), 'utf8')
  assert(metadata.includes(`version: ${version}`))
  assert(metadata.includes(`path: ${installer}`))
  const expected = digest(fs.readFileSync(path.join(release, installer)), 'sha512')
  const hashes = [...metadata.matchAll(/(?:^|\n)\s*sha512:\s*(\S+)/g)]
  assert(hashes.length > 0)
  for (const match of hashes) assert.equal(match[1], expected)
  assert(fs.statSync(path.join(release, `${installer}.blockmap`)).size > 0)
  console.log('PASS installer/portable PE headers, update version, filename and SHA512 metadata')

  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
  const profile = fs.mkdtempSync(path.join(root, 'tmp', `portable-${version}-`))
  const screenshot = path.join(profile, 'portable-smoke.png')
  const script = `(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const skip = [...document.querySelectorAll('button')].find(button => button.textContent.includes('暂不设置'))
      if (skip) { skip.click(); break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const entry = [...document.querySelectorAll('.sidebar-footer button')].find(button => button.textContent.includes('AI 助手'))
      if (entry) { entry.click(); break }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const address = document.querySelector('[aria-label="AI 接口地址"]')
      if (address && !address.disabled) {
        if (address.value) throw new Error('Unexpected default AI endpoint')
        if (document.querySelector('[aria-label="AI 模型名称"]').value) throw new Error('Unexpected default AI model')
        const configuration = await window.omnidesk.ai.configuration()
        if (!configuration.ok || configuration.data.hasApiKey) throw new Error('Unexpected AI configuration')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('AI assistant did not become ready')
  })()`
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: profile, OMNIDESK_CAPTURE: screenshot, OMNIDESK_CAPTURE_DELAY: '1200', OMNIDESK_CAPTURE_WAIT: '1500', OMNIDESK_CAPTURE_SCRIPT: Buffer.from(script).toString('base64') }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(path.join(release, portable), ['--disable-gpu'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', bytes => { logs += bytes.toString() })
  child.stderr.on('data', bytes => { logs += bytes.toString() })
  const timeout = setTimeout(() => child.kill(), 60000)
  let code
  try { [code] = await once(child, 'close') } finally { clearTimeout(timeout) }
  assert.equal(code, 0, logs)
  assert(fs.existsSync(screenshot), logs)
  assert(fs.statSync(screenshot).size > 10000)
  console.log('PASS portable EXE opens AI assistant with blank endpoint/model and no bundled provider key:', screenshot)
  fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), files.map(name => `${digest(fs.readFileSync(path.join(release, name)))}  ${name}`).join('\n') + '\n')
  console.log('PASS SHA256SUMS generated:', files.join(', '))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
