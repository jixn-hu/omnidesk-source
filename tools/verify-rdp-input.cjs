const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const esbuild = require('esbuild')
const { _electron } = require('playwright')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-input-qa-'))
esbuild.buildSync({ entryPoints: ['src/renderer/src/features/desktop/input.ts'], outfile: path.join(directory, 'input.cjs'), bundle: true, platform: 'node' })
const { shouldUseUnicode, mouseButtonFor, scancodeFor } = require(path.join(directory, 'input.cjs'))
const event = (key, code, extra = {}) => ({ key, code, ctrlKey: false, altKey: false, metaKey: false, ...extra })
for (const [key, code] of [['a', 'KeyA'], ['N', 'KeyN'], ['1', 'Digit1'], ['!', 'Digit1'], [' ', 'Space'], ['.', 'Period']]) assert.equal(shouldUseUnicode(event(key, code)), false)
for (const [key, code] of [['中', 'KeyA'], ['é', 'KeyE'], ['🙂', ''], ['€', '']]) assert.equal(shouldUseUnicode(event(key, code)), true)
for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) assert.equal(shouldUseUnicode(event('é', 'KeyE', extra)), false)
assert.equal(shouldUseUnicode(event('Process', 'KeyN')), false)
console.log('PASS ASCII physical keys use scancodes for remote IME; committed Unicode and supplementary characters remain text')
for (let button = 0; button < 5; button++) assert.equal(mouseButtonFor(button), button, 'All five standard mouse buttons must be forwarded')
for (const button of [-1, 5, 8, 1.5, NaN]) assert.equal(mouseButtonFor(button), null)
assert.equal(scancodeFor('BrowserBack'), 0xe06a)
assert.equal(scancodeFor('BrowserForward'), 0xe069)
assert.equal(scancodeFor('PrintScreen'), 0xe037)

