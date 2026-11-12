# OmniDesk

连接 Windows 与 Linux 的远程工作台。客户端和监控采集端以 [MIT](LICENSE) 开源。

## 下载

当前版本 **0.6.43**（2026-11-12）：[Windows x64 安装包](https://github.com/jixn-hu/omnidesk-releases/releases/tag/v0.6.43)。安装包未数字签名，请核对 Release 同页的 SHA256SUMS.txt。升级前在「设置 → 备份」导出加密备份，结束会话并退出旧版后安装。

[更新说明](docs/RELEASE-0.6.43.md) · [用户指南](docs/USER-GUIDE.md) · [构建指南](docs/BUILDING.md) · [验证范围](docs/VALIDATION-0.6.43.md)

## 主要功能

- **SSH / SFTP**：密码、私钥与 SSH Agent；主机密钥确认、多标签终端、搜索、上传下载、远程文件编辑和拖拽。
- **Windows RDP**：内嵌 FreeRDP，文本和文件剪贴板、代理与证书确认。传输中断只在有效恢复条件下尝试恢复原会话，接管或注销时停止，避免挤掉其他登录用户。
- **Docker**：Linux SSH 会话右侧「文件」下方的入口，查看和搜索容器、镜像，展开详情并删除资源。运行中的容器需先停止；删除前确认服务器、名称与完整 ID。未安装、无权限或服务不可达分别提示。复用当前 SSH 连接，不开放 Docker 网络端口。
- **监控**：SSH 会话按需读取系统状态；可选择独立监控后台，安装 Linux / Windows 采集端持续上报。支持批量安装、覆盖安装及上报间隔配置。
- **连接管理**：目录、标签、备注、公共凭据、代理和多个独立会话。
- **备份与账号**：「设置 → 备份」管理本地文件、WebDAV 与恢复；侧栏「账号」管理多个自建服务账号及切换。本机 SSH / RDP 不要求登录账号。
- **AI 与外部调用**：可配置模型进行有权限控制的查询和操作；HTTP API / MCP 复用服务层，敏感操作需确认。

![Docker 侧栏，使用本地隔离测试数据](docs/images/docker-0.6.43.png)

## 构建

需要 Node.js 22+、npm、Git 与 Go 1.26+。默认构建会从仓库内 monitor-agent/ 编译 Linux amd64 / arm64 和 Windows x64 采集端，不依赖私有项目目录。

~~~powershell
git clone https://github.com/jixn-hu/omnidesk-source.git
cd omnidesk-source
npm ci
npm run typecheck
npm run build
npm run dev
~~~

Windows 原生 FreeRDP 构建和安装包制作还需要 MSYS2 / CMake，见 [构建指南](docs/BUILDING.md) 与 [FreeRDP 说明](docs/FREERDP.md)。

## 源码与许可

本仓库包含 Electron 客户端、原生辅助源码、监控采集端及安装脚本。账号与监控服务端独立部署，其源码不在本仓库中；客户端服务地址默认留空，由使用者自行配置。第三方依赖的许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

问题反馈请附版本、系统和复现步骤，删除日志中的凭据、服务器地址及个人信息。参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。
