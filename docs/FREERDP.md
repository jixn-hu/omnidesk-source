# FreeRDP 内置桌面

更新日期：2026-11-09。当前版本 0.6.43。Windows x64 内置桌面默认使用 FreeRDP；旧配置保留兼容读取，系统客户端入口仍可使用。远端文件复制采用 Windows OLE 虚拟文件，本机粘贴请求内容时才下载，无需手动接收。每个文件先完整缓存后交付只读流。

## 使用方式

下述能力包含于当前 0.6.43 安装包；旧版本需完整升级。

1. Windows x64 直接打开原有 Windows / RDP 连接即可使用 FreeRDP，无需逐台切换引擎。
2. 通常保留「TLS / NLA 优先」。原生连接在安全协商或 `ERRCONNECT_TLS_CONNECT_FAILED` 阶段失败时，会追加不含登录凭据的 X.224 探测；只有明确得到 `SSL_NOT_ALLOWED_BY_SERVER`（代码 2）或 Standard RDP Security 响应，才提示是否兼容。用户同意后只将当前服务器保存为旧版模式并自动重连；取消则保留 TLS / NLA，未同意前不会发起旧版登录。TLS 错误本身不是降级依据；明确的账号、证书拒绝和已连接后的运行时错误不进入自动兼容。
   - 后台标签失败时保留待检测状态，切回后继续，不再直接漏掉提示。确认框属于发起连接的窗口，而不是固定弹到主窗口。
   - 服务器接受 TLS / NLA 协商时，显示未发现仅支持旧版安全层的证据；探测失败、响应异常或服务器缺少 TLS 证书时保留具体原因，并可通过「重试」重新连接检测，不静默当成不需要兼容。
   - TLS 通用错误不再被误译成「证书未受信任或身份验证被取消」。不会自动忽略证书、降低 TLS 算法要求或修改服务器 NLA。
3. 可以手动选择「旧版 RDP 安全层」。首次使用需确认风险，确认记录只保存在本机 `rdp-legacy-consent.json`，绑定连接 ID、地址、端口、代理和账号引用；以后同一目标无需重复确认。导入 / 共享不会携带授权记录，地址或账号变化会重新确认；TLS 优先模式再次触发兼容时始终重新询问。旧版模式不使用 TLS / NLA，存在安全风险，请先确认目标可信；不会修改服务器策略或关闭 NLA。会话工具栏显示「旧版安全层」，可在配置中改回推荐模式。
4. 引擎未构建、依赖缺失或非 Windows x64 时，界面明确提示；不会偷偷降低安全层。系统客户端仍可使用。
5. 三档画质仍按窗口、DPI 和像素上限自动计算。原生画布额外限制为 8192 × 8192 范围内、总计不超过 16M 像素，桌面缩放 100–200%，DeviceScaleFactor 固定 100。目标没有 Display Control 时保留已协商的桌面尺寸，不因放大窗口而断开。

### 运行时中断与原会话恢复

从 0.6.26 开始，已建立的 FreeRDP 会话只有在纯传输错误、没有服务端错误信息且有有效 ARC Cookie 时才恢复原会话：最多三次、退避 1/2/4 秒、总窗口 45 秒。收到其他连接接管、注销、管理员断开、ARC 拒绝或不同登录 ID 时停止；缺少 Cookie 时直接结束。恢复失败不回退普通密码登录。

NLA 认证沿用原凭据，恢复的 Client Info 不设置 `INFO_AUTOLOGON`，也不发送普通用户名/域/密码。只有收到同一 ARC 登录 ID 的服务端恢复确认才结束恢复状态。恢复期间保留最后画面，暂停输入/剪贴板/分辨率发送，可点击“停止重连”；已连接后的传输错误不进入 TLS/NLA 降级流程。

主进程在用户数据目录 `logs/freerdp-diagnostics.jsonl` 写入受限数值诊断，最多 1 MiB 加一份轮转，不持久化密码、ARC Cookie、剪贴板或屏幕数据。验证命令为 `node tools/verify-rdp-safe-resume.cjs`，具体证据与边界见 [0.6.26 验证](VALIDATION-0.6.43.md)。
### 双向文件剪贴板

