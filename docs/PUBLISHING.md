# OmniDesk 源码与安装包发布

从 0.6.44 起，只维护两个公开的 MIT 仓库：

- [omnidesk](https://github.com/jixn-hu/omnidesk)：PC 客户端源码、版本标签和 Windows 安装包 Releases。
- [omnidesk-server](https://github.com/jixn-hu/omnidesk-server)：统一后端，部署见 [部署指南](https://github.com/jixn-hu/omnidesk-server/blob/main/docs/DEPLOYMENT.md)。

客户端本地目录就是公开源码工作区，不再维护另一份源码副本或独立安装包仓库。内部记录在 `.local/`，个人数据、依赖、构建产物和环境文件不进 Git。

## 客户端发布

1. 修改源码，更新 package.json 与锁文件版本，并补充版本说明、验证记录。
2. 若采集端变化，先在相邻后端仓库修改并验证，再执行 `node tools/sync-monitor-agent.cjs` 更新客户端内置源码。用 `--check` 检查两边是否一致。
3. 运行类型检查、更新逻辑检查、相关测试及生产构建。打包前完成所需原生运行库构建。
4. 执行 `npx electron-builder --win --x64 --publish never`、`node tools/verify-release.cjs`、`node tools/prepare-public-release.cjs`。
5. 审查 Git 差异与敏感信息，提交并推送源码，创建对应版本标签。Release 必须指向该版本的源码提交。
6. 在 `jixn-hu/omnidesk` 创建草稿，上传 `release/<版本>/public/` 的安装包、blockmap、latest.yml、SHA256SUMS.txt 四个附件。便携版保留本地。
7. 执行 `node tools/verify-github-release.cjs` 校验草稿；通过后公开为正式 Release，再用 `--published` 验证匿名更新接口与安装包下载。

`src/shared/updates.ts`、package.json 的 build.publish 和验证脚本必须一致指向 `jixn-hu/omnidesk`。

## 旧版本迁移

旧公开安装包保留在本仓库的历史 Releases。0.6.43 及以前的已安装 EXE 内置旧更新地址；旧仓库清理后，请手动下载并安装 0.6.44 或更高版本，之后使用新的检查更新地址。既有用户数据与自建后端地址不受目录整理影响。
