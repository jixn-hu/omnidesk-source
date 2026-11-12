const assert = require('node:assert/strict')
const path = require('node:path'), Module = require('node:module')
const source = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/src/features/monitor/monitor-batch-install.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const mod = new Module(__filename, module); mod._compile(source, __filename)
const { runMonitorBatch } = mod.exports
const ok = data => ({ ok: true, data })
const target = (id, kind = 'ssh') => ({ id, kind, name: id, host: 'fixture.invalid', port: kind === 'ssh' ? 22 : 3389, username: 'qa' })
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve } }
const tick = () => new Promise(done => setImmediate(done))
function fixture(overrides = {}) {
  const rows = new Map(), calls = { prepared: [], installed: [], commands: [], configured: 0, rotated: 0 }
  let current = true, starting = true
  const api = {
    local: async () => ok({ config: { enabled: false } }),
    configure: async () => { calls.configured++; return ok({}) },
    prepareAgentNode: async id => { calls.prepared.push(id); return ok({ id: 'node-' + id }) },
    agentInstallInfo: async () => ok({ hasToken: true }),
    rotateToken: async () => { calls.rotated++; throw Error('Must not rotate implicitly') },
    installAgent: async input => { calls.installed.push(input); return ok({ active: true, reported: true, message: 'reported' }) },
    windowsInstallCommand: async input => { calls.commands.push(input); return ok({ command: 'synthetic command for ' + input.connectionId, serverUrl: 'https://fixture.invalid:9020/v1/monitor', installationId: input.nodeId, expiresAt: Date.now() + 900000 }) },
    ...overrides
  }
  const options = { api, installMode: 'auto', isCurrent: () => current, shouldStart: () => starting, update: (id, patch) => rows.set(id, { ...rows.get(id), ...patch }) }
  return { api, options, rows, calls, expire: () => { current = false }, stop: () => { starting = false } }
}
async function main() {
  {
    const f = fixture(); const targets = [target('linux'), target('windows', 'rdp')]
    await runMonitorBatch(targets, f.options)
    assert.equal(f.calls.configured, 1)
    assert.equal(f.rows.get('linux').status, 'reported')
    assert.equal(f.rows.get('windows').status, 'command', 'Generating a Windows command is not successful installation')
    assert.equal(f.rows.get('windows').command.serverUrl, 'https://fixture.invalid:9020/v1/monitor')
    assert(f.rows.get('windows').watchUntil > Date.now())
    assert.deepEqual(f.calls.installed.map(x => x.connectionId), ['linux'])
    assert.equal(f.calls.rotated, 0)
  }
  {
    const gates = [], f = fixture(); let active = 0, maximum = 0
    f.api.installAgent = async input => {
      active++; maximum = Math.max(maximum, active); f.calls.installed.push(input)
      const gate = deferred(); gates.push(gate); await gate.promise; active--
      return input.connectionId === '1' ? { ok: false, message: 'Synthetic SSH failure' } : ok({ active: true, reported: true, message: 'reported' })
    }
    const run = runMonitorBatch(Array.from({ length: 8 }, (_, i) => target(String(i))), f.options)
    await tick(); assert.equal(gates.length, 3, 'Only three machines may be in progress')
    while (f.calls.installed.length < 8) { for (const gate of [...gates]) gate.resolve(); await tick() }
    for (const gate of gates) gate.resolve()
    await run; assert.equal(maximum, 3); assert.equal(f.rows.get('1').status, 'failed')
    assert.equal([...f.rows.values()].filter(row => row.status === 'reported').length, 7, 'One machine failing must not stop the other machines')
  }
  {
    const gates = [], f = fixture()
    f.api.installAgent = async input => { f.calls.installed.push(input); const gate = deferred(); gates.push(gate); await gate.promise; return ok({ active: true, reported: true, message: 'reported' }) }
    const run = runMonitorBatch(Array.from({ length: 7 }, (_, i) => target(String(i))), f.options)
    await tick(); assert.equal(f.calls.installed.length, 3); f.stop()
    for (const gate of gates) gate.resolve()
    await run; assert.equal(f.calls.installed.length, 3)
    assert.equal([...f.rows.values()].filter(row => row.status === 'cancelled').length, 4)
    assert.equal([...f.rows.values()].filter(row => row.status === 'reported').length, 3, 'Stopping the queue allows running installations to finish')
  }
  {
    const gate = deferred(), f = fixture({ agentInstallInfo: async () => { await gate.promise; return ok({ hasToken: true }) } })
    const run = runMonitorBatch([target('scope-a'), target('scope-b')], f.options)
    await tick(); f.expire(); gate.resolve(); await run
    assert.equal(f.calls.installed.length, 0, 'An account switch after node preparation must prevent installation with the new account')
    assert(![...f.rows.values()].some(row => row.status === 'reported'))
  }
  {
    const f = fixture({ agentInstallInfo: async () => ok({ hasToken: false }) })
    await runMonitorBatch([target('missing-token')], f.options)
    assert.equal(f.rows.get('missing-token').status, 'attention'); assert.equal(f.calls.installed.length, 0); assert.equal(f.calls.rotated, 0)
  }
  {
    const f = fixture({ installAgent: async () => ok({ active: false, reported: false, needsSudoPassword: true, message: 'Enter sudo password' }) })
    await runMonitorBatch([target('sudo')], f.options)
    assert.equal(f.rows.get('sudo').status, 'attention'); assert.equal(f.calls.rotated, 0)
  }
  {
    const f = fixture({ installAgent: async () => ok({ active: true, reported: false, message: 'Waiting for report' }) })
    await runMonitorBatch([target('started')], f.options)
    assert.equal(f.rows.get('started').status, 'started', 'An active service without a matching report is not reported')
  }
  {
    const f = fixture({ configure: async () => ({ ok: false, message: 'Cannot enable this account' }) })
    await runMonitorBatch([target('a'), target('b')], f.options)
    assert.equal(f.calls.prepared.length, 0); assert.equal(f.rows.get('a').status, 'failed'); assert.equal(f.rows.get('b').message, 'Cannot enable this account')
  }
  {
    const f = fixture(); f.options.installMode = 'user'
    await runMonitorBatch([target('a'), target('a')], f.options)
    assert.equal(f.calls.prepared.length, 1); assert.equal(f.calls.installed[0].installMode, 'user')
    assert.equal(f.calls.installed[0].renewToken, undefined)
  }
  console.log('Batch installation: bounded concurrency, isolated failures, stop queue, account changes, missing tokens, sudo challenges, manual Windows commands and install modes passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