- 保持连接配置的「剪贴板重定向」开启，保存后重新连接；TLS / NLA 和明确选择的旧版安全层均接入相同文件通道，不额外开放端口。
- 本机 → 远端：在本机文件管理器复制文件或文件夹，聚焦远端文件管理器后按 Ctrl+V / Shift+Insert，或点击工具栏「粘贴」。只在明确粘贴时读取本机文件列表，不会在切换标签或收到服务器请求时自行枚举本机磁盘。远端右键菜单的粘贴不负责首次发布本机文件列表，请先用快捷键 / 工具栏。
- 远端 → 本机：远端复制文件 / 文件夹后，获取并校验描述符，以 Windows OLE `IDataObject` 发布 `FileGroupDescriptorW` 和索引 `FileContents`。读取格式或文件列表不会下载内容；本机粘贴目标请求某文件的 `IStream` 时，才分块下载该文件到临时缓存，再提供只读流。不再提供手动接收按钮。单个文件会先完整缓存后交付流，尚未实现边下载边读取。
- 远端内部复制 / 粘贴：保存远端格式对应的本机剪贴板序列号，并在 OLE 发布后更新该序列号。本机未重新复制时，Ctrl+V / Shift+Insert 只向服务器发送粘贴快捷键，不公告本机旧文件、文字或空格式，也不触发下载。新的远端复制、取消或会话断开会撤销旧虚拟文件对象；本机重新复制后以新内容为准。
- 支持多选、嵌套 / 空目录、空文件、中文和 emoji 名称，显示进度并可取消。这里只做复制，不执行源文件删除；不支持剪切移动、拖拽、图片格式或映射本机磁盘。
- 单次最多 4096 个文件和目录、合计 16 GiB，相对路径最多 259 个 UTF-16 字符。64 位大小和偏移有协议 / 单元测试，但未实际传输数 GiB 的生产文件；大于 4 GiB 的文件要求对端协商 Huge File 支持。下载采用 256 KiB 分块，文件读取请求等待 30 秒超时；下载前检查空间并要求额外预留 512 MiB。
- 远端文件名按不可信输入处理：拒绝路径越界、绝对 / UNC 路径、ADS、设备名、链接和大小写冲突。失败 / 取消清理不完整缓存，不写入用户选定目录；虚拟文件发布前校验剪贴板序列，避免覆盖本机新复制的内容。另一会话发起复制会取消旧的未完成下载，避免跨标签抢写。
- 已完成的缓存保留在系统临时目录 `omnidesk-rdp-files/copy-*`，同一轮重复粘贴复用缓存；取消会移除未完成文件。新的下载会清理超过 24 小时且未使用的旧缓存。虚拟剪贴板依赖当前会话，断开后未读取的内容不可继续获取；已经交付的本机流可独立完成读取。缓存以明文存放。
- 0.6.4 原生辅助进程协议为 4（0.6.3 为 3，0.6.2 为 2），Windows 文件剪贴板写入返回锁内取得的新序列号，文件清理不再重新公告缓存格式。必须同时使用新版应用与完整运行库，不能只替换 EXE / ASAR 或混用旧运行库；协议不匹配会拒绝启动。

## 架构与安全边界

- 0.6.5 原生辅助进程协议升级为 5，新增 `PTR_XFLAGS_BUTTON1/2` 扩展鼠标转发及五键释放。标准 / TLS / NLA 都使用协商后的扩展鼠标与横向滚轮能力，服务器不支持时由 FreeRDP 跳过，不将其视为认证失败。需要完整安装包，不能复用 0.6.4 的协议 4。
- 渲染端转发鼠标侧键并阻止本机 auxclick 导航；通过 PointerEvent 的 `buttons` 位图补齐同时按键变化。横 / 纵滚动按像素、行、页归一化，保留小数余量并拆分到协议范围内，零增量不产生反向滚动，后台或黑边不发送。Ctrl+Shift / Meta 组合不再被笼统拦截，但本机操作系统保留键仍有平台限制。

