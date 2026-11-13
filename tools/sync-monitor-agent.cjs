const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const server = path.resolve(root, '../omnidesk-server')
const check = process.argv.includes('--check')
const entries = []
for (const directory of ['cmd/agent', 'internal/agent', 'protocol']) {
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(server, 'monitor', relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) visit(name)
      else if (entry.name.endsWith('.go') && entry.name !== 'integration_test.go') entries.push([path.join(server, 'monitor', name), path.join(root, 'monitor-agent', name)])
    }
  }
  visit(directory)
}
entries.push([path.join(server, 'assets/monitor-agent/install-windows.ps1'), path.join(root, 'assets/monitor-agent/install-windows.ps1')])
let differences = 0
for (const [source, destination] of entries) {
  const bytes = fs.readFileSync(source)
  const equal = fs.existsSync(destination) && bytes.toString('utf8').replace(/\r\n/g, '\n') === fs.readFileSync(destination, 'utf8').replace(/\r\n/g, '\n')
  if (equal) continue
  differences++
  if (check) console.error('DIFF', path.relative(root, destination))
  else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes) }
}
if (check && differences) process.exitCode = 1
console.log(`${check ? 'Checked' : 'Synced'} ${entries.length} collector/template files; ${differences} differences. Review monitor-agent/go.mod and run go mod tidy after dependency changes.`)
