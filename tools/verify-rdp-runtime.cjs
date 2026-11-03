const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const packagePath = require.resolve('tabby-rdp/package.json')
const dependency = JSON.parse(readFileSync(packagePath, 'utf8'))
if (dependency.version !== '0.5.6') throw new Error('RDP runtime version changed; revalidate the decoder and update its checksums')

const expected = {
  'ironrdp-factory.js': 'b297c0a5d8f4cf0b07b59a0e6630d6c4228622404a9b00157b89021d20c4cd4e',
  'ironrdp_web_bg.wasm': '173ff598bb50290ec7027fbd3eeb1d4f58c03e9372bbb9f1066b8997f587fbc8'
}

for (const [filename, checksum] of Object.entries(expected)) {
  const actual = createHash('sha256').update(readFileSync(join(dirname(packagePath), 'vendor', filename))).digest('hex')
  if (actual !== checksum) throw new Error(`RDP runtime checksum mismatch: ${filename}`)
}
console.log('Verified pinned IronRDP JavaScript/WASM runtime (tabby-rdp 0.5.6)')
