/**
 * 应用状态
 *
 * 用 zustand 保持轻量 —— 不引入 reducer/action 那套仪式感。
 * 约定：所有跨组件的状态放这里，组件内部状态留在组件里。
 */
import { create } from 'zustand'
import type { Connection, ConnectionCheck, ExternalAccessConfig, SessionInfo } from '@shared/types'
import type { OfficialAccountStatus } from '@shared/account'

/** 会话标签页 */
export interface Tab {
  id: string
  kind: 'ssh' | 'rdp' | 'files' | 'monitor' | 'forwards' | 'settings' | 'ai' | 'external' | 'credentials' | 'servers' | 'account' | 'shared-servers' | 'shared-session'
  title: string
  connectionId?: string
  sessionId?: string
  shareId?: string
  shareKind?: 'ssh' | 'rdp'
  /** 连接中/出错时的提示 */
  status: 'connecting' | 'connected' | 'error' | 'idle'
  error?: string
}

/** 主机密钥确认请求 */
export interface HostKeyRequest {
  sessionId: string
  host: string
  port: number
  fingerprint: string
  keyType: string
  changed: boolean
  previousFingerprint?: string
}

/** 外部调用审批请求 */
export interface ApprovalRequest {
  requestId: string
  operation: string
  detail: string
}

interface AppState {
  /* 应用 */
  ready: boolean
  vaultStatus: 'uninitialized' | 'locked' | 'unlocked'

  /* 数据 */
  connections: Connection[]
  connectionChecks: Record<string, ConnectionCheck>
  tabs: Tab[]
  activeTabId: string | null
  sessions: SessionInfo[]
  externalConfig: ExternalAccessConfig | null
  accountUser: OfficialAccountStatus['user']

  /* 阻塞式交互 */
  hostKeyRequest: HostKeyRequest | null
  hostKeyQueue: HostKeyRequest[]
  approvals: ApprovalRequest[]

  /* 动作 */
  setReady: (v: boolean) => void
  setVaultStatus: (s: AppState['vaultStatus']) => void
  setConnections: (c: Connection[]) => void
  setSessions: (s: SessionInfo[]) => void
  setExternalConfig: (c: ExternalAccessConfig) => void

  openTab: (tab: Omit<Tab, 'id'> & { id?: string; newSession?: boolean }) => string
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTab: (id: string, patch: Partial<Tab>) => void
  findTabByConnection: (connectionId: string) => Tab | undefined

  setHostKeyRequest: (r: HostKeyRequest | null) => void
  removeHostKeyRequest: (sessionId: string) => void
  pushApproval: (r: ApprovalRequest) => void
  removeApproval: (requestId: string) => void
}


export const useApp = create<AppState>((set, get) => ({
  ready: false,
  vaultStatus: 'uninitialized',
  connections: [],
  connectionChecks: {},
  tabs: [],
  activeTabId: null,
  sessions: [],
  externalConfig: null,
  accountUser: null,
  hostKeyRequest: null,
  hostKeyQueue: [],
  approvals: [],

  setReady: (v) => set({ ready: v }),
  setVaultStatus: (s) => set({ vaultStatus: s }),
  setConnections: (c) => set({ connections: c }),
  setSessions: (s) => set({ sessions: s }),
  setExternalConfig: (c) => set({ externalConfig: c }),

  openTab: (tab) => {
    if (tab.id && get().tabs.some((existing) => existing.id === tab.id)) {
      set({ activeTabId: tab.id })
      return tab.id
    }
    // 同一连接已经开着就不重复开，直接切过去
    if (tab.connectionId && !tab.newSession) {
      const existing = get().tabs.find(
        (t) => t.connectionId === tab.connectionId && t.kind === tab.kind && (!tab.sessionId || t.sessionId === tab.sessionId)
      )
      if (existing) {
        set({ activeTabId: existing.id })
        return existing.id
      }
    }
    const id = tab.id ?? crypto.randomUUID()
    set((s) => ({
      tabs: [...s.tabs, { ...tab, id }],
      activeTabId: id
    }))
    return id
  },

  closeTab: (id) => {
    const { tabs, activeTabId, sessions } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return

    const tab = tabs[idx]!
    if (tab.kind === 'shared-session' && tab.sessionId) void window.omnidesk.account.release(tab.sessionId)
    // 关标签 = 断连接
    const ownedSessionId = tab.kind === 'ssh' ? tab.sessionId ?? sessions.find((session) => session.ownerId === tab.id && session.status === 'connecting')?.id : undefined
    if (ownedSessionId) {
      void window.omnidesk.ssh.disconnect(ownedSessionId)
    }

    const next = tabs.filter((t) => t.id !== id)
    let nextActive = activeTabId
    if (activeTabId === id) {
      const fallback = next[Math.min(idx, next.length - 1)]
      nextActive = fallback?.id ?? null
    }
    set({ tabs: next, activeTabId: nextActive })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),

  findTabByConnection: (connectionId) =>
    get().tabs.find((t) => t.connectionId === connectionId),

  removeHostKeyRequest: (sessionId) => set(state => {
    const pending = [state.hostKeyRequest, ...state.hostKeyQueue].filter((request): request is HostKeyRequest => !!request && request.sessionId !== sessionId)
    return { hostKeyRequest: pending[0] ?? null, hostKeyQueue: pending.slice(1) }
  }),

  setHostKeyRequest: (request) => set(state => {
    if (!request) return { hostKeyRequest: state.hostKeyQueue[0] ?? null, hostKeyQueue: state.hostKeyQueue.slice(1) }
    if (state.hostKeyRequest?.sessionId === request.sessionId || state.hostKeyQueue.some(item => item.sessionId === request.sessionId)) return {}
    return state.hostKeyRequest ? { hostKeyQueue: [...state.hostKeyQueue, request] } : { hostKeyRequest: request }
  }),

  pushApproval: (r) => set((s) => ({ approvals: [...s.approvals, r] })),

  removeApproval: (requestId) =>
    set((s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }))
}))

/** 判断某连接当前是否有活跃会话 */
export function useSessionForConnection(connectionId: string): SessionInfo | undefined {
  return useApp((s) =>
    s.sessions.find((x) => x.connectionId === connectionId && x.status === 'connected')
  )
}
