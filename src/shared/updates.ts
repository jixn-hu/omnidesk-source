import type { IpcResult } from './types'

export const APP_UPDATE_REPOSITORY = 'jixn-hu/omnidesk'
export const APP_SOURCE_URL = 'https://github.com/' + APP_UPDATE_REPOSITORY
export const SERVER_SOURCE_URL = 'https://github.com/jixn-hu/omnidesk-server'

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
