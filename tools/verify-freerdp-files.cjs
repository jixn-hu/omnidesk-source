const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { WebSocket } = require('ws')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/freerdp-files-qa-'))
const sdk = path.join(root, 'tmp/freerdp-sdk')
const msys = process.env.OMNIDESK_MSYS2 || 'C:/msys64/ucrt64'
const libraries = process.env.OMNIDESK_QA_FREERDP_DIR || path.join(root, 'out/native-freerdp')
const environment = { ...process.env, PATH: `${libraries};${msys}/bin;${process.env.PATH}`, OPENSSL_MODULES: libraries, WLOG_LEVEL: 'OFF' }
const bundle = (source, name) => {
  const outfile = path.join(directory, name + '.cjs')
  esbuild.buildSync({ entryPoints: [source], outfile, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
  return require(outfile)
}
const { nativeNumbers, nativeCommand } = bundle('src/shared/freerdp-protocol.ts', 'protocol')
const { FreeRdpFiles, encodeFileDescriptors, parseFileDescriptors } = bundle('src/main/services/freerdp-files.ts', 'files')
const { FreeRdpService } = bundle('src/main/services/freerdp.ts', 'service')
const { createRdpClipboard } = bundle('src/renderer/src/features/desktop/rdp-clipboard.ts', 'clipboard')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(predicate, label, milliseconds = 20000) {
  const end = Date.now() + milliseconds
  while (!predicate()) { if (Date.now() > end) throw new Error('等待超时：' + label); await pause(20) }
}
function fnv(data) { let hash = 2166136261; for (const byte of data) hash = Math.imul(hash ^ byte, 16777619) >>> 0; return hash }
function remoteBytes(index, size) { return Buffer.from(Array.from({ length: size }, (_, offset) => (offset * 31 + index * 17) % 251)) }

async function main() {
  const oldRuntime = path.join(directory, 'old-runtime')
  fs.mkdirSync(oldRuntime)
  fs.writeFileSync(path.join(oldRuntime, 'manifest.json'), JSON.stringify({ protocol: 4, platform: 'win32-x64', files: { 'omnidesk-freerdp.exe': 'synthetic' } }))
  fs.writeFileSync(path.join(oldRuntime, 'omnidesk-freerdp.exe'), '')
  const oldService = new FreeRdpService(oldRuntime, { verifyPem: async () => {} })
  assert.equal(oldService.status().available, false)
  await oldService.dispose()
  console.log('PASS old helper protocol is rejected before any clipboard or network access')
  const encoded = encodeFileDescriptors([{ name: '中文🙂', directory: true, size: 0 }, { name: '中文🙂\\空.txt', directory: false, size: 0 }, { name: 'large.bin', directory: false, size: 2 ** 32 + 123 }])
  assert.equal(parseFileDescriptors(encoded)[2].size, 2 ** 32 + 123)
  for (const name of ['..\\escape', 'C:\\escape', '\\\\server\\share', '/tmp/escape', 'safe/evil', '.\\evil', 'safe\\..\\evil', 'safe\\', 'file:ads', 'NUL.txt', 'COM1', 'LPT¹.txt', 'space ', 'dot.', 'bad\0name', 'bad\ud800']) {
    assert.throws(() => encodeFileDescriptors([{ name, directory: false, size: 0 }]), undefined, name)
  }
  assert.throws(() => encodeFileDescriptors([{ name: 'same', directory: false, size: 0 }, { name: 'SAME', directory: false, size: 0 }]), /重复/)
  assert.throws(() => encodeFileDescriptors([{ name: 'parent', directory: false, size: 0 }, { name: 'parent\\child', directory: false, size: 0 }]), /冲突/)
  assert.throws(() => encodeFileDescriptors([{ name: 'huge', directory: false, size: 16 * 1024 ** 3 + 1 }]), /16 GiB/)
  assert.throws(() => parseFileDescriptors(encoded.subarray(0, -1)))
  assert.throws(() => parseFileDescriptors(Buffer.from([255, 255, 255, 255])))
  const reparse = Buffer.from(encodeFileDescriptors([{ name: 'link', directory: false, size: 0 }]))
  reparse.writeUInt32LE(0x480, 40)
  assert.throws(() => parseFileDescriptors(reparse), /链接/)
  for (const size of [-1, NaN, Infinity]) assert.throws(() => encodeFileDescriptors([{ name: 'invalid', directory: false, size }]))
  console.log('PASS descriptor Unicode/emoji/empty files/64-bit sizes; traversal, UNC, ADS, reserved names, aliases, links, truncation and oversized lists rejected')

  const selectionPackets = [], selectionStatuses = []
  let selectionSequence = 7
  let selectionReads = 0
  const selection = new FreeRdpFiles(packet => selectionPackets.push(Buffer.from(packet)), { read: async () => { selectionReads++; return { sequence: selectionSequence, paths: [] } }, write: async () => assert.fail('copy announcement must not modify the local clipboard') }, status => selectionStatuses.push(status))
  selection.handle(nativeCommand(9, nativeNumbers(1, 1, 1, 7)))
  assert.equal(selectionReads, 0)
  assert.equal(selectionPackets.length, 0)
  assert.equal(selectionStatuses.at(-1).state, 'available')
  assert.equal(await selection.publishLocal(() => true), 'remote')
  assert.equal(selectionPackets.length, 0)
  selectionSequence++
  assert.equal(await selection.publishLocal(() => true), false)
  assert.equal(selection.hasRemoteFiles, false)
  selection.handle(nativeCommand(9, nativeNumbers(1, 2, 0, 8)))
  assert.equal(selectionStatuses.at(-1).state, 'unavailable')
  const beforeRemoteTextPaste = selectionPackets.length
  assert.equal(await selection.publishLocal(() => true), 'remote', 'remote-only text paste must preserve the server clipboard')
  assert.equal(selectionPackets.length, beforeRemoteTextPaste, 'remote text paste must not announce old local formats')
  await assert.rejects(selection.receiveRemote(() => true), /没有可接收/)
  selection.dispose()
  console.log('PASS remote copy only announces availability, does not read local files or request remote data; unchanged local clipboard preserves server-side paste, new local copy takes precedence, text invalidates pending files')

  const shortcut = []
  let focused = true
  const clipboard = createRdpClipboard({ canSync: () => focused, readText: async () => { throw new Error('file paste must not publish text') }, writeText: async () => {}, publishText: async () => {}, preparePaste: async () => true, onError: message => shortcut.push(message) })
  await clipboard.paste(() => shortcut.push('paste-files'))
  assert.deepEqual(shortcut, ['paste-files'])
  focused = false
  await clipboard.paste(() => assert.fail('background paste'))
  clipboard.dispose()
  const wire = [], offsets = []
  const isolated = new FreeRdpFiles(packet => wire.push(Buffer.from(packet)), { read: async () => ({ sequence: 1, paths: [] }), write: async () => assert.fail('unit test must not touch clipboard') }, () => {})
  isolated.outgoing = [{ name: 'virtual-large.bin', directory: false, size: 2 ** 32 + 123, handle: { read: async (data, start, length, position) => { offsets.push(position); data.fill(0x5a); return { bytesRead: length } }, close: async () => {} } }]
  isolated.activeOutgoingId = 1
  isolated.handle(nativeCommand(9, nativeNumbers(3, 1, 10, 0, 2, 7, 1, 16)))
  await until(() => wire.length === 1, '64-bit source range')
  assert.deepEqual(offsets, [2 ** 32 + 7])
  assert.equal(wire[0].readUInt32LE(9), 1)
  assert.deepEqual(wire[0].subarray(13), Buffer.alloc(16, 0x5a))
  isolated.handle(nativeCommand(9, nativeNumbers(3, 1, 11, 999, 2, 0, 0, 16)))
  await until(() => wire.length === 2, 'invalid source index')
  assert.equal(wire[1].readUInt32LE(9), 0)
  isolated.handle(nativeCommand(9, nativeNumbers(3, 99, 12, 0, 2, 0, 0, 16)))
  await until(() => wire.length === 3, 'stale clipboard epoch')
  assert.equal(wire[2].readUInt32LE(9), 0)
  isolated.dispose()
  console.log('PASS explicit file paste bypasses text, preserves keyboard order and refuses inactive tabs')
  console.log('PASS >4 GiB source offsets without allocating huge files; unannounced file indices denied')

  execFileSync(path.join(libraries, 'omnidesk-freerdp.exe'), ['--clipboard-selftest'], { env: environment, windowsHide: true })
  console.log('PASS real Windows CF_HDROP Unicode round-trip and sequence compare-and-set on a PRIVATE window station (user clipboard untouched)')
  execFileSync(path.join(msys, 'bin/openssl.exe'), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { env: environment, windowsHide: true, stdio: 'ignore' })
  const ntHash = execFileSync(path.join(msys, 'bin/openssl.exe'), ['dgst', '-md4', '-provider', 'legacy', '-binary'], { input: Buffer.from('synthetic-only', 'utf16le'), env: environment, windowsHide: true }).toString('hex')
  fs.writeFileSync(path.join(directory, 'sam'), `synthetic-local-user:::${ntHash}:\n`)
  execFileSync(path.join(msys, 'bin/gcc.exe'), ['native/freerdp/test-peer.c', `-I${path.relative(root, sdk)}/include/freerdp3`, `-I${path.relative(root, sdk)}/include/winpr3`, `-L${path.relative(root, sdk)}/lib`, '-lfreerdp3', '-lwinpr3', '-lws2_32', '-D__STDC_NO_THREADS__', '-Wno-deprecated-declarations', '-o', path.relative(root, path.join(directory, 'test-peer.exe'))], { env: environment, windowsHide: true, stdio: 'inherit' })
  const selected = path.join(directory, '本地目录🙂')
  fs.mkdirSync(path.join(selected, '子目录'), { recursive: true })
  fs.mkdirSync(path.join(selected, '空目录'))
  const localData = Buffer.alloc(2 * 1024 * 1024 + 19)
  for (let offset = 0; offset < localData.length; offset++) localData[offset] = (offset * 13) % 253
  fs.writeFileSync(path.join(selected, '子目录/内容.bin'), localData)
  fs.writeFileSync(path.join(selected, '空文件.txt'), '')
  let resumePreparation
  const stagedWire = []
  const staged = new FreeRdpFiles(packet => stagedWire.push(packet), { read: () => new Promise(resolve => { resumePreparation = resolve }), write: async () => {} }, () => {})
  const preparation = staged.publishLocal(() => true)
  staged.cancelPreparation()
  resumePreparation({ sequence: 1, paths: [selected] })
  await assert.rejects(preparation, /取消/)
  assert.equal(stagedWire.length, 0)
  staged.dispose()
  console.log('PASS losing focus during file enumeration cancels before publishing any local file descriptor')
  let sequence = 50
  let localPaths = [selected]
  let localText = 'QA text'
  let onNextWrite
  const received = []
  let virtualClipboard
  const fileClipboard = {
    read: async () => ({ sequence, paths: [...localPaths] }),
    offer: async (metadata, expected, read) => {
      // Native peer reads the real OS sequence; this synthetic clipboard models that offer without touching the user clipboard.
      sequence = expected + 1; localPaths = []
      let finish
      const current = { metadata, read, sequence, finished: new Promise(resolve => { finish = resolve }), dispose: () => { if (virtualClipboard === current) virtualClipboard = undefined; finish() } }
      virtualClipboard = current
      return current
    },
    write: async (paths, expected) => { onNextWrite?.(); onNextWrite = undefined; if (expected !== sequence) throw new Error('本机剪贴板已改变，未覆盖'); received.push(paths); sequence++; localPaths = paths; return sequence }
  }
  const cache = path.join(directory, 'cache')
  fs.mkdirSync(path.join(cache, 'copy-ABC123'), { recursive: true })
  fs.writeFileSync(path.join(cache, 'copy-ABC123/old.txt'), 'synthetic old cache')
  fs.utimesSync(path.join(cache, 'copy-ABC123'), new Date(0), new Date(0))
  fs.mkdirSync(path.join(cache, 'not-a-cache'))
  const service = new FreeRdpService(libraries, { verifyPem: async () => {} }, fileClipboard, cache)
  const peers = [], clients = []
  const connect = async (options = {}, renderer = false, noFiles = false, nla = false) => {
    const peer = spawn(path.join(directory, 'test-peer.exe'), [path.relative(root, path.join(directory, 'cert.pem')), path.relative(root, path.join(directory, 'key.pem')), nla ? '2' : options.securityMode === 'legacy' ? '1' : '0', path.relative(root, path.join(directory, 'sam')), ...(noFiles ? [] : ['files'])], { env: environment, windowsHide: true })
    peers.push(peer)
    peer.lines = ''; peer.errors = ''
    peer.stdout.on('data', chunk => { peer.lines += chunk.toString() })
    peer.stderr.on('data', chunk => { peer.errors += chunk.toString() })
    await until(() => /port (\d+)/.test(peer.lines), 'test peer port')
    const transport = await service.prepare('127.0.0.1', Number(/port (\d+)/.exec(peer.lines)[1]), { username: 'synthetic-local-user', password: 'synthetic-only', domain: '' }, { engine: 'freerdp', ...options })
    if (renderer) { const client = { peer, transport }; clients.push(client); return client }
    const socket = new WebSocket(transport.wsUrl)
    const packets = [], statuses = []
    socket.on('message', data => { const packet = Buffer.from(data); packets.push(packet); if (packet[0] === 10) statuses.push(JSON.parse(packet.subarray(1).toString())) })
    await once(socket, 'open')
    socket.send(nativeCommand(3, nativeNumbers(800, 600, 100)))
    const client = { transport, socket, peer, packets, statuses }
    clients.push(client)
    await until(() => packets.some(packet => packet[0] === 1), 'FreeRDP connected').catch(error => { throw new Error(error.message + '\n' + peer.errors + '\n' + packets.filter(packet => packet[0] === 4).map(packet => packet.subarray(1).toString()).join('\n')) })
    await pause(150)
    return client
  }
  const press = (client, scan) => client.socket.send(nativeCommand(2, nativeNumbers(2, 1, scan, 0, 2, scan, 0)))
  const available = async (client, scan) => { const count = client.statuses.length; press(client, scan); await until(() => client.statuses.slice(count).some(status => status.state === 'available'), 'remote file announcement'); return client.statuses.length }
  try {
    const client = await connect()
    await assert.rejects(service.clipboardFiles(client.transport.sessionId, 'paste', () => false), /聚焦/)
    assert.equal(await service.clipboardFiles(client.transport.sessionId, 'paste', () => true), true)
    await until(() => client.peer.lines.includes('files-upload-complete'), 'upload files; ' + client.peer.errors)
    assert.match(client.peer.lines, new RegExp(`file-upload \\d+ ${localData.length} ${fnv(localData)}`))
    assert.match(client.peer.lines, /file-upload \d+ 0 2166136261/)
    assert.match(client.peer.lines, new RegExp(Buffer.from('本地目录🙂', 'utf16le').swap16().toString('hex')))
    console.log('PASS real TLS cliprdr local-to-remote multi-MiB chunks, Unicode/emoji directories and empty files; peer verifies byte hash')
    client.socket.send(nativeCommand(4, Buffer.from('must not replace file clipboard during focus synchronization')))
    await pause(100)
    assert.equal(client.packets.filter(packet => packet[0] === 3).length, 0)
    await available(client, 0x3b)
    await service.clipboardFiles(client.transport.sessionId, 'receive', () => false).then(() => assert.fail('background receive'), error => assert.match(error.message, /聚焦/))
    await service.clipboardFiles(client.transport.sessionId, 'receive', () => true)
    await until(() => received.length === 1, 'remote download')
    const folder = received[0].find(item => path.basename(item) === '远端目录')
    assert.ok(folder)
    assert.deepEqual(fs.readFileSync(path.join(folder, '内容🙂.bin')), remoteBytes(1, 1024 * 1024 + 37))
    assert.equal(fs.statSync(path.join(folder, '空文件.txt')).size, 0)
    assert.deepEqual(fs.readdirSync(path.join(folder, '空目录')), [])
    assert.deepEqual(fs.readFileSync(received[0].find(item => path.basename(item) === '根文件.txt')), remoteBytes(3, 13))
    await until(() => client.statuses.at(-1)?.state === 'complete', 'download completion notification')
    console.log('PASS real TLS cliprdr remote-to-local size/range PDUs and multi-chunk byte equality, directory tree and empty files; completed paths retained for local paste')
    for (const [scan, expected] of [[0x3c, /不安全/], [0x3d, /长度/], [0x3f, /拒绝/]]) {
      const before = received.length
      await available(client, scan)
      await service.clipboardFiles(client.transport.sessionId, 'receive', () => true)
      await until(() => client.statuses.at(-1)?.state === 'error', 'failure surfaced')
      assert.match(client.statuses.at(-1).message, expected)
      assert.equal(received.length, before)
      assert.equal(client.packets.filter(packet => packet[0] === 3).length, 0)
    }
    assert.equal(fs.existsSync(path.join(cache, 'escaped')), false)
    console.log('PASS malicious remote path, premature EOF and file-read denial do not change local clipboard or disconnect desktop')
    await available(client, 0x40)
    const pending = service.clipboardFiles(client.transport.sessionId, 'receive', () => true)
    await pause(200)
    await service.clipboardFiles(client.transport.sessionId, 'cancel', () => true)
    await pending
    assert.ok(client.statuses.some(status => status.state === 'cancelled'))
    console.log('PASS cancellation interrupts pending server reads and cleans partial downloads')
    await available(client, 0x3b)
    onNextWrite = () => { sequence++ }
    const changing = service.clipboardFiles(client.transport.sessionId, 'receive', () => true)
    await changing
    await until(() => client.statuses.at(-1)?.state === 'error', 'clipboard changed')
    assert.match(client.statuses.at(-1).message, /改变/)
    assert.equal(received.length, 1)
    console.log('PASS changed local clipboard is not overwritten after remote download')
    const legacy = await connect({ securityMode: 'legacy' })
    await available(legacy, 0x3b)
    await service.clipboardFiles(legacy.transport.sessionId, 'receive', () => true)
    assert.equal(received.length, 2)
    await until(() => legacy.statuses.some(status => status.state === 'complete' && status.direction === 'download'), 'legacy completion')
    assert.equal(client.statuses.filter(status => status.state === 'complete' && status.direction === 'download').length, 1)
    console.log('PASS Standard RDP Security file transfer and concurrent session isolation')
    assert.equal(fs.existsSync(path.join(cache, 'copy-ABC123')), false)
    assert.equal(fs.existsSync(path.join(cache, 'not-a-cache')), true)
    assert.equal(fs.existsSync(folder), true)
    console.log('PASS only expired app-owned caches are removed; recent copies and unrelated directories are retained')
    const previousCount = received.length
    await available(client, 0x40)
    const older = service.clipboardFiles(client.transport.sessionId, 'receive', () => true)
    await pause(100)
    await available(legacy, 0x3b)
    await service.clipboardFiles(legacy.transport.sessionId, 'receive', () => true)
    await older
    assert.equal(received.length, previousCount + 1)
    console.log('PASS a newer copy in another session cancels the old pending download before changing the shared OS clipboard')
    localPaths = [selected]
    const nla = await connect({}, false, false, true)
    assert.equal(await service.clipboardFiles(nla.transport.sessionId, 'paste', () => true), true)
    await until(() => nla.peer.lines.includes('files-upload-complete'), 'NLA file upload')
    assert.match(nla.peer.lines, new RegExp(`file-upload \\d+ ${localData.length} ${fnv(localData)}`))
    await available(nla, 0x3b)
    const beforeNla = received.length
    await service.clipboardFiles(nla.transport.sessionId, 'receive', () => true)
    assert.equal(received.length, beforeNla + 1)
    assert.match(nla.peer.lines, /logon 1/)
    console.log('PASS real NLA/NTLM authentication plus bidirectional file clipboard with synthetic credentials')
    const disabled = await connect({ enableClipboard: false })
    await assert.rejects(service.clipboardFiles(disabled.transport.sessionId, 'paste', () => true), /聚焦/)
    await assert.rejects(service.clipboardFiles(disabled.transport.sessionId, 'receive', () => true), /聚焦/)
    console.log('PASS disabled clipboard denies both file directions')
    localPaths = [selected]
    const noFiles = await connect({}, false, true)
    await assert.rejects(service.clipboardFiles(noFiles.transport.sessionId, 'paste', () => true), /未启用文件剪贴板/)
    assert.equal(noFiles.packets.filter(packet => packet[0] === 3).length, 0)
    const injection = await connect()
    injection.socket.send(nativeCommand(8, nativeNumbers(5)))
    await until(() => injection.packets.some(packet => packet[0] === 3), 'renderer file command blocked')
    console.log('PASS server without file capabilities rejects file paste nonfatally; renderer cannot inject native file commands')
    localPaths = []
    assert.equal(await service.clipboardFiles(client.transport.sessionId, 'paste', () => true), false)
    client.socket.send(nativeCommand(4, Buffer.from('QA text still works after file paste')))
    await pause(100)
    assert.equal(client.packets.filter(packet => packet[0] === 3).length, 0)
    console.log('PASS switching from files back to text keeps the desktop alive')
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ executablePath: process.env.OMNIDESK_QA_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
    try {
      localPaths = [selected]
      const renderer = await connect({}, true)
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.setContent('<main style="width:800px;height:600px"><canvas tabindex="0" style="width:800px;height:600px"></canvas></main><div id="file-notice"></div>')
      await page.exposeFunction('fileClipboardAction', action => service.clipboardFiles(renderer.transport.sessionId, action, () => true))
      await page.exposeFunction('readSyntheticText', () => localText)
      await page.exposeFunction('writeSyntheticText', text => { localText = text; localPaths = []; sequence++ })
      for (const [source, globalName] of [['freerdp-runtime', 'nativeRdp'], ['rdp-clipboard', 'rdpClipboard'], ['input', 'rdpInput']]) {
        const script = esbuild.buildSync({ entryPoints: [`src/renderer/src/features/desktop/${source}.ts`], bundle: true, format: 'iife', globalName, write: false, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
        await page.addScriptTag({ content: script })
      }
      const ts = require('typescript')
      const source = ts.createSourceFile('DesktopView.tsx', fs.readFileSync('src/renderer/src/features/desktop/DesktopView.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      let implementation, clipboardImplementation
      function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'attachInput') implementation = node.initializer.getText(source)
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'remoteClipboardChangedCallback') clipboardImplementation = node.arguments[0].getText(source)
        ts.forEachChild(node, visit)
      }
      visit(source)
      assert.ok(implementation && clipboardImplementation)
      const attachScript = ts.transpileModule('const attachInput = ' + implementation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      const clipboardScript = ts.transpileModule('const remoteClipboardChanged = ' + clipboardImplementation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      const noticeScript = esbuild.buildSync({ stdin: { contents: `import { createElement } from 'react'; import { createRoot } from 'react-dom/client'; import Notice from './src/renderer/src/features/desktop/FileTransferNotice'; const root = createRoot(document.querySelector('#file-notice')); export function render(status, onCancel, onDismiss) { root.render(status ? createElement(Notice, { status, onCancel, onDismiss }) : null) }`, resolveDir: root, loader: 'tsx' }, bundle: true, format: 'iife', globalName: 'fileNotice', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
      await page.addScriptTag({ content: noticeScript })
      await page.evaluate(transport => { window.qaTransport = transport }, renderer.transport)
      await page.evaluate(`(async () => {
        const runtime = nativeRdp.createFreeRdpRuntime();
        const builder = new runtime.SessionBuilder();
        const canvas = document.querySelector('canvas');
        const activeRef = { current: true }, containerRef = { current: document.querySelector('main') }, cleanupRef = { current: null }, keyboardRef = { current: null }, pasteClipboardRef = { current: null };
        window.fileStatuses = [];
        window.clipboardErrors = [];
        const phase = 'live', clipboardEnabled = true, transportRef = { current: qaTransport.sessionId };
        let disposed = false, fileTransfer = null, clipboardBridge;
        const api = window.omnidesk || {}, transportId = qaTransport.sessionId;
        window.omnidesk = { rdp: { clipboardFiles: async (sessionId, action) => { try { return { ok: true, data: await fileClipboardAction(action) } } catch (error) { return { ok: false, message: error.message } } } } };
        api.rdp = window.omnidesk.rdp;
        const renderNotice = () => fileNotice.render(fileTransfer, () => void fileClipboardAction('cancel'), () => setFileTransfer(null));
        const setFileTransfer = next => { fileTransfer = typeof next === 'function' ? next(fileTransfer) : next; if (fileTransfer) fileStatuses.push(fileTransfer); renderNotice() };
        const setClipboardError = message => { if (message) clipboardErrors.push(message) };
        ${clipboardScript}
        const canSync = () => activeRef.current && document.hasFocus() && (document.activeElement === canvas || document.activeElement === keyboardRef.current);
        builder.proxyAddress(qaTransport.wsUrl).renderCanvas(canvas).desktopSize(new runtime.DesktopSize(800, 600)).remoteClipboardChangedCallback(remoteClipboardChanged);
        const session = await builder.connect();
        const sessionRef = { current: session };
        const bridge = rdpClipboard.createRdpClipboard({ canSync, readText: () => readSyntheticText(), writeText: text => writeSyntheticText(text), publishText: async text => { const data = new runtime.ClipboardData(); data.addText('text/plain', text); try { await session.onClipboardPaste(data) } finally { data.free() } }, preparePaste: () => fileClipboardAction('paste'), onError: message => { if (message) throw new Error(message) } });
        clipboardBridge = bridge;
        const { scancodeFor, shouldUseUnicode, mouseButtonFor } = rdpInput;
        const rdpDisplaySize = () => { throw new Error('unexpected resize') };
        ${attachScript}
        attachInput(canvas, session, runtime, false, true, undefined, bridge);
        window.fixture = { runtime, builder, session, cleanupRef, activeRef, bridge };
        window.outcome = session.run();
        canvas.focus();
      })()`)
      await page.keyboard.press('Control+v')
      await until(() => renderer.peer.lines.includes('files-upload-complete'), 'browser file Ctrl+V')
      assert.match(renderer.peer.lines, new RegExp(`file-upload \\d+ ${localData.length} ${fnv(localData)}`))
      const before = received.length
      const cachedBefore = fs.readdirSync(cache).sort()
      await page.keyboard.press('F1')
      await until(() => !!virtualClipboard, 'automatic remote virtual-file offer')
      await pause(150)
      assert.equal(await page.getByRole('button', { name: '接收到本机', exact: true }).count(), 0)
      assert.equal(await page.locator('#file-notice').innerText(), '')
      assert.equal(received.length, before)
      assert.deepEqual(fs.readdirSync(cache).sort(), cachedBefore)
      assert(renderer.peer.lines.includes('remote-descriptors-requested'))
      assert(!renderer.peer.lines.includes('remote-content-requested'))
      const uploadsBefore = renderer.peer.lines.match(/files-upload-complete/g)?.length ?? 0
      await page.keyboard.press('Control+v')
      await page.keyboard.press('Shift+Insert')
      await until(() => (renderer.peer.lines.match(/paste-origin 1/g)?.length ?? 0) >= 2, 'remote copy stays on server with both shortcuts')
      assert.equal(renderer.peer.lines.match(/files-upload-complete/g)?.length ?? 0, uploadsBefore)
      assert(!renderer.peer.lines.includes('remote-content-requested'))
      const currentOffer = virtualClipboard, consumed = []
      for (const [index, entry] of parseFileDescriptors(currentOffer.metadata).entries()) if (!entry.directory) {
        const target = await currentOffer.read(index); consumed.push(target)
        assert.deepEqual(fs.readFileSync(target), remoteBytes(index, entry.size))
      }
      await page.waitForFunction(() => fileStatuses.some(status => status.state === 'complete' && status.direction === 'download'))
      assert.equal(received.length, before, 'Local consumption keeps the OLE offer instead of writing CF_HDROP')
      assert(renderer.peer.lines.includes('remote-content-requested'))
      const formatsAfterDownload = renderer.peer.lines.match(/client-clipboard-format/g)?.length ?? 0
      await page.locator('canvas').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('Control+v')
      await pause(100)
      assert.equal(renderer.peer.lines.match(/client-clipboard-format/g)?.length ?? 0, formatsAfterDownload)
      const uploadsAfterCachedPaste = renderer.peer.lines.match(/files-upload-complete/g)?.length ?? 0
      localPaths = consumed; sequence++
      await page.keyboard.press('Control+v')
      await until(() => (renderer.peer.lines.match(/files-upload-complete/g)?.length ?? 0) > uploadsAfterCachedPaste, 'a new local copy supersedes the remote offer')
      await page.evaluate(() => { fixture.activeRef.current = false; const transaction = new fixture.runtime.InputTransaction(); transaction.addEvent(fixture.runtime.DeviceEvent.keyPressed(0x3b)); fixture.session.applyInputs(transaction) })
      await until(() => !virtualClipboard, 'background remote copy revokes previous offer')
      await pause(150)
      assert.equal(virtualClipboard, undefined, 'Background tabs must not publish clipboard offers')
      await page.evaluate(() => { fixture.activeRef.current = true; const transaction = new fixture.runtime.InputTransaction(); transaction.addEvent(fixture.runtime.DeviceEvent.keyPressed(0x3b)); fixture.session.applyInputs(transaction) })
      await until(() => !!virtualClipboard, 'active remote copy publishes another lazy offer')
      const oldRead = virtualClipboard.read
      await page.evaluate(() => { const transaction = new fixture.runtime.InputTransaction(); transaction.addEvent(fixture.runtime.DeviceEvent.keyPressed(0x3e)); fixture.session.applyInputs(transaction) })
      await until(() => !virtualClipboard, 'remote text invalidates offered files')
      await assert.rejects(oldRead(0), /取消/)
      assert.equal(received.length, before)
      await until(() => localText === 'QA remote text' && localPaths.length === 0, 'remote text mirrored into synthetic local clipboard')
      const countFormats = () => renderer.peer.lines.match(/client-clipboard-format/g)?.length ?? 0
      const remoteTextFormats = countFormats()
      await page.locator('canvas').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('Control+v')
      await page.keyboard.press('Shift+Insert')
      await until(() => (renderer.peer.lines.match(/paste-origin 2/g)?.length ?? 0) >= 2, 'server-side text paste by both shortcuts')
      await page.locator('canvas').click({ button: 'right', position: { x: 20, y: 20 } })
      await page.evaluate(() => fixture.bridge.sync())
      assert.equal(countFormats(), remoteTextFormats, 'remote text paste and focus must not republish stale local formats')
      localText = 'QA repeated local text'; localPaths = []; sequence++
      await page.keyboard.press('Control+v')
      await until(() => countFormats() > remoteTextFormats, 'new local text overrides remote copy')
      const repeatedText = Buffer.from(localText, 'utf16le').toString('hex').match(/.{4}/g).map(value => value.slice(2) + value.slice(0, 2)).join('')
      await until(() => renderer.peer.lines.includes('client-text ' + repeatedText), 'local text payload')
      const uploadsBeforeRepeat = renderer.peer.lines.match(/files-upload-complete/g)?.length ?? 0
      localPaths = [selected]; localText = ''; sequence++
      await page.keyboard.press('Control+v')
      await until(() => (renderer.peer.lines.match(/files-upload-complete/g)?.length ?? 0) > uploadsBeforeRepeat, 'local files following text')
      localPaths = []; localText = 'QA repeated local text'; sequence++
      await page.keyboard.press('Control+v')
      await until(() => renderer.peer.lines.split('client-text ' + repeatedText).length >= 3, 'identical local text republished after files')
      await page.keyboard.press('F7')
      await pause(100)
      sequence = service.sessions.get(renderer.transport.sessionId).files.remoteSequence
      const imageFormats = countFormats()
      await page.keyboard.press('Control+v')
      await page.keyboard.press('Shift+Insert')
      await until(() => (renderer.peer.lines.match(/paste-origin 3/g)?.length ?? 0) >= 2, 'unhandled remote image remains server-owned')
      await page.locator('canvas').click({ button: 'right', position: { x: 20, y: 20 } })
      await page.evaluate(() => fixture.bridge.sync(true))
      assert.equal(countFormats(), imageFormats, 'server image must not be replaced by old local text')
      await page.keyboard.press('F8')
      await until(() => !!virtualClipboard, 'remote cut offers copy-only local access')
      sequence = service.sessions.get(renderer.transport.sessionId).files.remoteSequence
      const cutFormats = countFormats()
      await page.keyboard.press('Control+v')
      await until(() => renderer.peer.lines.includes('paste-origin 4'), 'remote cut metadata remains on the server')
      assert.equal(countFormats(), cutFormats)
      assert.equal(received.length, before)
      await page.evaluate(async () => { fixture.cleanupRef.current(); fixture.session.shutdown(); await outcome; fixture.builder.free(); fixture.runtime.runtime.dispose() })
      assert.deepEqual(errors, [])
      assert.deepEqual(await page.evaluate(() => clipboardErrors), [])
      console.log('PASS real DesktopView → native FreeRDP: automatic metadata-only offers and on-demand content, server-only text/files/cached-files/images/cut formats, Ctrl+V/Shift+Insert and right-click/focus ownership, new local copies and text→files→identical text; background guards and text invalidation')
    } finally { await browser.close() }
  } finally {
    for (const client of clients) { service.release(client.transport.sessionId); client.socket?.terminate() }
    await service.dispose()
    for (const peer of peers) peer.kill()
  }
  console.log('FreeRDP bidirectional file clipboard checks passed: ' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
