# 从源码构建 OmniDesk 0.6.44

## 环境与开发

- Node.js 22+、npm、Git。
- Go 1.26+：默认构建会编译 Linux amd64、Linux arm64 和 Windows amd64 监控采集端。Go 依赖从公开模块源获取。
- Windows 原生桌面另需 MSYS2 UCRT64、GCC、OpenSSL、zlib 和 CMake，见 [FreeRDP 说明](FREERDP.md)。

~~~powershell
npm ci
npm run typecheck
npm run build
npm run dev
~~~

采集端源码在 monitor-agent/，构建脚本默认使用这个目录。OMNIDESK_MONITOR_SOURCE 可覆盖源码目录。该目录只包含采集端、协议定义和相关单元测试，不依赖账号或监控服务端。npm run build 会检查固定 RDP WASM 摘要并构建主进程、preload 与界面；不需要连接任何真实服务器。

npm ci 默认运行依赖自己的安装脚本。源码审查或只进行构建验证时可使用 npm ci --ignore-scripts；此时 Electron 运行时未下载，启动和打包前需显式完成 Electron 安装。

## Windows 安装包

~~~powershell
npm run build:freerdp
npm run build
npx electron-builder --win --x64 --publish never
node tools/verify-release.cjs
~~~

FreeRDP 固定上游 3.32.2。工具链位置可通过 OMNIDESK_MSYS2、OMNIDESK_OPENSSL_ROOT 和 OMNIDESK_CMAKE 配置。输出在 release/0.6.44/，不要将 out/、tmp/、release/ 或个人配置提交。

源码中的公开快照调整了采集端构建目录、关闭 Go VCS 元数据写入，并补充独立测试初始化和文档；客户端运行源码和原生辅助源码与 0.6.44 已验证安装包对应。不同编译器、Go / Electron 版本及构建元数据可能产生不同的二进制摘要。

## 验证

~~~powershell
npm run typecheck
node tools/verify-docker.cjs
cd monitor-agent
go test ./cmd/agent ./internal/agent ./protocol
cd ..
~~~

Docker 服务测试在 Windows 上默认使用 Git for Windows 的 Bash，可通过 OMNIDESK_QA_BASH 指定本地 POSIX shell。它启动回环 SSH peer 和假 Docker CLI，不访问真实 Docker daemon。

界面测试 tools/verify-docker-ui.cjs 另需 Playwright 与可启动的 Electron。可在单独目录安装 Playwright，通过 NODE_PATH 引用，再将 OMNIDESK_QA_EXE 指向已构建的 OmniDesk.exe。测试使用隔离用户目录和合成数据。其他 verify 脚本可能需要 Windows 原生运行库、指定平台或相应工具，请先阅读脚本及 [验证记录](VALIDATION-0.6.44.md)。

## 配套后端与源码同步

统一后端见 [omnidesk-server](https://github.com/jixn-hu/omnidesk-server)，部署见 [后端部署指南](https://github.com/jixn-hu/omnidesk-server/blob/main/docs/DEPLOYMENT.md)。客户端可以独立克隆和构建。需要联调时，把两个仓库放在同一父目录。采集端的开发源位于后端 `monitor/`；执行 `node tools/sync-monitor-agent.cjs` 更新本仓库的 `monitor-agent/`，使用 `--check` 只检查一致性。
