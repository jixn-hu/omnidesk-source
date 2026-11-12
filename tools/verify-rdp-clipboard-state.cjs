const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), sdk = 'tmp/freerdp-sdk'
const msys = process.env.OMNIDESK_MSYS2 || 'C:/msys64/ucrt64'
const directory = fs.mkdtempSync(path.join(root, 'tmp/clipboard-state-qa-'))
const env = { ...process.env, PATH: path.join(root, 'out/native-freerdp') + ';' + msys + '/bin;' + process.env.PATH, WLOG_LEVEL: 'OFF' }
const executable = path.join(directory, 'clipboard-state.exe')
execFileSync(path.join(msys, 'bin/gcc.exe'), ['native/freerdp/test-clipboard-state.c', 'native/freerdp/file-clipboard.c', 'native/freerdp/virtual-files.c', '-I' + sdk + '/include/freerdp3', '-I' + sdk + '/include/winpr3', '-L' + sdk + '/lib', '-lfreerdp-client3', '-lfreerdp3', '-lwinpr3', '-lws2_32', '-lshell32', '-luser32', '-lole32', '-luuid', '-lshlwapi', '-D__STDC_NO_THREADS__', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-Wno-unknown-pragmas', '-o', path.relative(root, executable)], { cwd: root, env, stdio: 'inherit', windowsHide: true })
let failures = 0
for (const scenario of ['local-text', 'local-file', 'reconnect']) {
  try {
    const result = spawnSync(executable, [scenario], { env, windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 0, result.stderr?.toString())
    const text = []
    for (let offset = 0; offset < result.stdout.length;) {
      const length = result.stdout.readUInt32LE(offset); offset += 4
      const packet = result.stdout.subarray(offset, offset + length); offset += length
      if (packet[0] === 5) text.push(packet.subarray(1).toString('utf8'))
    }
    assert.deepEqual(text, scenario === 'reconnect' ? [] : ['FRESH REMOTE RESPONSE'], 'stale response must not reach renderer')
    console.log('PASS ' + scenario + ': ' + result.stderr.toString().trim())
  } catch (error) { failures++; console.error('FAIL ' + scenario + ': ' + error.message) }
}
assert.equal(failures, 0, 'clipboard state regressions')


async function verifyBridgeRecovery() {
  const bundle = (source, name) => {
    const outfile = path.join(directory, name + '.cjs')
    require('esbuild').buildSync({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
    return require(outfile)
  }
  const { FreeRdpFiles } = bundle('src/main/services/freerdp-files.ts', 'files')
  const { nativeCommand, nativeNumbers } = bundle('src/shared/freerdp-protocol.ts', 'protocol')
  const packets = []
  let snapshot = { sequence: 10, paths: [] }
  const files = new FreeRdpFiles(packet => packets.push(packet), { read: async () => snapshot, write: async () => assert.fail('inspection must not write the OS clipboard') }, () => {})
  files.handle(nativeCommand(9, nativeNumbers(1, 2, 1, 10)))
  assert.equal(await files.prepareTextSync(() => true), 'remote')
  snapshot = { sequence: 11, paths: ['C:\\synthetic-nonexistent-file'] }
  assert.equal(await files.prepareTextSync(() => true), true, 'focus inspection must not stat or enumerate copied files')
  snapshot = { sequence: 12, paths: [] }
  assert.equal(await files.prepareTextSync(() => true), false)
  assert.equal(files.hasRemoteFiles, false, 'new local text releases obsolete remote files')
  assert(packets.every(packet => packet[0] === 8 && new DataView(packet.buffer, packet.byteOffset).getUint32(1, true) === 5), 'text preparation may only cancel obsolete files, never announce or transfer them')
  files.handle(nativeCommand(9, nativeNumbers(1, 3, 1, 12)))
  files.reset()
  assert.equal(files.hasRemoteFiles, false)
  assert.equal(await files.prepareTextSync(() => true), false, 'old remote ownership must not survive channel recovery')
  await assert.rejects(files.prepareTextSync(() => false), /聚焦/)
  files.dispose()
  console.log('PASS text preparation never reads file contents, preserves local files and revokes obsolete remote files; recovery drops obsolete ownership')

  let releaseSnapshot
  const raced = new FreeRdpFiles(() => assert.fail('a stale probe must not cancel or send clipboard data'), { read: () => new Promise(resolve => { releaseSnapshot = resolve }), write: async () => 0 }, () => {})
  const oldProbe = raced.prepareTextSync(() => true)
  raced.handle(nativeCommand(9, nativeNumbers(1, 20, 1, 99)))
  releaseSnapshot({ sequence: 98, paths: [] })
  await assert.rejects(oldProbe, /取消/)
  assert.equal(raced.hasRemoteFiles, true, 'a newer remote file copy must survive an older asynchronous local probe')
  raced.dispose()
  console.log('PASS a remote copy during the local snapshot read cancels the old text probe without revoking the new files')

  const { createFreeRdpRuntime } = bundle('src/renderer/src/features/desktop/freerdp-runtime.ts', 'runtime')
  let receive
  const sent = []
  let failSend = false
  const runtime = createFreeRdpRuntime((_address, callback) => { receive = callback; return { send: data => { if (failSend) throw new Error('synthetic transport failure'); sent.push(data) }, close() {} } })
  const builder = new runtime.SessionBuilder()
  builder.proxyAddress('ws://127.0.0.1/freerdp/synthetic')
  builder.renderCanvas({ getContext: () => ({}), width: 0, height: 0 })
  const pending = builder.connect()
  receive({ kind: 'open' })
  receive({ kind: 'data', data: nativeCommand(1, nativeNumbers(800, 600)) })
  const session = await pending
  const content = new runtime.ClipboardData()
  content.addText('text/plain', 'SYNTHETIC RECOVERY TEXT')
  await session.onClipboardPaste(content)
  const before = sent.filter(packet => packet[0] === 4).length
  receive({ kind: 'data', data: nativeCommand(11, nativeNumbers(1, 1)) })
  await assert.rejects(session.onClipboardPaste(content), /恢复/)
  assert.equal(sent.filter(packet => packet[0] === 4).length, before)
  receive({ kind: 'data', data: nativeCommand(11, nativeNumbers(0, 1)) })
  await session.onClipboardPaste(content)
  assert.equal(sent.filter(packet => packet[0] === 4).length, before + 1)
  failSend = true
  await assert.rejects(session.onClipboardPaste(content), /发送失败/, 'failed socket sends must not populate the clipboard success cache')
  session.shutdown()
  await assert.rejects(session.onClipboardPaste(content), /关闭/)
  runtime.runtime.dispose()
  console.log('PASS native renderer rejects clipboard sends during recovery/after close, resumes after recovery and reports socket send failures')
}
verifyBridgeRecovery().catch(error => { console.error(error); process.exitCode = 1 })
