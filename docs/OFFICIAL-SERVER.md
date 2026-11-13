# 自建 OmniDesk 统一后端

后端已统一为一个开源仓库：[jixn-hu/omnidesk-server](https://github.com/jixn-hu/omnidesk-server)。账号、配置同步、共享服务器、浏览器管理后台和监控都通过同一个地址提供服务。

请按 [后端部署指南](https://github.com/jixn-hu/omnidesk-server/blob/main/docs/DEPLOYMENT.md) 构建并启动容器，创建管理员、配置 HTTPS，然后在 PC 的“账号”填写该地址并登录。启用云端监控后即可安装 Linux / Windows 采集端。

SSH / RDP 本地连接可独立使用。客户端源码与 Windows 安装包均在 [omnidesk](https://github.com/jixn-hu/omnidesk)，PC“设置 → 关于 / 软件更新”中可打开两个仓库。
