declare module 'tabby-rdp/vendor/ironrdp_web_bg.wasm?url' {
  const url: string
  export default url
}

declare module 'tabby-rdp/vendor/ironrdp-factory.js' {
  type Bindings = typeof import('ironrdp-wasm')

  export interface RdpBackend {
    Backend: Pick<Bindings, 'SessionBuilder' | 'DesktopSize' | 'DeviceEvent' | 'InputTransaction' | 'ClipboardData'>
    enableCredssp(enabled: boolean): import('ironrdp-wasm').Extension
    displayControl(enabled: boolean): import('ironrdp-wasm').Extension
    runtime: { dispose(): void }
  }

  export function createBackend(module: WebAssembly.Module, level: string): Promise<RdpBackend>
}
