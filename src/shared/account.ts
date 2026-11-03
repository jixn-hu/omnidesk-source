import type { ConfigurationSummary, IpcResult } from './types'

export interface OfficialAccountStatus {
  serverUrl: string
  user: { id: string; username: string; role: 'admin' | 'user'; gitlab?: { issuer: string; username: string } } | null
  revision: number
  lastSync?: number
}

export interface OfficialUserInfo {
  id: string
  username: string
  role: 'admin' | 'user'
  createdAt: number
  lastLoginAt: number | null
  configurationRevision: number | null
  configurationUpdatedAt: number | null
  configurationBytes: number | null
  sharedServers: number
  loginSessions: number
}

export interface OfficialUsers {
  total: number
  summary: { users: number; administrators: number; synchronizedUsers: number; sharedServers: number }
  items: OfficialUserInfo[]
}

export interface OfficialAuthProviders {
  registrationOpen: boolean
  gitlab: { enabled: boolean; issuer?: string }
}

export interface OfficialAdminSettings {
  registrationOpen: boolean
  gitlab: { enabled: boolean; issuer: string; clientId: string; redirectUri: string; secretConfigured: boolean }
}

export type OfficialAdminSettingsInput = Pick<OfficialAdminSettings, 'registrationOpen'> & { gitlab?: Omit<OfficialAdminSettings['gitlab'], 'secretConfigured'> & { clientSecret?: string } }
export interface OfficialBatchResult { succeeded: number; failed: Array<{ id: string; name: string; message: string }>; cancelled: boolean }

export interface OfficialShare {
  id: string
  name: string
  kind: 'ssh' | 'rdp'
  host: string
  port: number
  username: string
  note: string
  owner: string
  source?: 'managed' | 'user'
  group?: string
  tags?: string[]
  owned: boolean
  createdAt: number
  downloadable?: boolean
  sharingMode?: 'copy'
}

export interface OfficialAccountApi {
  openAdmin: () => Promise<IpcResult<boolean>>
  status: () => Promise<IpcResult<OfficialAccountStatus>>
  configure: (serverUrl: string) => Promise<IpcResult<OfficialAccountStatus>>
  authenticate: (action: 'register' | 'login', username: string, password: string) => Promise<IpcResult<OfficialAccountStatus>>
  providers: () => Promise<IpcResult<OfficialAuthProviders>>
  settings: () => Promise<IpcResult<OfficialAdminSettings>>
  saveSettings: (input: OfficialAdminSettingsInput) => Promise<IpcResult<OfficialAdminSettings>>
  startGitlab: (mode: 'login' | 'link') => Promise<IpcResult<{ id: string; expiresAt: number }>>
  pollGitlab: (id: string) => Promise<IpcResult<{ state: 'pending' | 'complete'; status?: OfficialAccountStatus }>>
  cancelGitlab: (id: string) => Promise<IpcResult<boolean>>
  logout: () => Promise<IpcResult<OfficialAccountStatus>>
  upload: () => Promise<IpcResult<OfficialAccountStatus>>
  download: () => Promise<IpcResult<ConfigurationSummary | null>>
  shares: (search: string, page: number) => Promise<IpcResult<{ items: OfficialShare[]; total: number }>>
  users: (search: string, page: number) => Promise<IpcResult<OfficialUsers>>
  publish: (connectionId: string) => Promise<IpcResult<{ id: string } | null>>
  publishMany: (connectionIds: string[]) => Promise<IpcResult<OfficialBatchResult>>
  unpublish: (shareId: string) => Promise<IpcResult<boolean>>
  unpublishMany: (shareIds: string[]) => Promise<IpcResult<OfficialBatchResult>>
  importShare: (shareId: string) => Promise<IpcResult<{ connectionId: string; skipped: boolean } | null>>
  connect: (shareId: string, width: number, height: number) => Promise<IpcResult<{ sessionId: string; url: string }>>
  release: (sessionId: string) => Promise<IpcResult<boolean>>
}
