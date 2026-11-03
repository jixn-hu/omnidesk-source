/**
 * 事件桥 —— 把服务层的事件转发给渲染进程
 *
 * 服务层不认识界面，只负责 emit 事件；这里做单向转发。
 *
 * 多窗口注意：必须**广播给所有窗口**，而不是只发给主窗口。
 * 否则在窗口 B 打开的终端收不到输出 —— 因为服务层是共享的，
 * 它不知道（也不该知道）这条会话是哪个窗口开的。
 */
import { IPC } from '@shared/ipc.js'
import { services } from './services/index.js'
import { broadcast } from './windows.js'

export function bridgeServiceEvents(): void {
  services.updates.on('changed', status => broadcast(IPC.push.updatesChanged, status))
  /* SSH 输出（终端数据流） */
  services.ssh.on('data', (sessionId: string, chunk: Buffer) => {
    broadcast(IPC.push.sshData, { sessionId, data: new Uint8Array(chunk) })
  })

  /* 会话关闭 */
  services.ssh.on('close', (sessionId: string, reason?: string) => {
    broadcast(IPC.push.sshClose, { sessionId, reason })
  })

  /* 会话状态变化 */
  services.ssh.on('sessionEvent', (info: unknown) => {
    broadcast(IPC.push.sessionEvent, info)
  })

  /* 主机密钥确认 —— 只发给一个窗口即可，发给全部会导致多个弹窗 */
  services.ssh.on('hostKeyPrompt', (payload: unknown) => {
    broadcast(IPC.push.hostKeyPrompt, payload)
  })

  /* 传输进度 */
  services.sftp.on('progress', (task: unknown) => {
    broadcast(IPC.push.transferProgress, task)
  })

  /* 端口转发状态变化 */
  services.forwards.on('status', (status: unknown) => {
    broadcast(IPC.push.forwardStatus, status)
  })

  /* 转发出错（如远端拒绝监听） */
  services.forwards.on('error', (payload: { ruleId: string; message: string }) => {
    broadcast(IPC.push.forwardError, payload)
  })
}
