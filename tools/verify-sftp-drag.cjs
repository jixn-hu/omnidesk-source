const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(root, 'tmp/sftp-drag-service-'))
const remote = path.join(directory, 'remote'), local = path.join(directory, 'local')
fs.mkdirSync(remote); fs.mkdirSync(local)
const output = path.join(directory, 'sftp.cjs')
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/services/sftp.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@shared': path.join(root, 'src/shared') } })
const { SftpService } = require(output)
const target = name => { const resolved = path.resolve(remote, '.' + name); assert(resolved === remote || resolved.startsWith(remote + path.sep)); return resolved }
const callback = (done, action) => { try { done(null, action()) } catch (error) { if (error.code === 'ENOENT') error.code = 2; done(error) } }
let race
const sftp = {
  lstat: (name, done) => callback(done, () => fs.lstatSync(target(name))),
  mkdir: (name, done) => callback(done, () => fs.mkdirSync(target(name))),
  rename: (from, to, done) => callback(done, () => fs.renameSync(target(from), target(to))),
  createWriteStream: (name, options) => { assert.equal(options.flags, 'wx'); if (race === name) fs.writeFileSync(target(name), 'created concurrently'); return fs.createWriteStream(target(name), options) }
}
async function main() {
  const service = new SftpService({})
  service.getSftp = async () => sftp
  const folder = path.join(local, '中文目录'), subfolder = path.join(folder, '嵌套')
  fs.mkdirSync(subfolder, { recursive: true }); fs.mkdirSync(path.join(folder, '空目录'))
  const content = Buffer.from('nested upload 中文\n')
  fs.writeFileSync(path.join(subfolder, '内容.txt'), content); fs.writeFileSync(path.join(folder, 'empty.txt'), '')
  await service.uploadDropped('synthetic', [folder], '/')
  assert.deepEqual(fs.readFileSync(path.join(remote, '中文目录/嵌套/内容.txt')), content)
  assert.equal(fs.statSync(path.join(remote, '中文目录/empty.txt')).size, 0)
  assert(fs.statSync(path.join(remote, '中文目录/空目录')).isDirectory())
  await assert.rejects(service.uploadDropped('synthetic', [folder], '/'), /同名/)
  assert.deepEqual(fs.readFileSync(path.join(remote, '中文目录/嵌套/内容.txt')), content)
  const batch = path.join(local, 'batch'); fs.mkdirSync(batch)
  fs.writeFileSync(path.join(batch, 'a-new.txt'), 'new'); fs.writeFileSync(path.join(batch, 'z-existing.txt'), 'local')
  fs.mkdirSync(path.join(remote, 'batch')); fs.writeFileSync(path.join(remote, 'batch/z-existing.txt'), 'keep existing')
  await assert.rejects(service.uploadDropped('synthetic', [batch], '/'), /同名/)
  assert(!fs.existsSync(path.join(remote, 'batch/a-new.txt')), 'All target collisions must be detected before the first file upload')
  const racing = path.join(local, 'race.txt'); fs.writeFileSync(racing, 'local'); race = '/race.txt'
  await assert.rejects(service.uploadDropped('synthetic', [racing], '/'), /exist/i)
  assert.equal(fs.readFileSync(path.join(remote, 'race.txt'), 'utf8'), 'created concurrently')
  const linked = path.join(local, 'linked'); fs.symlinkSync(folder, linked, 'junction')
  await assert.rejects(service.uploadDropped('synthetic', [linked], '/'), /链接/)
  assert(!fs.existsSync(path.join(remote, 'linked')))
  await assert.rejects(service.move('synthetic', '/中文目录', '/中文目录/嵌套'), /自身或子目录/)
  service.dispose()
  console.log('PASS recursive Unicode folder upload with empty directories/files, all-target collision preflight, atomic exclusive file creation under a concurrent writer, local junction rejection and self-descendant move protection')
  console.log('QA_DIRECTORY=' + directory)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
