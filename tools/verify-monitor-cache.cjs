const assert = require('node:assert/strict'), path = require('node:path'), Module = require('node:module')
const root = path.resolve(__dirname, '..')
const source = require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/renderer/src/features/monitor/monitor-cache.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const events = new EventTarget(); let url = 'https://one.example.test', enabled = true, calls = 0, wait, failure = false
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve } }
global.window = { addEventListener: (...args) => events.addEventListener(...args), omnidesk: { monitoring: {
 local: async () => ({ ok: true, data: { config: { enabled, url }, entries: [] } }),
 nodes: async () => { calls++; const currentURL = url; const currentWait = wait; if (currentWait) await currentWait.promise; return failure ? { ok: false, message: 'Synthetic failure' } : { ok: true, data: [{ id: currentURL, name: currentURL }] } },
 alerts: async () => ({ ok: true, data: [] })
} } }
const mod = new Module(__filename, module); mod._compile(source, __filename)
const { cachedMonitorSnapshot: cached, refreshMonitorSnapshot: refresh } = mod.exports
async function main() {
 assert.equal(cached(), undefined)
 wait = deferred(); const first = refresh(), second = refresh()
 await Promise.resolve(); assert.equal(calls, 1, 'overlapping mounts must share a request')
 wait.resolve(); await Promise.all([first, second]); wait = null
 assert.equal(cached().nodes[0].id, url)
 const copy = cached(); copy.nodes[0].name = 'must-not-mutate-cache'; assert.equal(cached().nodes[0].name, url)
 failure = true; assert.match((await refresh()).error, /Synthetic failure/); assert.equal(cached().nodes[0].id, url)
 failure = false; wait = deferred(); const obsolete = refresh(); const obsoleteCheck = assert.rejects(obsolete, /配置已变更/)
 await Promise.resolve()
 events.dispatchEvent(new Event('omnidesk:monitoring-changed')); assert.equal(cached(), undefined)
 url = 'https://two.example.test'; const prior = wait; wait = null
 await refresh(); assert.equal(cached().nodes[0].id, url)
 prior.resolve(); await obsoleteCheck; assert.equal(cached().nodes[0].id, url, 'old request must never overwrite new endpoint data')
 events.dispatchEvent(new Event('omnidesk:monitor-nodes-changed')); assert.equal(cached(), undefined)
 await refresh(); assert.equal(cached().nodes[0].id, url)
 enabled = false; const disabled = await refresh(); assert.deepEqual(disabled.nodes, []); assert.equal(cached(), undefined)
 enabled = true; await refresh(); url = 'https://three.example.test'; failure = true
 assert.match((await refresh()).error, /Synthetic failure/); assert.equal(cached(), undefined, 'a failed endpoint switch must not retain another service cache')
 console.log('PASS: synchronous warm cache, deep-copy isolation, shared in-flight requests, retained successful data on failure, config/mutation invalidation, stale response rejection and disabled/endpoint boundaries')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
