export interface DesktopEvent { free(): void }
export interface DesktopTransaction {
  addEvent(event: DesktopEvent): void
  free(): void
}
export interface DesktopClipboard {
  addText(mime: string, text: string): void
  free(): void
}
export interface DesktopSession {
  applyInputs(transaction: DesktopTransaction): void
  onClipboardPaste(content: DesktopClipboard): Promise<void>
  releaseAllInputs(): void
  resize(width: number, height: number, scale?: number | null): void
  run(): Promise<{ reason(): string; free(): void }>
  shutdown(): void
  free(): void
}
export interface DesktopBuilder {
  username(value: string): DesktopBuilder
  password(value: string): DesktopBuilder
  destination(value: string): DesktopBuilder
  proxyAddress(value: string): DesktopBuilder
  authToken(value: string): DesktopBuilder
  renderCanvas(value: HTMLCanvasElement): DesktopBuilder
  setCursorStyleCallbackContext(value: HTMLCanvasElement): DesktopBuilder
  setCursorStyleCallback(callback: (kind: string, data?: string, x?: number, y?: number) => void): DesktopBuilder
  serverDomain(value: string): DesktopBuilder
  extension(value: unknown): DesktopBuilder
  desktopSize(value: { width: number; height: number }): DesktopBuilder
  forceClipboardUpdateCallback(callback: () => void): DesktopBuilder
  remoteClipboardChangedCallback(callback: (data: unknown) => void): DesktopBuilder
  connectionStateChanged?(callback: (state: { reconnecting: boolean; attempt: number }) => void): DesktopBuilder
  connect(): Promise<DesktopSession>
  free(): void
}
export interface DesktopRuntime {
  SessionBuilder: new () => DesktopBuilder
  DesktopSize: new (width: number, height: number) => { width: number; height: number }
  DeviceEvent: {
    keyPressed(scan: number): DesktopEvent
    keyReleased(scan: number): DesktopEvent
    unicodePressed(value: string): DesktopEvent
    unicodeReleased(value: string): DesktopEvent
    mouseMove(x: number, y: number): DesktopEvent
    mouseButtonPressed(button: number): DesktopEvent
    mouseButtonReleased(button: number): DesktopEvent
    wheelRotations(vertical: boolean, amount: number, unit: number): DesktopEvent
  }
  InputTransaction: new () => DesktopTransaction
  ClipboardData: new () => DesktopClipboard
  enableCredssp(enabled: boolean): unknown
  displayControl(enabled: boolean): unknown
  runtime: { dispose(): void }
}