- 渲染进程复用现有键鼠 / IME / 失焦释放 / 前台剪贴板隔离；新的适配器仅把设备事件编码为本机二进制协议，并把 RGBA 脏矩形绘到 canvas。
- 主进程在 127.0.0.1 临时端口提供单次随机令牌 WebSocket，每个会话独立子进程。令牌一分钟过期；目标、账号、密码、代理只能由主进程决定，渲染端不能改成任意服务器或注入配置命令。
- 辅助进程使用固定版本 FreeRDP SDK，接收 stdin 配置，stdout 只输出有界帧、光标、文本 / 文件剪贴板事件与错误枚举。文件列表 / 数据仅交由主进程处理，不经渲染端或账号服务；渲染端只能请求当前会话的粘贴 / 接收 / 取消，不能注入本机路径或原生文件命令。正式构建关闭 FreeRDP 原始日志，主进程不转发 stderr，避免日志泄漏账号或认证材料。
- FreeRDP 密码不进入命令行、环境变量、临时文件或渲染进程；配置缓冲写入后擦除。子进程继承有限环境，不继承系统代理配置；HTTP / SOCKS5 仅使用该连接显式配置。SOCKS4 明确拒绝，不静默绕过代理。
- 关闭「忽略证书错误」后，通过原有身份确认窗口核对 PEM 叶证书指纹、有效期和目标；可选择本次信任或记住。当前原生通道采用指纹确认，不声称已经完成 Windows CA 的离线完整链验证。拒绝证书会阻止 NLA 认证。
- 普通模式明确禁用 RDP 安全层，只允许 TLS / NLA；旧版兼容需要用户确认。安全协商错误枚举来自主进程的真实原生会话，追加探测不携带用户名或密码，并使用原连接的代理；渲染端不能用伪造错误文字、其他服务器会话或已关闭会话触发回退。每次失败最多询问一次，不循环重试；配置变化、标签关闭会中止回退。
- 传输有输入队列、消息长度、像素数量和积压上限及背压；关闭标签、取消握手、主进程退出或通道断开都会清理辅助进程。一个会话的异常不会关闭其他会话。

## 本机通信与安装故障

应用内 FreeRDP 的本机 WebSocket 由受限的 preload Node 通道直连 `127.0.0.1`，不再经过 Chromium 的系统代理配置或浏览器本地网络权限。接口只接受 FreeRDP 固定路径、合法会话 ID 和单次 token，不允许远端主机、任意路径、URL 用户名 / 密码、重复参数或重定向；页面卸载时关闭本机连接。远程服务器的 SSH / RDP 连接代理仍按各连接的原配置执行。

旧版「FreeRDP 本机通信失败，请检查辅助进程运行库」来自界面的 WebSocket `onerror`，无法据此判断是否缺 DLL。已在 0.6.6 目录包中复现 Chromium 代理接管回环连接时出现相同的通信失败；这不是对所有外部电脑实际代理配置的确认。新版区分本机监听失败、握手失败以及辅助程序启动失败，不在错误中显示通道 token。

首次连接前会在限制 PATH 的环境运行辅助程序 `--version`，实际检查能否启动及协议是否匹配；同一进程内成功后复用结果。缺失的包内文件会显示文件名；Windows 加载器错误显示状态码，例如 `0xC0000135`（缺 DLL）、`0xC000007B`（架构或映像错误）、`0xC0000142`（初始化失败）。分发应使用完整安装包或便携包；从安装目录单独拷贝主程序不会包含外置的 `resources/freerdp/` 和应用资源。

复现与回归使用隔离 profile，不改用户系统代理：

```powershell
node tools/verify-native-transport.cjs
$env:OMNIDESK_QA_BLOCK_BROWSER_LOOPBACK = '1'
node tools/verify-rdp-auto-compat.cjs
```

