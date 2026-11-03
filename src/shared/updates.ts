import type { IpcResult } from './types'

export const APP_UPDATE_REPOSITORY = 'jixn-hu/omnidesk-releases'

export interface AppRelease {
  tag: string
  version: string
  name: string
  notes: string
  publishedAt: string
  url: string
}

export interface AppUpdateStatus {
  currentVersion: string
  autoCheck: boolean
  checking: boolean
  available: boolean
  lastCheckedAt?: number
  release?: AppRelease
  error?: string
}

export interface AppUpdateApi {
  status: () => Promise<IpcResult<AppUpdateStatus>>
  check: () => Promise<IpcResult<AppUpdateStatus>>
  setAutoCheck: (enabled: boolean) => Promise<IpcResult<AppUpdateStatus>>
  openRelease: () => Promise<IpcResult<boolean>>
  onChange: (callback: (status: AppUpdateStatus) => void) => () => void
}
