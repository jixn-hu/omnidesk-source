import type { IpcResult } from './types'

export interface CredentialProbeResult {
  connectionId: string
  credentialId: string
  success: boolean
  message: string
}

export interface CredentialProbeStep {
  done: boolean
  result?: CredentialProbeResult
  rdp?: {
    connectionId: string
    credentialId: string
    transport: { wsUrl: string; sessionId: string; token: string }
    username: string
    password: string
    domain?: string
    destination: string
  }
}

export interface CredentialProbeApi {
  start: (connectionIds: string[], credentialIds: string[]) => Promise<IpcResult<string>>
  next: (jobId: string) => Promise<IpcResult<CredentialProbeStep>>
  finishRdp: (jobId: string, success: boolean) => Promise<IpcResult<CredentialProbeResult>>
  cancel: (jobId: string) => Promise<IpcResult<boolean>>
  apply: (jobId: string, connectionId: string) => Promise<IpcResult<boolean>>
}
