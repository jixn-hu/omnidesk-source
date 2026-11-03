/** 浏览器 KeyboardEvent.code → PS/2 Set 1 扫描码 */
const SCANCODE: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f,
  F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  F11: 0x57, F12: 0x58
}

const EXTENDED: Record<string, number> = {
  Insert: 0x52, Delete: 0x53, Home: 0x47, End: 0x4f,
  PageUp: 0x49, PageDown: 0x51,
  ArrowUp: 0x48, ArrowDown: 0x50, ArrowLeft: 0x4b, ArrowRight: 0x4d,
  NumpadEnter: 0x1c, NumpadDivide: 0x35,
  ControlRight: 0x1d, AltRight: 0x38,
  MetaLeft: 0x5b, MetaRight: 0x5c,
  ContextMenu: 0x5d, PrintScreen: 0x37,
  BrowserBack: 0x6a, BrowserForward: 0x69
}

export function scancodeFor(code: string): number | null {
  if (code in SCANCODE) return SCANCODE[code]!
  if (code in EXTENDED) return EXTENDED[code]! | 0xe000
  return null
}

export function mouseButtonFor(button: number): number | null {
  switch (button) {
    case 0:
      return 0
    case 1:
      return 1
    case 2:
      return 2
    case 3:
      return 3
    case 4:
      return 4
    default:
      return null
  }
}

export function shouldUseUnicode(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false
  if ([...e.key].length !== 1) return false
  const code = e.key.codePointAt(0) ?? 0
  return code >= 0x20 && code !== 0x7f && (code > 0x7f || scancodeFor(e.code) === null)
}
