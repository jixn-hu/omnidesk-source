const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/virtual-files-qa-'))
const output = path.join(directory, 'files.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/services/freerdp-files.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const { FreeRdpFiles, encodeFileDescriptors } = require(output)
const numbers = (...values) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeUInt32LE(value >>> 0, index * 4)); return bytes }
const event = (action, values, data = Buffer.alloc(0)) => Buffer.concat([Buffer.from([9]), numbers(action, ...values), data])
const bytes = Buffer.from('Virtual clipboard content 中文\n'.repeat(1000))
const descriptors = encodeFileDescriptors([{ name: '中文文件.txt', directory: false, size: bytes.length }])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const fixture = path.join(directory, '虚拟文件内容.txt'); fs.writeFileSync(fixture, bytes)
  const native = path.join(process.env.OMNIDESK_QA_FREERDP_DIR || path.join(root, 'out/native-freerdp'), 'omnidesk-freerdp.exe')
  const child = spawn(native, ['--virtual-test'], { cwd: path.dirname(native), windowsHide: true, stdio: 'pipe' })
  let buffered = Buffer.alloc(0), requests = 0, readyResolve, finished = false, nativeError = ''
  const ready = new Promise(resolve => { readyResolve = resolve })
  const timeout = setTimeout(() => child.kill(), 20000)
  child.stderr.on('data', data => { nativeError += data })
  child.stdout.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 12) {
      assert.equal(buffered.readUInt32LE(), 8)
      const action = buffered.readUInt32LE(4), value = buffered.readUInt32LE(8); buffered = buffered.subarray(12)
      if (action === 1) readyResolve()
      else if (action === 2) { requests++; assert.equal(value, 0); const response = Buffer.concat([numbers(1), Buffer.from(fixture)]); child.stdin.write(Buffer.concat([numbers(response.length), response])) }
      else if (action === 3) { assert.equal(value, 0); finished = true }
      else assert.fail('Unknown native event')
    }
  })
  const closed = once(child, 'close')
  child.stdin.write(Buffer.concat([numbers(4 + descriptors.length, 0), descriptors]))
  await Promise.race([ready, closed.then(([code]) => { throw new Error('Native clipboard initialization failed: ' + code + ' ' + nativeError) })])
  await delay(100)
  assert.equal(requests, 0, 'Listing and copying the remote descriptor must not read contents')
  child.stdin.write(numbers(4, 1))
  const [code] = await closed; clearTimeout(timeout)
  assert.equal(code, 0, nativeError); assert.equal(requests, 1); assert(finished)
  console.log('PASS actual OLE clipboard on an isolated Windows desktop: formats/descriptor are lazy; FILECONTENTS requests an IStream only when consumed; Unicode cache paths work')

  let files, offered, disposed = 0, reads = 0, clipboardSequence = 17
  const statuses = [], transport = []
  const clipboard = {
    read: async () => ({ sequence: clipboardSequence, paths: [] }),
    write: async () => { throw new Error('Automatic paste must not replace local clipboard with downloaded paths') },
    offer: async (metadata, sequence, readFile) => { assert.deepEqual(metadata, descriptors); assert.equal(sequence, 17); offered = readFile; clipboardSequence = 23; return { sequence: 23, dispose: () => disposed++, finished: new Promise(() => {}) } }
  }
  files = new FreeRdpFiles(packet => {
    const data = Buffer.from(packet); transport.push(data)
    if (data[0] !== 8) return
    const action = data.readUInt32LE(1)
    if (action === 2) queueMicrotask(() => files.handle(event(2, [1, 1], descriptors)))
    if (action === 3) {
      reads++
      const stream = data.readUInt32LE(5), flags = data.readUInt32LE(13), position = data.readUInt32LE(17), count = data.readUInt32LE(25)
      const content = flags === 1 ? (() => { const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(bytes.length)); return size })() : bytes.subarray(position, position + count)
      queueMicrotask(() => files.handle(event(4, [stream, 1], content)))
    }
  }, clipboard, status => statuses.push(status), path.join(directory, 'cache'))
  files.handle(event(1, [1, 1, 17]))
  await files.offerRemote()
  assert.equal(reads, 0)
  assert.equal(await files.publishLocal(() => true), 'remote')
  assert.equal(reads, 0, 'Pasting inside the server must not fetch content')
  const local = await offered(0)
  assert.deepEqual(fs.readFileSync(local), bytes)
  const firstReads = reads
  assert.equal(await offered(0), local); assert.equal(reads, firstReads, 'Repeat pastes reuse this clipboard generation cache')
  assert(statuses.some(status => status.direction === 'download' && status.state === 'complete'))
  assert(!statuses.some(status => /接收到本机|尚未传输/.test(status.message)))
  files.handle(event(1, [2, 0, 24]))
  assert.equal(disposed, 1)
  files.dispose()
  console.log('PASS RDP clipboard generation offers metadata without download, server-local paste stays remote, local consumption downloads exact bytes once, and newer clipboard generations revoke old offers')
  let stale, readyOffer, finishOffer, revocations = 0
  const staleClipboard = { ...clipboard, offer: () => new Promise(resolve => { readyOffer = resolve }) }
  stale = new FreeRdpFiles(packet => {
    const data = Buffer.from(packet)
    if (data[0] === 8 && data.readUInt32LE(1) === 2) queueMicrotask(() => stale.handle(event(2, [1, 1], descriptors)))
  }, staleClipboard, () => {}, path.join(directory, 'stale-cache'))
  stale.handle(event(1, [1, 1, 17]))
  const preparing = stale.offerRemote()
  for (let tries = 0; !readyOffer && tries < 100; tries++) await delay(1)
  assert(readyOffer)
  stale.handle(event(1, [2, 0, 24]))
  readyOffer({ sequence: 23, dispose: () => revocations++, finished: new Promise(resolve => { finishOffer = resolve }) })
  await preparing
  assert.equal(revocations, 1, 'A helper becoming ready after a newer copy must be revoked')
  finishOffer(); stale.dispose()
  console.log('PASS cancelled clipboard offers cannot leak a native helper or replace a newer clipboard generation')
  let cancelled, consume, requested = 0, waitingForRead
  const big = Buffer.alloc(700_000, 37), largeDescriptors = encodeFileDescriptors([{ name: 'large.bin', directory: false, size: big.length }])
  const blocked = new Promise(resolve => { waitingForRead = resolve })
  const cancelledCache = path.join(directory, 'cancelled-cache')
  cancelled = new FreeRdpFiles(packet => {
    const data = Buffer.from(packet)
    if (data[0] !== 8) return
    const action = data.readUInt32LE(1)
    if (action === 2) queueMicrotask(() => cancelled.handle(event(2, [1, 1], largeDescriptors)))
    if (action === 3) {
      const stream = data.readUInt32LE(5), flags = data.readUInt32LE(13), offset = data.readUInt32LE(17), count = data.readUInt32LE(25)
      if (flags === 1) { const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(big.length)); queueMicrotask(() => cancelled.handle(event(4, [stream, 1], size))) }
      else if (++requested === 1) queueMicrotask(() => cancelled.handle(event(4, [stream, 1], big.subarray(offset, offset + count))))
      else waitingForRead()
    }
  }, { ...clipboard, offer: async (metadata, expected, read) => { consume = read; return { sequence: 23, dispose() {}, finished: new Promise(() => {}) } } }, () => {}, cancelledCache)
  cancelled.handle(event(1, [1, 1, 17])); await cancelled.offerRemote()
  const downloading = consume(0)
  await blocked
  cancelled.cancelDownload()
  await assert.rejects(downloading, /取消/)
  for (const entry of fs.readdirSync(cancelledCache)) assert.deepEqual(fs.readdirSync(path.join(cancelledCache, entry)), [], 'Cancelling a lazy paste removes its partially downloaded file')
  cancelled.dispose()
  console.log('PASS on-demand paste cancellation interrupts a pending RDP read and removes partial local file data')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