## 本机构建

需要 Windows x64、Node / npm、Git、CMake、MSYS2 UCRT64 GCC、OpenSSL、zlib。请先按 MSYS2 官方流程**整体更新**环境，不使用过期 pacman 数据库进行局部升级。脚本不安装或修改系统软件。

```powershell
npm run build:freerdp
npm run build
npm run dev
```

默认工具前缀为 `C:/msys64/ucrt64`，可用 `OMNIDESK_MSYS2` 覆盖；CMake 可用 `OMNIDESK_CMAKE` 指向完整 exe。开发机临时 Python CMake wheel 路径仅作已安装工具的备选，不要求用户安装 Python。

### 独立 OpenSSL 前缀

0.6.1 原生运行库使用 OpenSSL **3.6.5**。打包前拒绝低于此基线的 3.x 前缀，后续发布仍需重新检查依赖安全更新；这不是永久安全保证。`OMNIDESK_OPENSSL_ROOT` 可指定独立、完整的 UCRT64 OpenSSL 前缀，不更改本机 MSYS2 安装，也不执行 pacman 局部升级；配置同时绑定其头文件、导入库、运行 DLL、legacy provider 和许可证。

本次使用 MSYS2 官方包 `mingw-w64-ucrt-x86_64-openssl-3.6.5-1-any.pkg.tar.zst`，SHA-256 为 `773e021ebad83f14b5c103db467411e8ff064663e1c7e7f730e2be72f4117064`。可从 [MSYS2 软件包页面](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-openssl) 获取包并核对上游校验和；解压到临时目录后，将变量指向其中的 `ucrt64`，不是其 `bin`。

```powershell
$env:OMNIDESK_OPENSSL_ROOT = (Resolve-Path 'tmp/openssl-release-3.6.5/ucrt64').Path
npm run build:freerdp
npm run typecheck
npm run build
npx electron-builder --win --x64 --publish never
node tools/verify-release.cjs
```

固定依赖为 FreeRDP **3.32.2**，commit **97eff6ddfbbfaa8e42a126d362686bd001ff8bdc**。首次从官方仓库下载到 `tmp/freerdp-source`，不将上游源码提交本仓库；已存在目录的 commit 必须完全匹配。`tools/patch-freerdp-resume.cjs` 仅允许两个经过校验的恢复补丁：`libfreerdp/core/info.c` 在恢复时禁止普通 Client Info 自动登录/凭据回退，`libfreerdp/core/rdp.c` 将 ARC_STATUS 作为恢复拒绝处理。构建脚本验证原文件与精确补丁结果，拒绝其他上游源码变更。

构建约束：GCC / MinGW 使用 Windows TLS 而非缺失的 C11 `threads.h`，关闭 Unix unwind。上游 `locale/keyboard.c` 的 `DWORD*` / `UINT32*` 在此工具链均为 32 位，但 GCC 15 默认将其类型差异视为错误；仅依赖库将此诊断保留为警告，自有宿主仍以 `-Wall -Wextra -Werror` 编译。除上述两处恢复补丁外不修改上游源码。只构建客户端需要的 cliprdr / drdynvc / disp / rdpgfx，未启用磁盘、打印机、智能卡、音频等重定向。

输出位于 `out/native-freerdp/`，包含 exe、实际依赖 DLL、OpenSSL legacy provider、许可证和 SHA-256 清单；manifest 同时记录 OpenSSL / GCC 版本。legacy provider 是 NTLM / RDP 授权所需，不表示会自动启用旧 RDP 安全层。发布前仍应检查并更新构建环境的 OpenSSL 等依赖。

从 0.6.2 开始，CMake 使用通用逻辑安装前缀 `C:/OmniDesk`，通过 `CMAKE_STAGING_PREFIX` 将 SDK 实际安装到工作区临时目录，不创建或写入该逻辑路径，避免 WinPR 的资源路径常量暴露开发机目录。构建脚本会在所有原生 EXE / DLL 中检查工作区和用户目录的 UTF-8 / UTF-16LE 路径，匹配则阻止出包；不得通过二进制搜索替换篡改 DLL。

