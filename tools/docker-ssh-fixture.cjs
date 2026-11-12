/** Isolated SSH peer + fake Docker CLI. Never contacts or modifies a real daemon. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { spawn } = require('node:child_process'), { once } = require('node:events')
const { Server } = require('ssh2')
const containerId = 'a'.repeat(64), runningId = 'b'.repeat(64), imageId = 'sha256:' + 'c'.repeat(64)
const containers = [
  { ID: runningId, Names: 'web-production', Image: 'nginx:stable', State: 'running', Status: 'Up 3 days (healthy)', Ports: '0.0.0.0:8080->80/tcp, [::]:8080->80/tcp', CreatedAt: '2026-11-01 08:00:00 +0800 CST' },
  { ID: containerId, Names: 'worker-retired', Image: 'example/worker:2026', State: 'exited', Status: 'Exited (0) 2 hours ago', Ports: '', CreatedAt: '2026-11-02 08:00:00 +0800 CST' }
]
const images = [
  { ID: imageId, Repository: 'example/worker', Tag: '2026', Size: '231MB', CreatedAt: '2026-11-01 00:00:00 +0000 UTC' },
  { ID: imageId, Repository: 'example/worker', Tag: 'latest', Size: '231MB', CreatedAt: '2026-11-01 00:00:00 +0000 UTC' },
  { ID: 'sha256:' + 'd'.repeat(64), Repository: '<none>', Tag: '<none>', Size: '54.1MB', CreatedAt: '2026-11-02 00:00:00 +0000 UTC' }
]
const preamble = String.raw`
uname() { printf '%s\n' Linux; }
command() {
  if [ "$OMNI_QA_MODE" = missing ] && [ "$1" = -v ] && [ "$2" = docker ]; then return 1; fi
  builtin command "$@"
}
docker() {
  printf '%s\n' "$*" >> "$OMNI_QA_LOG"
  if [ "$1" = context ]; then
    if [ "$OMNI_QA_MODE" = context ]; then return 1; fi
    if [ "$OMNI_QA_MODE" = remote ]; then printf '%s\n' ssh://other-host; else printf '%s\n' "$OMNI_QA_ENDPOINT"; fi
    return
  fi
  if [ "$1" != --host ] || [ "$2" != "$OMNI_QA_ENDPOINT" ]; then printf '%s\n' 'Incorrect host' >&2; return 1; fi
  shift 2
  case "$1 $2" in
    'info --format')
      if [ "$OMNI_QA_MODE" = permission ]; then printf '%s\n' 'permission denied while trying to connect to the Docker daemon socket' >&2; return 1; fi
      if [ "$OMNI_QA_MODE" = daemon ]; then printf '%s\n' 'Cannot connect to the Docker daemon' >&2; return 1; fi
      if [ "$OMNI_QA_MODE" = changed ]; then id=changed-daemon; else id=fixture-daemon; fi
      if [ "$3" = '{{.ID}}' ]; then printf '%s\n' "$id"; else printf '{"id":"%s","version":"29.0.0-fixture"}\n' "$id"; fi
      ;;
    'container ls') cat "$OMNI_QA_DIRECTORY/containers.jsonl" ;;
    'image ls') cat "$OMNI_QA_DIRECTORY/images.jsonl" ;;
    'container rm'|'image rm')
      if [ "$OMNI_QA_MODE" = conflict ] || [ "$4" = "$OMNI_QA_RUNNING_ID" ]; then printf '%s\n' 'Error response from daemon: conflict: resource is in use' >&2; return 1; fi
      if [ "$3" != -- ] || [ -z "$4" ] || [ "$#" != 4 ]; then return 1; fi
      printf '%s\n' "$4"
      ;;
    *) printf '%s\n' 'Unsupported fake Docker command' >&2; return 1 ;;
  esac
}
`
const posix = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
function fixture(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const log = path.join(directory, 'commands.log')
  const children = new Set(), peers = new Set(), commands = [], writes = []
  let mode = 'ready', endpoint = 'unix:///var/run/docker.sock', delay = false, authentications = 0, shells = 0
  fs.writeFileSync(path.join(directory, 'containers.jsonl'), containers.map(row => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(path.join(directory, 'images.jsonl'), images.map(row => JSON.stringify(row)).join('\n') + '\n')
  async function execute(command, options = {}) {
    commands.push(command)
    if (delay) await new Promise(resolve => setTimeout(resolve, 350))
    const child = spawn(process.env.OMNIDESK_QA_BASH || 'C:/Program Files/Git/bin/bash.exe', ['--noprofile', '--norc', '-s'], {
      env: { ...process.env, OMNI_QA_MODE: mode, OMNI_QA_DIRECTORY: posix(directory), OMNI_QA_LOG: posix(log), OMNI_QA_ENDPOINT: endpoint, OMNI_QA_RUNNING_ID: runningId, DOCKER_CONTEXT: '', DOCKER_HOST: '', ...options.env }, windowsHide: true
    })
    children.add(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const start = Date.now()
    const timer = setTimeout(() => child.kill(), 20000)
    child.stdin.on('error', () => {})
    child.stdin.end(preamble + '\n' + command + '\n')
    try {
      const [code] = await once(child, 'close')
      if (code === 0) {
        const removed = command.match(/odocker (container|image) rm -- '([^']+)'/)
        if (removed) {
          const file = path.join(directory, removed[1] === 'container' ? 'containers.jsonl' : 'images.jsonl')
          const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.ID !== removed[2])
          fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
        }
      }
      return { stdout, stderr, code, durationMs: Date.now() - start, truncated: false }
    }
    finally { clearTimeout(timer); children.delete(child) }
  }
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey
  const server = new Server({ hostKeys: [key] }, client => {
    peers.add(client); client.on('close', () => peers.delete(client)); client.on('error', () => {})
    client.on('authentication', context => { if (context.username === 'qa' && context.method === 'password' && context.password === 'docker-qa-only') { authentications++; context.accept() } else context.reject() })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', accept => accept()); session.on('window-change', accept => accept?.())
      session.on('shell', accept => { shells++; const stream = accept(); stream.write('Docker QA shell\r\n$ '); stream.on('data', chunk => { writes.push(chunk.toString()); stream.write(chunk) }); stream.on('error', () => {}) })
      session.on('sftp', (_accept, reject) => reject())
      session.on('exec', (accept, _reject, info) => {
        const stream = accept(); stream.on('error', () => {})
        if (!info.command.includes('odocker()')) { stream.exit(1); stream.end(); return }
        execute(info.command).then(result => { if (stream.destroyed) return; stream.write(result.stdout); stream.stderr.write(result.stderr); stream.exit(result.code ?? 1); stream.end() }).catch(error => { if (!stream.destroyed) { stream.stderr.write(error.message); stream.exit(1); stream.end() } })
      })
    }))
  })
  return {
    execute, commands, writes, server,
    get authentications() { return authentications }, get shells() { return shells },
    get endpoint() { return endpoint },
    get log() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' },
    set mode(value) { mode = value }, set endpoint(value) { endpoint = value }, set delay(value) { delay = value },
    setContainers(rows) { fs.writeFileSync(path.join(directory, 'containers.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n') },
    async start() { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port },
    async close() { for (const peer of peers) { peer.end(); peer._sock.destroy() }; for (const child of children) child.kill(); if (server.address()) await new Promise(resolve => server.close(resolve)) }
  }
}
module.exports = { fixture, containers, images, containerId, runningId, imageId }
