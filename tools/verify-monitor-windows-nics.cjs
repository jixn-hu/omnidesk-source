const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const cp = require('node:child_process')
const assert = require('node:assert/strict')

async function main() {
  if (process.platform !== 'win32') throw Error('This check requires Windows')
  const binary = process.env.OMNIDESK_AGENT_TEST_BINARY || path.resolve(__dirname, '../out/monitor-agent/omnidesk-monitor-agent-windows-amd64.exe')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-windows-nics-'))
  const statePath = path.join(temporary, 'state.json')
  const epoch = 'synthetic-network-unavailable-epoch'
  fs.writeFileSync(statePath, JSON.stringify({ epoch, sequence: 1, boot: 1, upload: 123, download: 456, previous: { 'saved-adapter': { up: 100, down: 200 } }, queue: [] }))
  let child, timer, output = '', server
  try {
    let resolveReport, rejectReport
    const report = new Promise((resolve, reject) => { resolveReport = resolve; rejectReport = reject })
    server = http.createServer((request, response) => {
      let text = ''
      request.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) request.destroy() })
      request.on('end', () => {
        try {
          assert.equal(request.url, '/v1/monitor/reports')
          assert.equal(request.headers.authorization, 'Bearer synthetic-network-unavailable-node-token')
          const body = JSON.parse(text), metrics = body.metrics
          assert(body.incomplete, 'Missing counters must mark traffic incomplete')
          assert.equal(body.upload, 123, 'Existing upload must be preserved')
          assert.equal(body.download, 456, 'Existing download must be preserved')
          assert(metrics.unavailable.includes('network'))
          assert.equal(metrics.network.length, 0)
          assert(metrics.cpu.cores > 0 && metrics.memory.total > 0 && metrics.disks.length > 0)
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ ack: body.sequence }))
          resolveReport()
        } catch (error) { response.statusCode = 500; response.end('{}'); rejectReport(error) }
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const config = path.join(temporary, 'agent.json')
    fs.writeFileSync(config, JSON.stringify({ serverUrl: 'http://127.0.0.1:' + server.address().port + '/v1/monitor', token: 'synthetic-network-unavailable-node-token', statePath, intervalSeconds: 5, disableDiscovery: true, includeNics: ['__omnidesk_no_such_adapter__*'] }))
    child = cp.spawn(binary, ['-config', config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', rejectReport)
    child.on('exit', code => rejectReport(Error('Agent exited before report: ' + code + ' ' + output.trim())))
    timer = setTimeout(() => rejectReport(Error('Timed out waiting for report')), 20000)
    await report
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(state.epoch, epoch)
    assert.equal(state.previous['saved-adapter'].up, 100)
    console.log('PASS: actual Windows Agent reports CPU/memory/disk without a matched NIC and preserves cumulative traffic and the last valid baseline')
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) { await new Promise(resolve => { child.once('exit', resolve); child.kill() }) }
    if (server) await new Promise(resolve => server.close(resolve))
    const resolved = fs.realpathSync(temporary)
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
    assert(path.basename(resolved).startsWith('omnidesk-windows-nics-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
