# 从源码构建 OmniDesk

当前版本：0.6.15。客户端以 MIT 开源；第三方依赖遵循各自许可证，见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

## 开发环境

- 推荐 Windows x64、Node.js 22 LTS、npm 与 Git。
- Windows 原生 RDP 需要 MSYS2 UCRT64 的 GCC、OpenSSL、zlib 和 CMake，详细命令与固定上游版本见 [FreeRDP 构建说明](FREERDP.md)。
- Node.js 依赖与原生运行库需要联网从各自公开上游获取；仓库不包含生成的二进制、个人配置或账号后台源码。

```powershell
git clone https://github.com/jixn-hu/omnidesk-source.git
cd omnidesk-source
npm ci
npm run typecheck
npm run build
npm run dev
```

上述前端 / 主进程构建无需 MSYS2。要在开发模式连接 Windows 内置桌面，先完成原生构建；SSH、SFTP 与界面开发不依赖原生 RDP 工具链。RDP 的兼容 WASM 依赖由锁文件固定，构建前自动检查摘要。

## Windows 安装包

在 MSYS2 UCRT64 安装构建依赖后，从 PowerShell 执行：

```powershell
npm run build:freerdp
npm run build
npx electron-builder --win --x64 --publish never
node tools/verify-release.cjs
```

默认 MSYS2 前缀为 `C:/msys64/ucrt64`，可用 `OMNIDESK_MSYS2`、`OMNIDESK_OPENSSL_ROOT`、`OMNIDESK_CMAKE` 指定本机工具位置。FreeRDP 源码固定为 3.32.2，构建脚本检查 Git 提交和工作区状态，并收集 DLL、许可证与摘要。

输出在 `release/0.6.15/`；`out/`、`tmp/`、`release/` 均不提交。安装包保持 `cn.omnidesk.app` 应用标识和既有用户数据路径；开发验证请使用隔离 profile。现有正式安装包未做代码签名。

## 测试

`tools/verify-*.cjs` 提供服务、协议与界面验证；不同脚本对 Windows、已构建原生组件、回环服务或 Playwright 有不同要求。界面验证可以单独安装 Playwright 并用 `NODE_PATH` 指向它，再用 `OMNIDESK_QA_EXE` 指向隔离测试包。请先阅读脚本及 [0.6.15 验证记录](VALIDATION-0.6.15.md)，不要用真实连接、账号或剪贴板内容代替测试夹具。

账号 / 配置同步连接用户自行配置的独立后台；服务地址默认留空。本仓库不包含可部署的官方账号后台，普通 SSH / RDP 连接不要求注册账号。
