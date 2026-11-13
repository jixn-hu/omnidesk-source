# OmniDesk 0.6.44 验证

日期：2026-11-13，Windows 本地验证。

- TypeScript 检查与生产构建通过；构建从仓库内 monitor-agent/ 读取采集端源码，不依赖旧同级目录。
- verify-app-updates.cjs 通过：新 GitHub API 地址、打包发布配置、匿名请求、旧缓存地址迁移、版本比较、超时和错误处理。
- Windows x64 安装版与便携版构建成功。verify-release.cjs 通过：ASAR 与 14 个生产构建文件一致，新仓库元数据、原生运行库、采集端摘要与许可证、安装包和便携版 PE、更新 SHA512，以及隔离配置下便携 EXE 的实际启动与渲染。
- verify-settings-sections-ui.cjs 在开发构建和 0.6.44 成品 EXE 都通过：关于与软件更新中的两个开源链接均通过实际点击调用系统浏览器；展开状态、更新提示、深浅主题、窄窗、账号与本地连接数据回归通过，无渲染错误。
- verify-monitor-resources.cjs、verify-monitor-agent-install.cjs、verify-account-sync.cjs 通过，移动后的资源路径和客户端/统一后端联调有效。
- 客户端采集端 go test ./cmd/agent ./internal/agent ./protocol 通过；sync-monitor-agent.cjs --check 的 14 个采集端/模板文件一致。
- 统一后端 go test ./...、go vet ./... 通过；Node.js 47 项测试通过、0 跳过，包括实际 Windows Agent 通过统一入口上报。地址脱敏调整后 GitLab 专项及统一入口专项再次通过。

本次没有连接或重新部署用户生产后端。Windows 安装包未数字签名。历史仓库与安装包迁移结果以 GitHub Release、发布验证脚本及后端 CI 记录为准；原本地开发记录、数据和旧 Git 历史保留在忽略目录或外部备份，不随开源发布。
