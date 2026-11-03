import type { IpcResult } from './types'

export type AiPermissionMode = 'read' | 'edit' | 'full'
export const AI_DEFAULT_MAX_MODEL_CALLS = 200
export const AI_MAX_MODEL_CALLS = 1000
export const aiPermissionModes = [
  { value: 'read', label: '只读权限', description: '读取服务器资料，查询 Linux / Windows 状态。' },
  { value: 'edit', label: '编辑权限', description: '允许查询、新增服务器资料，以及修改标签、备注、分组。' },
  { value: 'full', label: '完全权限', description: '允许编辑，并可确认删除服务器资料、逐条确认执行任意 SSH 命令。' }
] as const
export interface AiConfiguration { baseUrl: string; model: string; hasApiKey: boolean; maxModelCalls: number; permissionMode: AiPermissionMode }
export interface AiConfigurationInput { baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean; maxModelCalls?: number; permissionMode?: AiPermissionMode }
export type AiApprovalRequest = {
  kind: 'ssh'
  serverId: string
  serverName: string
  destination: string
  command: string
  reason: string
} | { kind: 'question'; title: string; message: string } | { kind: 'delete'; serverId: string; serverName: string; destination: string }
export type AiApproval = AiApprovalRequest & { id: string; expiresAt: number }
export type AiApprovalOutcome = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'stopped'
export type AiApprovalRecord = AiApproval & { outcome: AiApprovalOutcome }
export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'activity' | 'approval'
  text: string
  at: number
  error?: boolean
  approval?: AiApprovalRecord
}
export interface AiConversationState {
  status: 'idle' | 'running' | 'approval'
  messages: AiMessage[]
  pending: AiApproval | null
  selectedIds: string[]
  scopeMode: 'all' | 'selected'
  scopeCount: number
  permissionMode: AiPermissionMode
  interrupted?: boolean
  modelCalls: number
  maxModelCalls: number
}
export interface AiConversationSummary {
  id: string
  title: string
  status: AiConversationState['status']
  permissionMode: AiPermissionMode
  unread: boolean
  updatedAt: number
  hasMessages: boolean
  interrupted: boolean
}
export interface AiState extends AiConversationState { revision: number; storageError?: string; conversationId: string; conversations: AiConversationSummary[] }
export interface AiApi {
  configuration: () => Promise<IpcResult<AiConfiguration>>
  saveConfiguration: (input: AiConfigurationInput) => Promise<IpcResult<AiConfiguration>>
  test: () => Promise<IpcResult<string>>
  state: () => Promise<IpcResult<AiState>>
  send: (text: string, connectionIds: string[], conversationId?: string) => Promise<IpcResult<AiState>>
  confirm: (id: string, approved: boolean, conversationId?: string) => Promise<IpcResult<boolean>>
  cancel: (conversationId?: string) => Promise<IpcResult<boolean>>
  clear: (conversationId?: string) => Promise<IpcResult<AiState>>
  createConversation: () => Promise<IpcResult<AiState>>
  selectConversation: (id: string) => Promise<IpcResult<AiState>>
  deleteConversation: (id: string) => Promise<IpcResult<AiState>>
  setPermissionMode: (mode: AiPermissionMode, conversationId?: string) => Promise<IpcResult<AiState>>
  onChange: (callback: (state: AiState) => void) => () => void
  onMetadataChanged: (callback: () => void) => () => void
}
