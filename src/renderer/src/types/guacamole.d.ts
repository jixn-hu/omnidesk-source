declare module 'guacamole-common-js' {
  interface GuacStatus { code: number; message?: string }
  interface MouseState { x: number; y: number; left: boolean; middle: boolean; right: boolean; up: boolean; down: boolean }
  interface InputStream { sendAck: (message: string, code: number) => void }
  interface OutputStream {}
  class Display {
    getElement(): HTMLElement
    getWidth(): number
    getHeight(): number
    scale(value: number): void
    showCursor(shown: boolean): void
    onresize: ((width: number, height: number) => void) | null
  }
  class WebSocketTunnel {
    constructor(url: string)
    onerror: ((status: GuacStatus) => void) | null
    onstatechange: ((state: number) => void) | null
  }
  class Client {
    constructor(tunnel: WebSocketTunnel)
    getDisplay(): Display
    connect(data?: string): void
    disconnect(): void
    sendSize(width: number, height: number): void
    sendKeyEvent(pressed: number, keysym: number): void
    sendMouseState(state: MouseState, scaled?: boolean): void
    createClipboardStream(mimetype: string): OutputStream
    onerror: ((status: GuacStatus) => void) | null
    onstatechange: ((state: number) => void) | null
    onclipboard: ((stream: InputStream, mimetype: string) => void) | null
  }
  class Mouse {
    constructor(element: HTMLElement)
    onmousedown: ((state: MouseState) => void) | null
    onmouseup: ((state: MouseState) => void) | null
    onmousemove: ((state: MouseState) => void) | null
  }
  class Keyboard {
    constructor(element: HTMLElement)
    onkeydown: ((keysym: number) => boolean) | null
    onkeyup: ((keysym: number) => void) | null
    reset(): void
  }
  class StringReader {
    constructor(stream: InputStream)
    ontext: ((text: string) => void) | null
    onend: (() => void) | null
  }
  class StringWriter {
    constructor(stream: OutputStream)
    sendText(text: string): void
    sendEnd(): void
  }
  const Guacamole: { Client: typeof Client; WebSocketTunnel: typeof WebSocketTunnel; Tunnel: { State: { CLOSED: number } }; Mouse: typeof Mouse; Keyboard: typeof Keyboard; StringReader: typeof StringReader; StringWriter: typeof StringWriter }
  export default Guacamole
}
