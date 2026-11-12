/** Docker resources read through the current SSH session. No daemon TCP port is opened. */
export type DockerUnavailableReason = 'not-linux' | 'not-installed' | 'context' | 'remote-context' | 'permission' | 'daemon'
export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  created: string
}
export interface DockerImage {
  id: string
  tags: string[]
  size: string
  created: string
}
export interface DockerSnapshot {
  available: boolean
  reason?: DockerUnavailableReason
  message?: string
  endpoint?: string
  daemonId?: string
  version?: string
  containers: DockerContainer[]
  images: DockerImage[]
  collectedAt: number
}
export interface DockerRemoveRequest {
  kind: 'container' | 'image'
  /** Full immutable ID, never a user-provided shell expression or mutable name. */
  id: string
  endpoint: string
  daemonId: string
}
