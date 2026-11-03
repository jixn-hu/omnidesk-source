# OmniDesk 0.6.15 本地构建验证

日期：2026-11-03。Windows x64；本地安装版和便携版已生成。

## 变更

- 连接目录支持拖入同协议文件夹、移回未分组、拖入标签添加分类，保留凭据和其他选项。
- 五种目录视图及地址、账号、标签、备注开关，保存偏好并保持默认紧凑显示。
- SFTP 支持本机拖入递归上传、远程目录间移动和 Windows 本机拖出下载。上传与移动保护同名目标；拖放提示位于底部，不改变目标位置或遮挡目录名称。
- Windows 远程文件采用 OLE 虚拟文件描述符与按需 IStream，不再显示待接收提示或接收按钮。远端内部粘贴保留服务端格式；本机目标消费内容时才传输。取消移除不完整缓存。
- README、用户指南、同事介绍及九张演示截图同步更新；同事资料 ZIP 与 Markdown / 图片一致。

## 构建

- package.json、package-lock.json 顶层和根包版本：0.6.15。
- npm run typecheck、npm run build 通过，日志为 tmp/drag-typecheck.log 和 tmp/drag-build.log。
- 原生辅助进程从 host.c、file-clipboard.c、virtual-files.c 编译，开启 Wall / Wextra / Werror；链接 ole32、uuid、shlwapi。FreeRDP 3.32.2、协议 5、OpenSSL 3.6.5，更新 helper 的 manifest 摘要。复用原有依赖 SDK，未重新编译依赖。
- electron-builder 使用本机同版本 Electron 44.7.2：--win --x64 --publish never --config.electronDist=node_modules/electron/dist。日志：tmp/package-0.6.15.log。
- 原有 0.6.14 安装包摘要仍为 0511838ec98a9276901e609e233f6859a0a865d193aa137ecf7c54819c190e9e。

## 验证

| 范围 | 结果与证据 |
| --- | --- |
| 成品目录 UI | tmp/release-0.6.15-directory.log：文件夹及协议根拖放、标签添加且保留原标签、其他配置逐字段保留、五种视图、显示开关、重启、搜索、折叠及窄窗口通过；隔离 profile tmp/sidebar-tree-ui-71QRF8 |
| 成品 SSH / SFTP UI | tmp/release-0.6.15-sftp.log：真实回环 SSH/SFTP 的拖入上传、移动、父目录拖放、同名拒绝、提示出现前后目标边界不变通过；文本编辑、文件菜单、终端路径拖入和监控回归通过；隔离 profile tmp/ssh-workspace-qa-gjXZls |
| 递归上传及竞争 | tools/verify-sftp-drag.cjs：中文嵌套目录、空目录 / 空文件、全量同名预检、并发创建后的 wx 保护、本机 junction 拒绝和移入自身子目录保护通过；tmp/sftp-drag-service-zuyByH |
| FreeRDP 协议与 UI 链路 | tmp/release-0.6.15-rdp-files.log：使用成品原生运行库，TLS、NLA、旧安全层、双向字节一致性、目录 / 空文件、取消、会话隔离及真实 DesktopView 回调链路通过；新流程验证无接收按钮、仅获取元数据、消费后才读内容；tmp/freerdp-files-qa-J5aGYO |
| Windows OLE | tmp/release-0.6.15-virtual.log：成品 helper 在私有 Windows station / desktop 创建真实剪贴板与 IStream；枚举格式和读取描述符不下载、元数据读取后序列号稳定、中文缓存路径、按需读取、缓存复用、过期准备撤销及取消清理通过；tmp/virtual-files-qa-KcTlLL |
| 文字剪贴板 | tools/verify-rdp-clipboard.cjs 通过；tmp/rdp-text-clipboard-drag-20261103.log |
| 外观回归 | tools/verify-appearance-ui.cjs 通过；tmp/appearance-drag-20261103.log，源构建隔离 profile |
| 原生隐私 | tools/verify-native-privacy.cjs 通过，拒绝夹带开发机路径 |
| 成品一致性 / 启动 | tmp/release-0.6.15-verification.log：ASAR 的 14 个构建文件逐项一致、版本与原生摘要 / 许可证 / 更新元数据正确、无个人配置或开发依赖；便携版在隔离 profile 实际启动并渲染；tmp/portable-0.6.15-VyDraT/portable-smoke.png |

成品目录、SFTP 拖放提示及便携版启动截图已人工查看。所有业务相关测试仅使用合成资料和本地服务。

## 产物

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| OmniDesk-0.6.15-win-x64.exe | 117533864 | ff7a6f1a1e0090f544c772e63007ac6d5c59c13c8964c18c65986fb0fe4e7e48 |
| OmniDesk-0.6.15-win-x64-portable.exe | 117303985 | 59e2e55df36c148a46784023c754741ea5e98a28e6cd8fc2fc09a57e9b0b8527 |

校验列表：release/0.6.15/SHA256SUMS.txt。版本和签名记录：tmp/release-0.6.15-metadata.json；安装版、便携版均未签名。

## 验证边界

未运行安装 / 卸载向导、全新 Windows 或生产服务器实测。Windows 资源管理器的实际粘贴和拖出操作尚未实测；OLE 接口、私有剪贴板与 RDP / SFTP 消费链路已单独验证，不能替代真实服务器验收。每个文件先完整缓存再交付 IStream，大文件首个内容请求仍可能等待；未实际传输数 GiB 文件。

上述记录针对本地成品验证。2026-11-03 后续获得上传 GitHub 与客户端开源授权，公开源码另在独立目录完成 npm ci、类型检查与生产构建；GitHub 发布和附件下载校验以发布记录为准。账号后台没有改动或部署。
