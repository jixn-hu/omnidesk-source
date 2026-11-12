const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
fs.mkdirSync(path.resolve('tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.resolve('tmp/clipboard-qa-'))
require('esbuild').buildSync({ entryPoints: ['src/renderer/src/features/desktop/rdp-clipboard.ts'], outfile: path.join(directory, 'clipboard.cjs'), bundle: true, format: 'cjs', platform: 'node' })
const { createRdpClipboard } = require(path.join(directory, 'clipboard.cjs'))
function fixture(overrides = {}) {
  const state = { active: true, local: 'QA 中文 🚀\r\n第二行', published: [], errors: [], writes: [], events: [] }
  const bridge = createRdpClipboard({
    canSync: () => state.active,
    readText: async () => { state.events.push('read'); return state.local },
    writeText: async text => { state.events.push('write'); state.local = text; state.writes.push(text) },
    publishText: async text => { state.events.push('publish'); state.published.push(text) },
    onError: message => state.errors.push(message), ...overrides
  })
  return { state, bridge }
}
async function main() {
  let { state, bridge } = fixture()
  await bridge.paste(() => state.events.push('Ctrl+V'))
  assert.deepEqual(state.events, ['read', 'publish', 'Ctrl+V'])
  assert.equal(state.published[0], 'QA 中文 🚀\r\n第二行')
  await bridge.sync()
  assert.equal(state.published.length, 1)
  await bridge.sync(true)
  assert.equal(state.published.length, 2)
  state.local = ''
  await bridge.sync()
  assert.equal(state.published.at(-1), '')
  await bridge.receive('QA remote copied text')
  assert.equal(state.local, 'QA remote copied text')
  const count = state.published.length
  await bridge.sync()
  assert.equal(state.published.length, count)
  state.active = false
  assert.equal(await bridge.receive('BACKGROUND MUST NOT OVERWRITE'), false)
  await bridge.paste(() => assert.fail('background paste'))
  assert.equal(state.local, 'QA remote copied text')
  console.log('PASS local-to-remote publishes before Ctrl+V, unicode/multiline/empty text, dedup, requested force-refresh, remote-to-local without echo, inactive tab isolation')
  let resolveRead
  ;({ state, bridge } = fixture({ readText: () => new Promise(done => { resolveRead = done }) }))
  const pending = bridge.paste(() => assert.fail('late paste after losing focus'))
  await Promise.resolve()
  state.active = false
  resolveRead('LOCAL SECRET MUST NOT LEAK')
  await pending
  assert.equal(state.published.length, 0)
  ;({ state, bridge } = fixture({ readText: () => new Promise(done => { resolveRead = done }) }))
  const disposed = bridge.sync()
  await Promise.resolve()
  bridge.dispose()
  resolveRead('AFTER DISCONNECT')
  assert.equal(await disposed, false)
  assert.equal(state.published.length, 0)
  console.log('PASS pending reads cancelled after focus/tab switch and disposal; no post-disconnect clipboard transfer')
  ;({ state, bridge } = fixture({ readText: () => new Promise(done => { resolveRead = done }) }))
  const switched = bridge.paste(() => assert.fail('stale paste after switching back'))
  await Promise.resolve()
  bridge.cancelPending()
  resolveRead('STALE TEXT')
  await switched
  assert.equal(state.published.length, 0)
  ;({ state, bridge } = fixture())
  await bridge.paste(() => { throw new Error('input closed') })
  assert(state.errors.at(-1).includes('粘贴未完成'))
  ;({ state, bridge } = fixture({ readText: async () => { throw new Error('sensitive clipboard details') } }))
  await bridge.paste(() => assert.fail('paste must not run on read error'))
  assert(state.errors.at(-1) && !state.errors.at(-1).includes('sensitive'))
  ;({ state, bridge } = fixture())
  state.local = 'x'.repeat(1024 * 1024 + 1)
  await bridge.paste(() => assert.fail('oversized paste'))
  assert.equal(state.published.length, 0)
  assert(state.errors.at(-1).includes('1M'))
  assert.equal(await bridge.receive(state.local), false)
  assert.equal(state.writes.length, 0)
  console.log('PASS clipboard errors stay nonfatal and do not include content; oversized text rejected in both directions')
  let releasePublish
  ;({ state, bridge } = fixture({ publishText: () => new Promise(done => { releasePublish = done }) }))
  const syncing = bridge.sync()
  await Promise.resolve(); await Promise.resolve()
  const received = bridge.receive('QA NEW REMOTE TEXT')
  releasePublish()
  assert.equal(await syncing, false)
  assert.equal(await received, true)
  assert.equal(state.local, 'QA NEW REMOTE TEXT')
  console.log('PASS remote copy invalidates stale queued local sync and serialized operations avoid races')
  ;({ state, bridge } = fixture({ preparePaste: async () => 'remote' }))
  bridge.receiveFormats()
  assert.equal(await bridge.sync(), false)
  assert.equal(await bridge.sync(true), false)
  assert.deepEqual(state.events, [])
  await bridge.paste(() => state.events.push('Ctrl+V'))
  assert.deepEqual(state.events, ['Ctrl+V'])
  assert.equal(await bridge.sync(), false)
  assert.equal(state.published.length, 0)
  ;({ state, bridge } = fixture({ preparePaste: async () => false }))
  await bridge.sync()
  bridge.receiveFormats()
  await bridge.paste(() => state.events.push('Ctrl+V'))
  assert.deepEqual(state.events, ['read', 'publish', 'read', 'publish', 'Ctrl+V'])
  assert.equal(state.published.length, 2)
  assert.equal(state.published[0], state.published[1])
  bridge.receiveFormats()
  await bridge.receive('REMOTE TEXT AFTER FILE COPY')
  state.local = 'NEW LOCAL TEXT'
  assert.equal(await bridge.sync(), true)
  assert.equal(state.published.at(-1), 'NEW LOCAL TEXT')
  console.log('PASS pending remote files block automatic text sync and preserve server-side paste; an explicit new local paste republishes identical text; remote text restores sync')
  let preparedResult = false
  ;({ state, bridge } = fixture({ preparePaste: async () => preparedResult }))
  await bridge.receive('REMOTE RICH TEXT')
  await bridge.sync(true)
  await bridge.paste(() => state.events.push('remote Ctrl+V'))
  await bridge.paste(() => state.events.push('remote Shift+Insert'))
  assert.equal(state.published.length, 0)
  preparedResult = 'remote'
  await bridge.paste(() => state.events.push('preserved remote formats'))
  preparedResult = true
  await bridge.paste(() => state.events.push('local file paste'))
  preparedResult = false
  await bridge.paste(() => state.events.push('local text after files'))
  assert.deepEqual(state.published, ['REMOTE RICH TEXT'])
  const afterLocalFilePaste = state.published.length
  await bridge.receive('SECOND REMOTE TEXT')
  await bridge.paste(() => state.events.push('remote copy after local files'))
  assert.equal(state.published.length, afterLocalFilePaste)
  console.log('PASS remote text paste preserves server formats; returning from a local file paste republishes identical text and a later server copy is not overwritten')
  ;({ state, bridge } = fixture({ preparePaste: async () => false }))
  await bridge.receive('')
  await bridge.paste(() => state.events.push('empty remote paste'))
  assert.equal(state.published.length, 0)
  state.local = 'NEW LOCAL TEXT AFTER EMPTY REMOTE COPY'
  await bridge.paste(() => state.events.push('new local paste'))
  assert.deepEqual(state.published, [state.local])
  ;({ state, bridge } = fixture({ readText: () => new Promise(done => { resolveRead = done }) }))
  const staleText = bridge.sync()
  await Promise.resolve()
  bridge.receiveFormats()
  resolveRead('OLD LOCAL TEXT')
  assert.equal(await staleText, false)
  assert.equal(state.published.length, 0)
  let releasePreparation
  let cancelledPreparations = 0
  ;({ state, bridge } = fixture({
    preparePaste: () => new Promise(done => { releasePreparation = done }),
    cancelPaste: () => { cancelledPreparations++ }
  }))
  const stalePaste = bridge.paste(() => assert.fail('paste after a newer remote file copy'))
  bridge.receiveFormats()
  assert.equal(cancelledPreparations, 1)
  releasePreparation(false)
  await stalePaste
  assert.deepEqual(state.events, [])
  assert.equal(await bridge.sync(true), false)
  ;({ state, bridge } = fixture({ preparePaste: () => new Promise(done => { releasePreparation = done }) }))
  const stalePreparedFiles = bridge.paste(() => assert.fail('stale prepared-file shortcut'))
  bridge.receiveFormats()
  releasePreparation(true)
  await stalePreparedFiles
  assert.deepEqual(state.events, [])
  console.log('PASS a remote file copy cancels pending text reads and file preparations without republishing old clipboard contents or sending stale shortcuts')
  ;({ state, bridge } = fixture({ canPublishText: async () => false }))
  assert.equal(await bridge.sync(), false, 'focus sync must preserve local files and untouched remote formats')
  assert.equal(state.published.length, 0)
  assert.deepEqual(state.events, [])
  let localTextReady = false
  ;({ state, bridge } = fixture({ canPublishText: async () => localTextReady }))
  bridge.receiveFormats()
  assert.equal(await bridge.sync(), false)
  localTextReady = true
  state.local = 'LOCAL COPY AFTER REMOTE FILES'
  assert.equal(await bridge.sync(), true, 'new local text must unblock focus sync after remote formats')
  assert.deepEqual(state.published, [state.local])
  console.log('PASS focus sync respects file/remote clipboard ownership and resumes after a new local text copy')
  ;({ state, bridge } = fixture())
  await bridge.sync()
  bridge.reset()
  await bridge.sync()
  assert.equal(state.published.length, 2, 'same local text must be offered to a recovered clipboard channel')
  ;({ state, bridge } = fixture({ readText: () => new Promise(done => { resolveRead = done }) }))
  const beforeRecovery = bridge.paste(() => assert.fail('paste started before recovery must be cancelled'))
  await Promise.resolve()
  bridge.reset()
  resolveRead('OLD PRE-RECOVERY READ')
  await beforeRecovery
  assert.equal(state.published.length, 0)
  ;({ state, bridge } = fixture({ canReceive: () => true }))
  state.active = false
  assert.equal(await bridge.receive('REMOTE COPY WHILE TOOLBAR HAS FOCUS'), true)
  assert.equal(state.local, 'REMOTE COPY WHILE TOOLBAR HAS FOCUS')
  assert.equal(await bridge.sync(), false, 'receive permission must not authorize sending local content')
  console.log('PASS recovery clears stale text caches and cancels earlier work; toolbar focus can receive without enabling background local reads')
  const factorySource = fs.readFileSync('node_modules/tabby-rdp/vendor/ironrdp-factory.js', 'utf8')
  const factory = await import('data:text/javascript;base64,' + Buffer.from(factorySource).toString('base64'))
  const module = await WebAssembly.compile(fs.readFileSync('node_modules/tabby-rdp/vendor/ironrdp_web_bg.wasm'))
  const runtime = await factory.createBackend(module, 'ERROR')
  try {
    for (const text of ['', 'QA中文 🚀\r\n第二行']) {
      const content = new runtime.Backend.ClipboardData()
      try {
        content.addText('text/plain', text)
        const items = content.items()
        try { assert.equal(items.find(item => item.mimeType().startsWith('text/')).value(), text) }
        finally { for (const item of items) item.free() }
      } finally { content.free() }
    }
  } finally { runtime.runtime.dispose() }
  console.log('PASS pinned real WASM ClipboardData Unicode/empty text encoding and explicit allocation cleanup')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
