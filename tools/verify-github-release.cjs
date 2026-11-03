const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const configuration = require('../package.json')
const { version } = configuration
const repository = `${configuration.build.publish.owner}/${configuration.build.publish.repo}`
const tag = `v${version}`
const published = process.argv.includes('--published')
const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

async function main() {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(repository, 'jixn-hu/omnidesk-releases')
  assert.equal(api(`repos/${repository}`).private, false)
  for (const source of ['jixn-hu/omnidesk', 'jixn-hu/omnidesk-server']) assert.equal(api(`repos/${source}`).private, true, `${source} must remain private`)
  const sourceRepository = 'jixn-hu/omnidesk-source'
  assert.equal(api(`repos/${sourceRepository}`).private, false, 'Audited client source must be public')
  const sourcePackage = api(`repos/${sourceRepository}/contents/package.json?ref=${tag}`)
  const sourceConfiguration = JSON.parse(Buffer.from(sourcePackage.content, 'base64').toString('utf8'))
  assert.equal(sourceConfiguration.version, version)
  assert.equal(sourceConfiguration.license, 'MIT')
  const sourceLicense = api(`repos/${sourceRepository}/contents/LICENSE?ref=${tag}`)
  assert.match(Buffer.from(sourceLicense.content, 'base64').toString('utf8'), /MIT License/)
  const sourceTree = api(`repos/${sourceRepository}/git/trees/${tag}?recursive=1`)
  assert.equal(sourceTree.truncated, false)
  for (const entry of sourceTree.tree) assert(!/^(?:node_modules|tmp|out|release|official-data)\//.test(entry.path), entry.path)
  console.log('PASS public client source, version tag, MIT license and source file boundaries')
  const matches = api(`repos/${repository}/releases?per_page=100`).filter(entry => entry.tag_name === tag)
  assert.equal(matches.length, 1, 'Expected exactly one release for the current version, including authenticated drafts')
  const release = matches[0]
  assert.equal(release.draft, !published)
  assert.equal(release.prerelease, false)
  assert.match(release.target_commitish, /^[a-f0-9]{40}$/)
  const commit = api(`repos/${repository}/commits/${release.target_commitish}`)
  const tree = api(`repos/${repository}/git/trees/${commit.commit.tree.sha}?recursive=1`)
  assert.equal(tree.truncated, false)
  assert.deepEqual(tree.tree.map(entry => entry.path).sort(), ['README.md'], 'Installer repository must contain only the reviewed README')
  const directory = path.resolve(__dirname, '..', 'release', version, 'public')
  const installer = `OmniDesk-${version}-win-x64.exe`
  const artifacts = [installer, `${installer}.blockmap`, 'latest.yml'].sort()
  const expected = [...artifacts, 'SHA256SUMS.txt'].sort()
  assert.deepEqual(fs.readdirSync(directory).sort(), expected)
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), expected)
  const sums = artifacts.map(name => `${digest(fs.readFileSync(path.join(directory, name)))}  ${name}`).join('\n') + '\n'
  assert.equal(fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), sums)
  for (const asset of release.assets) {
    const bytes = fs.readFileSync(path.join(directory, asset.name))
    assert.equal(asset.state, 'uploaded', asset.name)
    assert.equal(asset.size, bytes.length, asset.name)
    assert.equal(asset.digest, `sha256:${digest(bytes)}`, asset.name)
    console.log('PASS remote size + SHA256 match:', asset.name)
  }
  if (published) {
    assert.equal(api(`repos/${repository}/commits/${tag}`).sha, commit.sha)
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OmniDesk-release-verification' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) })
    assert.equal(response.status, 200, 'Anonymous update check must work without a GitHub token')
    const latest = await response.json()
    assert.equal(latest.tag_name, tag)
    assert.equal(latest.draft, false)
    assert.equal(latest.prerelease, false)
    const download = release.assets.find(asset => asset.name === installer)
    const downloadStatus = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--disable', '--head', '--location', '--fail', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '10', '--max-time', '30', '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}', download.browser_download_url], { encoding: 'utf8' }).trim()
    assert.equal(downloadStatus, '200', 'Anonymous installer download must work')
    console.log('PASS anonymous latest release and installer download; tag belongs to the public README-only repository')
  }
  console.log(`PASS ${repository} ${tag}: ${published ? 'published' : 'draft'}; client source public; development history and account backend private; all four public assets verified`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
