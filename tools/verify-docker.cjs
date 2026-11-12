const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const esbuild = require('esbuild')
const { fixture, containerId, runningId, imageId } = require('./docker-ssh-fixture.cjs')
const root = path.resolve(__dirname, '..')
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
const directory = fs.mkdtempSync(path.join(root, 'tmp/docker-service-'))
function load(file) {
  const result = esbuild.buildSync({ entryPoints: [path.join(root, file)], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
  const mod = new Module(path.join(root, file), module); mod.paths = module.paths; mod._compile(result.outputFiles[0].text, file); return mod.exports
}
const { DockerService } = load('src/main/services/docker.ts'), { SshService } = load('src/main/services/ssh.ts')
const peer = fixture(directory)
let ssh
async function main() {
  const port = await peer.start()
  ssh = new SshService(() => ({ secret: 'docker-qa-only' }), () => ({}), () => {})
  ssh.on('hostKeyPrompt', prompt => ssh.resolveHostKey(prompt.sessionId, { accept: true, remember: false }))
  const info = await ssh.connect({ id: 'docker-qa', name: 'Docker QA', kind: 'ssh', host: '127.0.0.1', port, username: 'qa', authMethod: 'password', credentialRef: 'docker-qa' })
  const docker = new DockerService(ssh)
  const read = () => docker.snapshot(info.id)
  const snapshot = await read()
  assert.equal(snapshot.available, true); assert.equal(snapshot.containers.length, 2); assert.equal(snapshot.images.length, 2)
  assert.deepEqual(snapshot.images[0].tags, ['example/worker:2026', 'example/worker:latest'])
  assert.deepEqual(snapshot.images[1].tags, []); assert.equal(snapshot.containers[0].state, 'running')
  assert.equal(snapshot.endpoint, 'unix:///var/run/docker.sock')
  const request = { kind: 'container', id: containerId, endpoint: snapshot.endpoint, daemonId: snapshot.daemonId }
  await docker.remove(info.id, request)
  assert.match(peer.log, new RegExp('container rm -- ' + containerId))
  await docker.remove(info.id, { ...request, kind: 'image', id: imageId })
  await assert.rejects(docker.remove(info.id, { ...request, id: runningId }), /conflict.*in use/)
  for (const [mode, reason] of [['missing','not-installed'],['context','context'],['remote','remote-context'],['permission','permission'],['daemon','daemon']]) {
    peer.mode = mode
    const result = await read(); assert.equal(result.available, false); assert.equal(result.reason, reason)
    assert.equal(result.containers.length, 0)
  }
  peer.mode = 'changed'; const before = peer.log
  await assert.rejects(docker.remove(info.id, request), /服务已变化/)
  assert(!peer.log.slice(before.length).includes(' rm '))
  peer.mode = 'ready'; peer.endpoint = "unix:///run/user/1000/docker'quoted.sock"
  const rootless = await read(); assert.equal(rootless.endpoint, peer.endpoint)
  await docker.remove(info.id, { ...request, endpoint: rootless.endpoint })
  const count = peer.commands.length
  for (const invalid of [{...request,id:containerId+'; touch /tmp/evil'}, {...request,id:'--all'}, {...request,kind:'volume'}, {...request,endpoint:'tcp://other'}, {...request,daemonId:'$(id)'}, null]) {
    await assert.rejects(docker.remove(info.id, invalid), /删除目标无效/)
  }
  assert.equal(peer.commands.length, count)
  const envService = new DockerService({ exec: (_id, command) => peer.execute(command, { env: { DOCKER_CONTEXT:'rootless', DOCKER_HOST:'tcp://should-not-be-used' } }) })
  assert.equal((await envService.snapshot('env')).available, true)
  peer.delay = true
  const first = docker.remove(info.id, { ...request, endpoint: rootless.endpoint })
  await assert.rejects(docker.remove(info.id, { ...request, endpoint: rootless.endpoint }), /重复提交/)
  await first; peer.delay = false
  const truncated = new DockerService({ exec: async () => ({stdout:'',stderr:'',code:0,durationMs:0,truncated:true}) })
  await assert.rejects(truncated.snapshot('qa'), /超过读取上限/)
  const bad = new DockerService({ exec: async () => ({stdout:'garbage',stderr:'',code:0,durationMs:0,truncated:false}) })
  await assert.rejects(bad.snapshot('qa'), /无法解析/)
  const timed = new DockerService({ exec: async () => { throw new Error('命令执行超时') } })
  await assert.rejects(timed.snapshot('qa'), /超时/)
  peer.setContainers([{ ID:'invalid', Names:'bad' }])
  await assert.rejects(read(), /无法解析/)
  assert.equal(peer.authentications, 1, 'reuse existing authenticated session')
  assert(peer.commands.every(command => !/sudo| rm -(?:f|v)|prune|container stop/.test(command)))
  ssh.disconnect(info.id); await assert.rejects(read(), /会话|连接/)
  console.log('PASS Docker service: actual SSH and shell, JSON lists, rootless/context precedence, missing/permission/daemon/remote failures, exact IDs, quoting, non-force conflicts, daemon changes, duplicate deletion, malformed/truncated/timeouts, disconnected session')
  fs.writeFileSync(path.join(directory,'result.json'), JSON.stringify({ok:true, commands:peer.commands.length, authentications:peer.authentications},null,2))
  console.log('Artifacts: ' + directory)
}
main().catch(error => { console.error(error); process.exitCode=1 }).finally(async () => { ssh?.dispose(); await peer.close() })