```powershell
npm run dist:win
```

Windows 打包前检查清单、哈希和许可证；普通开发构建不要求原生工具链。运行库位于安装目录 `resources/freerdp/`，不放入 ASAR，也不打包 C/C# 源码、账号服务、测试 profile 或个人配置。旧 ActiveX 原型不参与本实现、公开源码快照或打包。

## 验证

Playwright 为开发验证依赖，可通过 `NODE_PATH` 指向独立测试安装；默认使用系统 Edge，`OMNIDESK_QA_BROWSER` 可覆盖可执行路径。Electron 界面测试使用隔离 profile，`OMNIDESK_QA_EXE` 可选择目录测试包中的 exe。

```powershell
npm run typecheck
node tools/verify-rdp-security.cjs
node tools/verify-rdp-auto-compat.cjs
node tools/verify-freerdp.cjs
node tools/verify-freerdp-files.cjs
node tools/verify-freerdp-ui.cjs
node tools/verify-rdp-input.cjs
node tools/verify-rdp-clipboard.cjs
node tools/verify-rdp-profiles.cjs
node tools/verify-rdp-negotiation.cjs
node tools/verify-rdo-import.cjs
```

原生测试不是仅 mock：会编译只绑定回环地址的 FreeRDP peer，使用一次性自签名证书、合成 SAM 用户和假密码，完成真实 TLS、NLA / NTLM、Standard RDP Security、bitmap、输入、cliprdr、drdynvc / disp 协议交互；再用浏览器完成 canvas → WebSocket → 主进程 → 辅助进程 → peer 的往返。

已验证：证书接受 / 拒绝先于 NLA、错误密码拒绝、无自动旧安全层降级、RGBA 颜色 / 脏矩形、中文及 UTF-16 代理对、键鼠释放、双向 Unicode 文本剪贴板、动态分辨率回执与合法 DPI、并行会话隔离、坏令牌 / 配置注入拒绝、进程退出 / 崩溃、编辑保存重开、备份选项保留。另回归 RDO、IronRDP 输入与剪贴板、系统客户端配置 / Windows 临时凭据恢复，以及回环 SSH / SFTP / 端口转发和本机 WebDAV。

文件专项验证：真实回环 TLS、NLA / NTLM 和 Standard RDP Security 的 cliprdr 文件格式 / SIZE / RANGE PDU，双向多 MiB 文件校验、目录与空文件、64 位偏移单元测试、取消、大小 / 路径边界、剪贴板变更保护、多会话隔离；使用私有 Windows window station 测试真实 CF_HDROP 读写及序列号原子检查，不改用户剪贴板。浏览器复用实际 DesktopView 回调、按需文件处理器、React 提示组件和键盘绑定，验证复制 / 关闭提示不请求描述符和内容、不创建缓存，只有目标请求文件内容才下载；覆盖远端内部粘贴、后台会话限制、同一份复制失败后重试、远端改复制文字清除旧提示以及本机文件 Ctrl+V。文本单元测试覆盖远端文件已复制时不自动发布旧文字、新复制相同文字仍能粘贴，以及剪贴板变化取消旧异步操作。

尚未验证：新增文件功能在实际 Windows 主机上的行为、各种域 / Kerberos / MFA / RD Gateway、生产 HTTP / SOCKS5 代理、H.264 / 多屏和长时间高负载稳定性。初版不支持音频、图片剪贴板、磁盘 / 打印机 / 智能卡重定向，不承诺比现有引擎更快。只要这些兼容性验证未完成，就应保留实验性标识与 IronRDP / 系统客户端回退。

客户端加密备份 / 账号同步保留引擎设置。共享配置需独立账号服务同时更新白名单；客户端发布不会自动部署独立账号服务或修改线上数据库。安装与发布范围见 [0.6.26 更新说明](RELEASE-0.6.26.md)。