const source = ts.createSourceFile('DesktopView.tsx', fs.readFileSync('src/renderer/src/features/desktop/DesktopView.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let implementation
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'attachInput') implementation = node.initializer.getText(source)
  ts.forEachChild(node, visit)
}
visit(source)
assert(implementation)
const attachScript = ts.transpileModule('const attachInput = ' + implementation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const inputScript = esbuild.buildSync({ entryPoints: ['src/renderer/src/features/desktop/input.ts'], bundle: true, format: 'iife', globalName: 'rdpInput', write: false }).outputFiles[0].text
const clipboardScript = esbuild.buildSync({ entryPoints: ['src/renderer/src/features/desktop/rdp-clipboard.ts'], bundle: true, format: 'iife', globalName: 'rdpClipboard', write: false }).outputFiles[0].text
let application

async function main() {
  const factorySource = fs.readFileSync('node_modules/tabby-rdp/vendor/ironrdp-factory.js', 'utf8')
  const factory = await import('data:text/javascript;base64,' + Buffer.from(factorySource).toString('base64'))
  const module = await WebAssembly.compile(fs.readFileSync('node_modules/tabby-rdp/vendor/ironrdp_web_bg.wasm'))
  const runtime = await factory.createBackend(module, 'ERROR')
  try {
    const transaction = new runtime.Backend.InputTransaction()
    try {
      for (const character of '中文é🙂𠀀') {
        transaction.addEvent(runtime.Backend.DeviceEvent.unicodePressed(character))
        transaction.addEvent(runtime.Backend.DeviceEvent.unicodeReleased(character))
      }
      for (const button of [3, 4]) {
        transaction.addEvent(runtime.Backend.DeviceEvent.mouseButtonPressed(button))
        transaction.addEvent(runtime.Backend.DeviceEvent.mouseButtonReleased(button))
      }
      for (const vertical of [true, false]) for (const amount of [-240, -1, 1, 240]) transaction.addEvent(runtime.Backend.DeviceEvent.wheelRotations(vertical, amount, 0))
    } finally { transaction.free() }
  } finally { runtime.runtime.dispose() }
  console.log('PASS pinned real WASM accepts BMP/supplementary Unicode key pairs and transaction cleanup')
  const environment = { ...process.env, OMNIDESK_USER_DATA_DIR: directory }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: process.env.OMNIDESK_QA_EXE || require('electron'), args: [...(process.env.OMNIDESK_QA_EXE ? [] : [path.resolve('.')]), '--disable-gpu'], env: environment })
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ width: 1280, height: 900 }); window.focus() })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(`(() => {
    ${inputScript}
    ${clipboardScript}
    const { scancodeFor, shouldUseUnicode, mouseButtonFor } = rdpInput;
    const rdpDisplaySize = () => { throw new Error('unexpected resize') };
    document.body.insertAdjacentHTML('beforeend', '<button id="qa-outside" style="position:fixed;top:0;left:0;z-index:1000000">QA outside</button>');
    globalThis.qaFixtures = {};
    globalThis.mountInput = (name, enabled = true) => {
      const stage = document.createElement('div');
      stage.style.cssText = 'position:fixed;left:20px;top:100px;width:800px;height:450px;z-index:999999;background:#17272b';
      const canvas = document.createElement('canvas');
      canvas.width = 1600; canvas.height = 900; canvas.style.cssText = 'width:800px;height:450px;touch-action:none';
      stage.appendChild(canvas); document.body.appendChild(stage);
      const calls = [];
      const session = { applyInputs: transaction => calls.push(...transaction.events), releaseAllInputs: () => calls.push(['releaseAll']) };
      const sessionRef = { current: session }, activeRef = { current: true }, containerRef = { current: stage }, cleanupRef = { current: null }, pasteClipboardRef = { current: null }, keyboardRef = { current: null };
      ${attachScript}
      const DeviceEvent = Object.fromEntries(['mouseMove','mouseButtonPressed','mouseButtonReleased','keyPressed','keyReleased','unicodePressed','unicodeReleased','wheelRotations'].map(name => [name, (...values) => [name, ...values]]));
      class InputTransaction { constructor() { this.events = [] } addEvent(event) { this.events.push(event) } }
      const fixture = { canvas, stage, calls, activeRef, sessionRef, keyboardRef, cleanupRef, pasteClipboardRef, local: 'QA剪贴板🙂', published: [], errors: [] };
      const bridge = enabled ? rdpClipboard.createRdpClipboard({
        canSync: () => activeRef.current && sessionRef.current === session && document.hasFocus() && (document.activeElement === canvas || document.activeElement === keyboardRef.current),
        readText: async () => { if (fixture.readDelay) await fixture.readDelay; return fixture.local },
        writeText: async text => { fixture.local = text },
        publishText: async text => { calls.push(['publish', text]); fixture.published.push(text) },
        onError: message => fixture.errors.push(message)
      }) : undefined;
      attachInput(canvas, session, { DeviceEvent, InputTransaction }, false, enabled, undefined, bridge);
      fixture.bridge = bridge;
      globalThis.qaFixtures[name] = fixture;
      canvas.focus();
    };
    mountInput('first');
  })()`)
  const calls = () => page.evaluate(() => globalThis.qaFixtures.first.calls)
  const clear = () => page.evaluate(() => { globalThis.qaFixtures.first.calls.length = 0 })
  await page.waitForFunction(() => document.activeElement === globalThis.qaFixtures.first.keyboardRef.current)
  await page.waitForFunction(() => globalThis.qaFixtures.first.published.length === 1)
  await clear()
  await page.keyboard.type('nihao 123.')
  let received = await calls()
  assert(!received.some(item => item[0].startsWith('unicode')))
  assert.deepEqual(received.slice(0, 4), [['keyPressed', 0x31], ['keyReleased', 0x31], ['keyPressed', 0x17], ['keyReleased', 0x17]])
  await clear()
  await page.keyboard.press('Control+Space')
  await page.keyboard.press('Control+Shift')
  await page.keyboard.press('Control+c')
  received = await calls()
  assert.deepEqual(received.slice(0, 4), [['keyPressed', 0x1d], ['keyPressed', 0x39], ['keyReleased', 0x39], ['keyReleased', 0x1d]])
  assert.deepEqual(received.slice(4, 8), [['keyPressed', 0x1d], ['keyPressed', 0x2a], ['keyReleased', 0x2a], ['keyReleased', 0x1d]])
  assert.deepEqual(received.slice(8), [['keyPressed', 0x1d], ['keyPressed', 0x2e], ['keyReleased', 0x2e], ['keyReleased', 0x1d]])
  for (const [shortcut, scan] of [['Control+Shift+n', 0x31], ['Control+Shift+k', 0x25], ['Control+Shift+ArrowLeft', 0xe04b], ['Meta+ArrowLeft', 0xe04b]]) {
    await clear()
    await page.keyboard.press(shortcut)
    received = await calls()
    assert(received.some(item => item[0] === 'keyPressed' && item[1] === scan), shortcut + ' must reach the remote desktop')
    assert(received.some(item => item[0] === 'keyReleased' && item[1] === scan), shortcut + ' must be released')
  }
  await clear()
  await page.evaluate(() => {
    const keyboard = globalThis.qaFixtures.first.keyboardRef.current
    for (const code of ['BrowserBack', 'BrowserForward', 'PrintScreen']) {
      for (const type of ['keydown', 'keyup']) {
        const event = new KeyboardEvent(type, { key: code, code, bubbles: true, cancelable: true })
        keyboard.dispatchEvent(event)
        if (!event.defaultPrevented) throw new Error('Remote extended key must not trigger a local action')
      }
    }
  })
  assert.deepEqual(await calls(), [0xe06a, 0xe069, 0xe037].flatMap(scan => [['keyPressed', scan], ['keyReleased', scan]]))
  await clear()
  await page.keyboard.down('a'); await page.keyboard.down('a'); await page.keyboard.up('a')
  assert.deepEqual(await calls(), [['keyPressed', 0x1e], ['keyPressed', 0x1e], ['keyReleased', 0x1e]])
  console.log('PASS real Electron physical typing, remote IME switching keys, Ctrl+C, modifier release and key repeat')

  await clear()
  const client = await page.context().newCDPSession(page)
  await client.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  assert.deepEqual(await calls(), [])
  await client.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
  assert.deepEqual(await calls(), [])
  await client.send('Input.insertText', { text: '你好🙂' })
  assert.deepEqual(await calls(), [...'你好🙂'].flatMap(character => [['unicodePressed', character], ['unicodeReleased', character]]))
  assert.equal(await page.evaluate(() => globalThis.qaFixtures.first.keyboardRef.current.value), '')
  await clear()
  await page.keyboard.insertText('中文输入\n第二行🚀')
  assert.deepEqual(await calls(), [...'中文输入\n第二行🚀'].flatMap(character => character === '\n' ? [['keyPressed', 0x1c], ['keyReleased', 0x1c]] : [['unicodePressed', character], ['unicodeReleased', character]]))
  console.log('PASS real Chromium IME preedit never reaches remote; Chinese/emoji commit exactly once and textarea content is cleared')

  await clear()
  await page.evaluate(() => {
    const keyboard = globalThis.qaFixtures.first.keyboardRef.current
    const process = new KeyboardEvent('keydown', { key: 'Process', code: 'KeyN', keyCode: 229, bubbles: true, cancelable: true })
    keyboard.dispatchEvent(process)
    if (process.defaultPrevented) throw new Error('IME activation was blocked')
    keyboard.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    for (const code of ['KeyN', 'ArrowDown', 'Enter']) {
      const event = new KeyboardEvent('keydown', { key: code, code, isComposing: true, cancelable: true })
      keyboard.dispatchEvent(event)
      if (event.defaultPrevented) throw new Error('IME candidate key was blocked')
      keyboard.dispatchEvent(new KeyboardEvent('keyup', { key: code, code, isComposing: true }))
    }
    keyboard.dispatchEvent(new CompositionEvent('compositionend', { data: '合成测试' }))
    keyboard.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '合成测试' }))
  })
  assert.deepEqual(await calls(), [...'合成测试'].flatMap(character => [['unicodePressed', character], ['unicodeReleased', character]]))
  await clear()
  await page.evaluate(() => {
    const keyboard = globalThis.qaFixtures.first.keyboardRef.current
    keyboard.dispatchEvent(new KeyboardEvent('keydown', { key: 'é', code: 'KeyE', cancelable: true }))
    keyboard.dispatchEvent(new KeyboardEvent('keyup', { key: 'E', code: 'KeyE', shiftKey: true, cancelable: true }))
  })
  assert.deepEqual(await calls(), [['unicodePressed', 'é'], ['unicodeReleased', 'é']])

  await page.keyboard.down('Shift')
  await page.evaluate(() => globalThis.qaFixtures.first.keyboardRef.current.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })))
  await page.keyboard.up('Shift')
  assert.deepEqual((await calls()).slice(-2), [['keyPressed', 0x2a], ['keyReleased', 0x2a]])
  await page.locator('#qa-outside').click()
  await clear()
  await page.evaluate(() => {
    const keyboard = globalThis.qaFixtures.first.keyboardRef.current
    keyboard.dispatchEvent(new CompositionEvent('compositionend', { data: '不得发送' }))
    keyboard.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '不得发送' }))
  })
  assert.deepEqual(await calls(), [])
  console.log('PASS Process/229 and candidate navigation are not intercepted; duplicate commits, changed keyup and cancelled composition do not leak or leave keys held')

  await page.mouse.click(200, 200)
  await clear()
  await page.evaluate(() => { globalThis.qaFixtures.first.local = 'QA粘贴顺序🙂' })
  await page.keyboard.press('Control+v')
  await page.waitForFunction(() => globalThis.qaFixtures.first.published.includes('QA粘贴顺序🙂'))
  received = await calls()
  const publishIndex = received.findIndex(item => item[0] === 'publish')
  const pasteIndex = received.findIndex(item => item[0] === 'keyPressed' && item[1] === 0x2f)
  assert(publishIndex >= 0 && pasteIndex > publishIndex)
  await clear()
  await page.keyboard.press('Shift+Insert')
  await page.waitForFunction(() => globalThis.qaFixtures.first.calls.some(item => item[0] === 'keyPressed' && item[1] === 0x2f))
  received = await calls()
  assert(received.findIndex(item => item[0] === 'keyReleased' && item[1] === 0x2a) < received.findIndex(item => item[0] === 'keyPressed' && item[1] === 0x2f))
  for (const delayed of [false, true]) {
    await clear()
    await page.evaluate(delayed => {
      const fixture = globalThis.qaFixtures.first
      fixture.local = delayed ? 'QA延迟纯文本粘贴' : 'QA纯文本粘贴'
      if (delayed) fixture.readDelay = new Promise(resolve => { fixture.finishRead = resolve })
    }, delayed)
    await page.keyboard.press('Control+Shift+v')
    if (delayed) await page.evaluate(() => { const fixture = globalThis.qaFixtures.first; fixture.finishRead(); fixture.readDelay = undefined })
    await page.waitForFunction(() => globalThis.qaFixtures.first.calls.some(item => item[0] === 'keyPressed' && item[1] === 0x2f))
    const held = new Set()
    for (const item of await calls()) {
      if (item[0] === 'keyPressed') held.add(item[1])
      if (item[0] === 'keyReleased') held.delete(item[1])
      if (item[0] === 'keyPressed' && item[1] === 0x2f) assert(held.has(0x1d) && (held.has(0x2a) || held.has(0x36)), 'Ctrl+Shift+V must remain a shifted paste even when clipboard preparation finishes after physical key-up')
    }
    assert.equal(held.size, 0, 'Paste must not leave a modifier held remotely')
  }
  console.log('PASS Ctrl+V, Shift+Insert and Ctrl+Shift+V preserve the intended remote chord, including delayed clipboard reads after physical modifier release')
  await clear()
  await page.mouse.click(420, 325)
  assert.deepEqual((await calls()).slice(-2), [['mouseMove', 800, 450], ['mouseButtonReleased', 0]])
  await page.mouse.down(); await page.mouse.move(1200, 800); await page.mouse.up()
  assert.deepEqual((await calls()).slice(-2), [['mouseMove', 1599, 899], ['mouseButtonReleased', 0]])
  for (const [button, remote] of [['right', 2], ['middle', 1]]) {
    await page.mouse.click(420, 325, { button })
    assert.deepEqual((await calls()).at(-1), ['mouseButtonReleased', remote])
  }
  const protocol = await page.context().newCDPSession(page)
  await page.evaluate(() => { history.pushState({}, '', '#rdp-input-before'); history.pushState({}, '', '#rdp-input-current') })
  const originalLocation = page.url()
  for (const [button, mask, remote] of [['back', 8, 3], ['forward', 16, 4]]) {
    await clear()
    await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 420, y: 325, button, buttons: mask, clickCount: 1 })
    await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 325, button, buttons: 0, clickCount: 1 })
    assert.deepEqual((await calls()).filter(item => item[0].startsWith('mouseButton')), [['mouseButtonPressed', remote], ['mouseButtonReleased', remote]])
    assert.equal(page.url(), originalLocation, 'Mouse side buttons must not navigate the local application')
  }
  await clear()
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 420, y: 325, button: 'left', buttons: 1, clickCount: 1 })
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 420, y: 325, button: 'back', buttons: 9, clickCount: 1 })
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 420, y: 325, button: 'right', buttons: 11, clickCount: 1 })
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 325, button: 'back', buttons: 3, clickCount: 1 })
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 325, button: 'left', buttons: 2, clickCount: 1 })
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 420, y: 325, button: 'right', buttons: 0, clickCount: 1 })
  assert.deepEqual((await calls()).filter(item => item[0].startsWith('mouseButton')), [['mouseButtonPressed', 0], ['mouseButtonPressed', 3], ['mouseButtonPressed', 2], ['mouseButtonReleased', 3], ['mouseButtonReleased', 0], ['mouseButtonReleased', 2]])
  await clear()
  await page.evaluate(() => {
    const canvas = globalThis.qaFixtures.first.canvas
    for (const [deltaX, deltaY, deltaMode] of [[0, 0, 0], [100, 0, 0], [-100, 100, 0], [0, -3, 1], [0, 0.25, 0], [0, 0.25, 0], [0, 0.25, 0], [0, 0.25, 0], [0, 1000, 0]]) {
      const event = new WheelEvent('wheel', { clientX: 420, clientY: 325, deltaX, deltaY, deltaMode, bubbles: true, cancelable: true })
      canvas.dispatchEvent(event)
      if (!event.defaultPrevented) throw new Error('Remote scroll must not scroll or zoom the local application')
    }
  })
  received = (await calls()).filter(item => item[0] === 'wheelRotations')
  assert.deepEqual(received.slice(0, 4), [['wheelRotations', false, 120, 0], ['wheelRotations', false, -120, 0], ['wheelRotations', true, -120, 0], ['wheelRotations', true, 120, 0]])
  assert.deepEqual(received[4], ['wheelRotations', true, -1, 0], 'High-resolution scroll accumulates fractions rather than inventing full notches')
  assert.equal(received.slice(5).reduce((sum, item) => sum + item[2], 0), -1200, 'Fast scrolling must not lose distance to the protocol clamp')
  assert(received.every(item => item[2] !== 0 && Math.abs(item[2]) <= 240))
  await clear()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 100)
  await page.waitForFunction(() => globalThis.qaFixtures.first.calls.some(item => item[0] === 'wheelRotations'))
  await page.keyboard.up('Control')
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1)
  await clear()
  await page.evaluate(() => globalThis.qaFixtures.first.canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 420, clientY: 325, deltaY: 1, deltaMode: 2, cancelable: true })))
  assert.equal((await calls()).filter(item => item[0] === 'wheelRotations').reduce((sum, item) => sum + item[2], 0), -540)
  for (const type of ['pointercancel', 'lostpointercapture']) {
    await clear()
    await page.evaluate(type => {
      const canvas = globalThis.qaFixtures.first.canvas
      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 4, buttons: 16, pointerId: 99, clientX: 420, clientY: 325, bubbles: true, cancelable: true }))
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: 99 }))
    }, type)
    assert.deepEqual((await calls()).filter(item => item[0].startsWith('mouseButton')), [['mouseButtonPressed', 4], ['mouseButtonReleased', 4]])
  }
  console.log('PASS real Chromium side buttons, simultaneous button chords, no local navigation; extended keys and Ctrl/Shift/Meta combinations; horizontal/high-resolution/fast scrolling and remote-only Ctrl+wheel')
  await clear()
  await page.mouse.dblclick(420, 325)
  assert.deepEqual((await calls()).filter(item => item[0].startsWith('mouseButton')), [['mouseButtonPressed', 0], ['mouseButtonReleased', 0], ['mouseButtonPressed', 0], ['mouseButtonReleased', 0]])
  await page.evaluate(() => { globalThis.qaFixtures.first.canvas.width = 2000; globalThis.qaFixtures.first.canvas.height = 1200 })
  await page.mouse.click(420, 325)
  assert.deepEqual((await calls()).slice(-2), [['mouseMove', 1000, 600], ['mouseButtonReleased', 0]])
  await page.evaluate(() => { globalThis.qaFixtures.first.canvas.width = 1600; globalThis.qaFixtures.first.canvas.height = 900; globalThis.qaFixtures.first.canvas.style.height = '800px' })
  await clear()
  await page.mouse.click(420, 110)
  await page.evaluate(() => globalThis.qaFixtures.first.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 420, clientY: 110, cancelable: true })))
  assert(!(await calls()).some(item => item[0] === 'mouseButtonPressed'))
  assert(!(await calls()).some(item => item[0] === 'wheelRotations'))
  await page.evaluate(() => { globalThis.qaFixtures.first.canvas.style.height = '450px' })
  await page.mouse.move(420, 325); await page.mouse.down()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await clear()
  await page.mouse.up()
  assert(!(await calls()).some(item => item[0] === 'mouseButtonReleased'))
  console.log('PASS real Electron left/right/middle/double click, scaled coordinates, off-canvas drag/release, resize, letterboxing and blur with the IME focus proxy')
  await page.evaluate(() => { globalThis.qaFixtures.first.activeRef.current = false; mountInput('second') })
  await clear()
  await page.evaluate(() => {
    const first = globalThis.qaFixtures.first
    first.keyboardRef.current.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '后台不得输入' }))
    first.keyboardRef.current.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }))
    first.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 420, clientY: 325 }))
    first.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 3, buttons: 8, clientX: 420, clientY: 325 }))
    first.canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, deltaY: 100, clientX: 420, clientY: 325 }))
  })
  assert.deepEqual(await calls(), [])
  await page.evaluate(() => mountInput('disabled', false))
  await page.evaluate(() => {
    const fixture = globalThis.qaFixtures.disabled
    fixture.calls.length = 0
    fixture.keyboardRef.current.dispatchEvent(new ClipboardEvent('paste', { cancelable: true }))
    fixture.keyboardRef.current.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: '禁止剪贴板绕过' }))
  })
  assert.deepEqual(await page.evaluate(() => globalThis.qaFixtures.disabled.calls), [])
  await clear()
  await page.evaluate(() => {
    const fixture = globalThis.qaFixtures.first
    fixture.activeRef.current = true
    fixture.sessionRef.current = null
    fixture.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 420, clientY: 325 }))
    fixture.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 4, buttons: 16, clientX: 420, clientY: 325 }))
    fixture.canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: 100, deltaY: 100, clientX: 420, clientY: 325 }))
  })
  assert.deepEqual(await calls(), [])
  await page.evaluate(() => {
    for (const fixture of Object.values(globalThis.qaFixtures)) {
      const keyboard = fixture.keyboardRef.current
      fixture.cleanupRef.current()
      if (keyboard.isConnected || fixture.keyboardRef.current !== null) throw new Error('keyboard input was not cleaned up')
      fixture.stage.remove()
    }
  })
  assert.deepEqual(errors, [])
  console.log('PASS focused input preserves clipboard ordering and Shift+Insert; background/disabled/disconnected sessions are isolated; no OS clipboard or real server accessed')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => { if (application) await application.close() })
