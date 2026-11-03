const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const directory = fs.mkdtempSync(path.resolve('tmp/rdp-security-qa-'))
function bundle(source, name) {
  const outfile = path.join(directory, `${name}.cjs`)
  require('esbuild').buildSync({ entryPoints: [source], outfile, bundle: true, format: 'cjs', platform: 'node', packages: 'external', alias: { '@shared': path.resolve('src/shared') } })
  return require(outfile)
}
const { requiresLegacyRdp, RdpLegacyConsent } = bundle('src/main/services/rdp-security.ts', 'security')
const { FreeRdpService } = bundle('src/main/services/freerdp.ts', 'service')
const { sharedConfiguration } = bundle('src/shared/shared-configuration.ts', 'shared')
const { canProbeLegacyRdp } = bundle('src/shared/rdp-security.ts', 'eligibility')
const { friendlyRdpError } = bundle('src/renderer/src/features/desktop/rdp-errors.ts', 'errors')
const request = Buffer.from('030000130ee00000000000010008000b000000', 'hex')
async function until(predicate) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待合成协商请求超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
function failure(code) {
  const response = Buffer.from('030000130ed000001234000300080000000000', 'hex')
  response.writeUInt32LE(code, 15)
  return response
}
function selected(protocol) {
  const response = failure(protocol)
  response[11] = 2
  return response
}
async function withTarget(response, run) {
  const sockets = new Set()
  const requests = []
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let received = Buffer.alloc(0)
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      if (received.length < request.length) return
      requests.push(received)
      const reply = typeof response === 'function' ? response(requests.length) : response
      if (reply) { socket.write(reply.subarray(0, 3)); setImmediate(() => socket.end(reply.subarray(3))) }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { await run(server.address().port, requests) }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
}
async function main() {
  for (const code of ['ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED', 'ERRCONNECT_TLS_CONNECT_FAILED']) assert.equal(canProbeLegacyRdp(code), true)
  for (const code of ['ERRCONNECT_AUTHENTICATION_FAILED', 'ERRCONNECT_CONNECT_TRANSPORT_FAILED', 'ERRCONNECT_TLS_CONNECT_FAILED_OTHER', '已拒绝 RDP 服务器证书']) assert.equal(canProbeLegacyRdp(code), false)
  const tlsHint = friendlyRdpError('FreeRDP：TLS 握手失败，请检查证书、协议版本和服务器安全策略\nERRCONNECT_TLS_CONNECT_FAILED')
  assert.match(tlsHint, /仅凭此错误不能确定/)
  assert.doesNotMatch(tlsHint, /目标证书尚未受信任|身份验证被取消/)
  assert.match(friendlyRdpError('已拒绝 RDP 服务器证书'), /具体证书错误/)
  console.log('PASS TLS failures enter compatibility diagnostics without treating all TLS failures as certificate rejection or legacy-only servers')
  await withTarget(failure(3), async port => {
    await assert.rejects(requiresLegacyRdp('127.0.0.1', port, undefined, new AbortController().signal), /SSL_CERT_NOT_ON_SERVER/)
  })
  await withTarget(Buffer.from('0300000b00d00000123400', 'hex'), async port => {
    await assert.rejects(requiresLegacyRdp('127.0.0.1', port, undefined, new AbortController().signal), /X.224/)
  })
  for (const [response, expected] of [
    ...[1, 2, 3, 4, 5, 6, 7, 99].map(code => [failure(code), code === 2 ? true : 'error']),
    ...[0, 1, 2, 8, 4].map(protocol => [selected(protocol), protocol === 4 ? 'error' : protocol === 0]),
    [Buffer.from('0300000b06d00000123400', 'hex'), true],
    [Buffer.from('030000130ed000001234000300070002000000', 'hex'), 'error'],
    [Buffer.from('0300000b00d00000123400', 'hex'), 'error'],
    [Buffer.from('0300000c07d0000012340000', 'hex'), 'error']
  ]) {
    await withTarget(response, async (port, requests) => {
      const pending = requiresLegacyRdp('127.0.0.1', port, undefined, new AbortController().signal)
      if (expected === 'error') await assert.rejects(pending)
      else assert.equal(await pending, expected)
      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0], request)
    })
  }
  console.log('PASS exact legacy detection; all other negotiation failures, TLS/NLA and malformed packets cannot trigger downgrade; probe never sends login data')
  await withTarget(null, async (port, requests) => {
    const controller = new AbortController()
    const pending = requiresLegacyRdp('127.0.0.1', port, undefined, controller.signal)
    await until(() => requests.length > 0)
    controller.abort()
    assert.equal(await pending, false)
  })
  assert.equal(await requiresLegacyRdp('127.0.0.1', 1, undefined, AbortSignal.abort()), false)
  const proxySockets = new Set()
  let proxyAuthorization = ''
  const proxy = net.createServer(socket => {
    proxySockets.add(socket)
    socket.on('close', () => proxySockets.delete(socket))
    socket.on('error', () => {})
    let headers = Buffer.alloc(0)
    const authorize = chunk => {
      headers = Buffer.concat([headers, chunk])
      if (!headers.includes('\r\n\r\n')) return
      socket.off('data', authorize)
      proxyAuthorization = headers.toString()
      socket.on('data', data => { assert.deepEqual(data, request); socket.end(failure(2)) })
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
    }
    socket.on('data', authorize)
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    assert.equal(await requiresLegacyRdp('qa-target.invalid', 3389, { type: 'http', host: '127.0.0.1', port: proxy.address().port, username: 'qa-proxy', password: 'synthetic-proxy-only' }, new AbortController().signal), true)
    assert.match(proxyAuthorization, /^CONNECT qa-target.invalid:3389 HTTP\/1\.1/)
    assert(proxyAuthorization.includes(Buffer.from('qa-proxy:synthetic-proxy-only').toString('base64')))
  } finally { for (const socket of proxySockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)) }
  console.log('PASS fallback detection respects the configured authenticated HTTP proxy instead of bypassing it')
  let prompts = 0
  let accepted = true
  const confirm = async () => { prompts++; return accepted }
  const connection = { id: 'qa', kind: 'rdp', name: 'Synthetic only', host: '127.0.0.1', port: 3389, username: 'qa', createdAt: 1, updatedAt: 1, options: { engine: 'freerdp', securityMode: 'auto', ignoreCertificate: false } }
  const consent = new RdpLegacyConsent(directory, confirm)
  const owner = { id: 'synthetic-window' }
  let forwardedOwner
  const ownedConsent = new RdpLegacyConsent(directory, async (_connection, _automatic, _signal, window) => { forwardedOwner = window; return false })
  assert.equal(await ownedConsent.authorize(connection, new AbortController().signal, true, owner), false)
  assert.equal(forwardedOwner, owner)
  assert.equal(await consent.authorize(connection, new AbortController().signal), true)
  assert.equal(await new RdpLegacyConsent(directory, confirm).authorize(connection, new AbortController().signal), true)
  assert.equal(prompts, 1)
  assert.equal(await consent.authorize({ ...connection, host: '127.0.0.2' }, new AbortController().signal), true)
  assert.equal(prompts, 2)
  assert.equal(await consent.authorize(connection, new AbortController().signal, true), true)
  assert.equal(prompts, 3)
  accepted = false
  assert.equal(await consent.authorize(connection, new AbortController().signal, true), false)
  assert.equal(await consent.authorize({ ...connection, username: 'different' }, new AbortController().signal), false)
  assert.equal(await consent.authorize(connection, AbortSignal.abort()), false)
  const other = fs.mkdtempSync(path.join(directory, 'other-profile-'))
  assert.equal(await new RdpLegacyConsent(other, confirm).authorize({ ...sharedConfiguration(connection), id: connection.id }, new AbortController().signal), false)
  assert.equal(fs.existsSync(path.join(other, 'rdp-legacy-consent.json')), false)
  const unwritable = fs.mkdtempSync(path.join(directory, 'blocked-write-'))
  fs.mkdirSync(path.join(unwritable, 'rdp-legacy-consent.json.tmp'))
  await assert.rejects(new RdpLegacyConsent(unwritable, async () => true).authorize(connection, new AbortController().signal))
  assert.equal(fs.existsSync(path.join(unwritable, 'rdp-legacy-consent.json')), false)
  console.log('PASS local consent persists across restart, is scoped to endpoint/account, prompts again for automatic mode, and is not inherited from shared/imported configurations')
  const service = new FreeRdpService(directory, {})
  try {
    await withTarget(failure(2), async (port, requests) => {
      const record = { ...connection, port }
      const session = { sessionId: 'qa-session', connectionFingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex'), host: record.host, port, options: record.options, controller: new AbortController(), fallbackEligible: true }
      service.sessions.set(session.sessionId, session)
      let confirmations = 0
      const approve = async () => { confirmations++; return true }
      assert.equal(await service.requestLegacyRetry('invalid', record, approve), 'unavailable')
      assert.equal(await service.requestLegacyRetry(session.sessionId, { ...record, updatedAt: 2 }, approve), 'unavailable')
      session.established = true
      assert.equal(await service.requestLegacyRetry(session.sessionId, record, approve), 'unavailable')
      session.established = false
      session.fallbackEligible = false
      assert.equal(await service.requestLegacyRetry(session.sessionId, record, approve), 'unavailable')
      assert.equal(requests.length, 0)
      session.fallbackEligible = true
      assert.equal(await service.requestLegacyRetry(session.sessionId, record, approve), 'accepted')
      assert.equal(await service.requestLegacyRetry(session.sessionId, record, approve), 'unavailable')
      assert.equal(confirmations, 1)
      service.release(session.sessionId)
    })
    await withTarget(null, async (port, requests) => {
      const record = { ...connection, port }
      const session = { sessionId: 'cancelled', connectionFingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex'), host: record.host, port, options: record.options, controller: new AbortController(), fallbackEligible: true }
      service.sessions.set(session.sessionId, session)
      const pending = service.requestLegacyRetry(session.sessionId, record, async () => { throw new Error('must not prompt after closing') })
      await until(() => requests.length > 0)
      assert.equal(await service.requestLegacyRetry(session.sessionId, record, async () => { throw new Error('must not start concurrent probe') }), 'unavailable')
      assert.equal(requests.length, 1)
      service.release(session.sessionId)
      assert.equal(await pending, 'unavailable')
    })
    await withTarget(failure(2), async port => {
      const record = { ...connection, port }
      const session = { sessionId: 'cancel-prompt', connectionFingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex'), host: record.host, port, options: record.options, controller: new AbortController(), fallbackEligible: true }
      service.sessions.set(session.sessionId, session)
      let prompting = false
      const pending = service.requestLegacyRetry(session.sessionId, record, signal => new Promise(resolve => { prompting = true; signal.addEventListener('abort', () => resolve(false), { once: true }) }))
      await until(() => prompting)
      service.release(session.sessionId)
      assert.equal(await pending, 'unavailable')
    })
    for (const [response, expected] of [[selected(1), 'not-required'], [failure(2), 'declined']]) {
      await withTarget(response, async port => {
        const record = { ...connection, port }
        const session = { sessionId: 'diagnosis', connectionFingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex'), host: record.host, port, options: record.options, controller: new AbortController(), fallbackEligible: true }
        service.sessions.set(session.sessionId, session)
        let confirmations = 0
        assert.equal(await service.requestLegacyRetry(session.sessionId, record, async () => { confirmations++; return false }), expected)
        assert.equal(confirmations, expected === 'declined' ? 1 : 0)
        service.release(session.sessionId)
      })
    }
    await withTarget(attempt => attempt === 1 ? Buffer.from('0300000b00d00000123400', 'hex') : failure(2), async (port, requests) => {
      const record = { ...connection, port }
      const session = { sessionId: 'retry-probe', connectionFingerprint: createHash('sha256').update(JSON.stringify(record)).digest('hex'), host: record.host, port, options: record.options, controller: new AbortController(), fallbackEligible: true }
      service.sessions.set(session.sessionId, session)
      let confirmations = 0
      const approve = async () => { confirmations++; return true }
      await assert.rejects(service.requestLegacyRetry(session.sessionId, record, approve), /X.224/)
      assert.equal(confirmations, 0)
      assert.equal(session.fallbackRequested, undefined)
      assert.equal(await service.requestLegacyRetry(session.sessionId, record, approve), 'accepted')
      assert.equal(confirmations, 1)
      assert.equal(requests.length, 2)
      service.release(session.sessionId)
    })
  } finally { await service.dispose() }
  console.log('PASS session binding, modified configuration rejection, no runtime downgrade, no retry loops, and tab-close cancellation')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
