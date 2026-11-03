const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
fs.mkdirSync(path.resolve('tmp'), { recursive: true })
const net = require('node:net')
const { once } = require('node:events')
const directory = fs.mkdtempSync(path.resolve('tmp/negotiation-qa-'))
require('esbuild').buildSync({ entryPoints: ['src/main/services/rdp-protocol.ts'], outfile: path.join(directory, 'protocol.cjs'), bundle: true, format: 'cjs', platform: 'node', packages: 'external' })
const { exchangeX224 } = require(path.join(directory, 'protocol.cjs'))
const request = Buffer.from('030000130ee000000000000100080003000000', 'hex')
async function scenario(response, expected) {
  let requests = Buffer.alloc(0)
  const connections = new Set()
  const server = net.createServer(socket => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => {})
    socket.on('data', chunk => {
      requests = Buffer.concat([requests, chunk])
      socket.write(response.subarray(0, 3))
      setImmediate(() => { if (!socket.destroyed) socket.write(response.subarray(3)) })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const socket = net.connect(server.address().port, '127.0.0.1')
  await once(socket, 'connect')
  try {
    if (expected instanceof RegExp) await assert.rejects(exchangeX224(socket, request), expected)
    else assert.deepEqual(await exchangeX224(socket, request), response)
    assert.deepEqual(requests, request)
  } finally {
    socket.destroy()
    for (const connection of connections) connection.destroy()
    await new Promise(done => server.close(done))
  }
}
async function main() {
  for (const [code, name] of [[1, 'SSL_REQUIRED_BY_SERVER'], [2, 'SSL_NOT_ALLOWED_BY_SERVER'], [3, 'SSL_CERT_NOT_ON_SERVER'], [4, 'INCONSISTENT_FLAGS'], [5, 'HYBRID_REQUIRED_BY_SERVER']]) {
    const response = Buffer.from('030000130ed000001234000300080000000000', 'hex')
    response.writeUInt32LE(code, 15)
    await scenario(response, new RegExp(name))
  }
  await scenario(Buffer.from('030000130ed000001234000200080000000000', 'hex'), /STANDARD_RDP_SECURITY/)
  await scenario(Buffer.from('0300000b06d00000123400', 'hex'), /STANDARD_RDP_SECURITY/)
  for (const protocol of [1, 2, 8]) {
    const response = Buffer.from('030000130ed000001234000200080000000000', 'hex')
    response.writeUInt32LE(protocol, 15)
    await scenario(response, true)
  }
  console.log('PASS fragmented X.224 negotiation, specific code-2 legacy-security guidance, missing-server-cert vs client trust, TLS/NLA acceptance, legacy refusal with no fallback retry or credential traffic')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
