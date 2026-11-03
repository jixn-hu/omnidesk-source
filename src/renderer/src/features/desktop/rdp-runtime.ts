import { createBackend, type RdpBackend } from 'tabby-rdp/vendor/ironrdp-factory.js'
import wasmUrl from 'tabby-rdp/vendor/ironrdp_web_bg.wasm?url'

export type RdpRuntime = RdpBackend['Backend'] & Pick<RdpBackend, 'enableCredssp' | 'displayControl' | 'runtime'>

let compiled: Promise<WebAssembly.Module> | undefined

export async function createRdpRuntime(): Promise<RdpRuntime> {
  if (!compiled) {
    compiled = (async () => {
      const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`RDP 协议栈加载失败：${response.status}`)
      return WebAssembly.compile(await response.arrayBuffer())
    })().catch((error) => { compiled = undefined; throw error })
  }
  const backend = await createBackend(await compiled, 'WARN')
  return { ...backend.Backend, enableCredssp: backend.enableCredssp, displayControl: backend.displayControl, runtime: backend.runtime }
}
