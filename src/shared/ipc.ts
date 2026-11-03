/**
 * IPC 契约定层。
 *
 * 设计原则：渲染进程不直接碰 ipcRenderer，只通过 preload 暴露的白名单方法调用。
 * 所有通道名集中在这里声明，主进程注册与 preload 暴露共用同一份常量，
 * 避免"改了名字忘了改另一边"这类低级错误。
 */

export const IPC = {
  aiConfiguration: 'ai:configuration',
  aiSaveConfiguration: 'ai:save-configuration',
  aiTest: 'ai:test',
  aiState: 'ai:state',
  aiSend: 'ai:send',
  aiConfirm: 'ai:confirm',
  aiCancel: 'ai:cancel',
  aiClear: 'ai:clear',
  aiCreateConversation: 'ai:create-conversation',
  aiSelectConversation: 'ai:select-conversation',
  aiDeleteConversation: 'ai:delete-conversation',
  aiSetPermissionMode: 'ai:set-permission-mode',
  accountStatus: 'account:status',
  accountOpenAdmin: 'account:open-admin',
  accountConfigure: 'account:configure',
  accountAuthenticate: 'account:authenticate',
  accountProviders: 'account:providers',
  accountSettings: 'account:settings',
  accountSaveSettings: 'account:save-settings',
  accountGitlabStart: 'account:gitlab-start',
  accountGitlabPoll: 'account:gitlab-poll',
  accountGitlabCancel: 'account:gitlab-cancel',
  accountLogout: 'account:logout',
  accountUpload: 'account:upload',
  accountDownload: 'account:download',
  accountShares: 'account:shares',
  accountUsers: 'account:users',
  accountPublish: 'account:publish',
  accountPublishMany: 'account:publish-many',
  accountUnpublish: 'account:unpublish',
  accountUnpublishMany: 'account:unpublish-many',
  accountImportShare: 'account:import-share',
  accountConnect: 'account:connect',
  accountRelease: 'account:release',
  /* 应用 */
  appInfo: 'app:info',
  updatesStatus: 'updates:status',
  updatesCheck: 'updates:check',
  updatesSetAutoCheck: 'updates:set-auto-check',
  updatesOpenRelease: 'updates:open-release',
  appOpenWindow: 'app:open-window',
  appWindowCount: 'app:window-count',
  fsReadText: 'fs:read-text',
  sshScanLocalKeys: 'ssh:scan-local-keys',

  /* Vault */
  vaultStatus: 'vault:status',
  vaultInit: 'vault:init',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  vaultChangePassword: 'vault:change-password',
  vaultGetMode: 'vault:get-mode',
  vaultSetMode: 'vault:set-mode',
  vaultAutoUnlock: 'vault:auto-unlock',

  /* 连接配置 */
  connList: 'conn:list',
  connChecks: 'conn:checks',
  connGet: 'conn:get',
  connSave: 'conn:save',
  connBatchMetadata: 'conn:batch-metadata',
  connDelete: 'conn:delete',
  connGroups: 'conn:groups',

  /* SSH 会话 */
  sshConnect: 'ssh:connect',
  sshDisconnect: 'ssh:disconnect',
  sshWrite: 'ssh:write',
  sshResize: 'ssh:resize',
  sshList: 'ssh:list',
  sshExec: 'ssh:exec',
  sshHostKeyDecision: 'ssh:host-key-decision',

  /* SFTP */
  sftpList: 'sftp:list',
  sftpReadFile: 'sftp:read-file',
  sftpWriteFile: 'sftp:write-file',
  sftpCreateFile: 'sftp:create-file',
  sftpMkdir: 'sftp:mkdir',
  sftpRename: 'sftp:rename',
  sftpDelete: 'sftp:delete',
  sftpDownload: 'sftp:download',
  sftpUpload: 'sftp:upload',
  sftpUploadDropped: 'sftp:upload-dropped',
  sftpMove: 'sftp:move',
  sftpDragToLocal: 'sftp:drag-to-local',
  sftpTransferList: 'sftp:transfer-list',
  sftpTransferCancel: 'sftp:transfer-cancel',

  /* RDP */
  rdpPrepare: 'rdp:prepare',
  rdpRetryLegacy: 'rdp:retry-legacy',
  rdpNativeStatus: 'rdp:native-status',
  rdpRelease: 'rdp:release',
  rdpGetError: 'rdp:get-error',
  rdpClipboardRead: 'rdp:clipboard-read',
  rdpClipboardWrite: 'rdp:clipboard-write',
  rdpClipboardFiles: 'rdp:clipboard-files',
  rdpLaunchSystemClient: 'rdp:launch-system-client',

  /* 代理 */
  proxyTest: 'proxy:test',

  /* 公共凭据 */
  credentialProbeStart: 'credential-probe:start',
  credentialProbeNext: 'credential-probe:next',
  credentialProbeFinish: 'credential-probe:finish',
  credentialProbeCancel: 'credential-probe:cancel',
  credentialProbeApply: 'credential-probe:apply',
  sharedList: 'shared:list',
  sharedSave: 'shared:save',
  sharedDelete: 'shared:delete',
  sharedUsage: 'shared:usage',

  /* 系统 VPN */
  vpnList: 'vpn:list',
  vpnConnect: 'vpn:connect',
  vpnDisconnect: 'vpn:disconnect',

  /* XTerminal 配置导入 */
  xtScan: 'xt:scan',
  rdoScan: 'rdo:scan',
  xtApply: 'xt:apply',
  configurationPasswordStatus: 'configuration:password-status',
  configurationSavePassword: 'configuration:save-password',
  configurationExport: 'configuration:export',
  configurationImport: 'configuration:import',
  webdavConfiguration: 'webdav:configuration',
  webdavSave: 'webdav:save',
  webdavTest: 'webdav:test',
  webdavUpload: 'webdav:upload',
  webdavDownload: 'webdav:download',

  /* 端口转发 */
  forwardList: 'forward:list',
  forwardSave: 'forward:save',
  forwardDelete: 'forward:delete',
  forwardStart: 'forward:start',
  forwardStop: 'forward:stop',
  forwardStatus: 'forward:status',

  /* 监控 */
  metricsProbe: 'metrics:probe',
  metricsCollect: 'metrics:collect',

  /* 对外能力 */
  externalGetConfig: 'external:get-config',
  externalSetEnabled: 'external:set-enabled',
  externalCreateToken: 'external:create-token',
  externalRevokeToken: 'external:revoke-token',
  externalApproveRequest: 'external:approve-request',

  /* 主进程 → 渲染进程 的推送 */
  push: {
    aiChanged: 'push:ai-changed',
    aiMetadataChanged: 'push:ai-metadata-changed',
    updatesChanged: 'push:updates-changed',
    connectionChecksChanged: 'push:connection-checks-changed',
    sessionEvent: 'push:session-event',
    sshData: 'push:ssh-data',
    sshClose: 'push:ssh-close',
    hostKeyPrompt: 'push:host-key-prompt',
    transferProgress: 'push:transfer-progress',
    forwardStatus: 'push:forward-status',
    forwardError: 'push:forward-error',
    externalApprovalRequest: 'push:external-approval-request'
  }
} as const

/** 主进程主动推送给渲染进程的事件名（反向通道） */
export type PushChannel = (typeof IPC.push)[keyof typeof IPC.push]
