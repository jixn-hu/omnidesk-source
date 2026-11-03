export function friendlyRdpError(raw: string): string {
  const detail = raw.toLowerCase()
  if (/ssl_not_allowed_by_server|standard_rdp_security|ssl_cert_not_on_server/.test(detail)) return raw
  if (/desktopscalefactor|desktop scale factor|displaycontrol|monitorlayout/.test(detail)) {
    return '远程桌面分辨率或缩放参数不符合协议要求。这是显示处理错误，不是端口、TLS 或账号认证失败。'
  }
  if (/wrongpassword|wrong password/.test(detail)) return '用户名或密码错误。请检查连接配置中的凭据。'
  if (detail.includes('logonfailure')) return '登录被拒绝。如果目标机启用了域账户，请填写「域」字段。'
  if (detail.includes('accessdenied')) return '权限不足。目标机可能限制了远程桌面登录的账户或并发会话数。'
  if (/proxyconnect|econnrefused|connection refused/.test(detail)) {
    return '无法连接到目标端口。请确认：\n· 目标机已开放 3389 端口\n· 系统属性中「远程桌面」已启用\n· 防火墙允许该端口'
  }
  if (/timeout|etimedout|10060/.test(detail)) return '连接超时。目标机可能不可达，或被防火墙静默丢弃。'
  if (detail.includes('errconnect_tls_connect_failed')) {
    return 'TLS 握手未成功；仅凭此错误不能确定是证书不受信任、协议版本或服务器安全策略问题，也不能断定目标只支持旧版安全层。不会自动忽略证书或关闭 NLA。'
  }
  if (detail.includes('negotiation')) return '协议协商失败。目标机可能仅支持较老的 RDP 安全层，或强制要求网络级身份验证（NLA）。'
  if (/certificate|证书/.test(detail)) {
    return '请按上方具体证书错误处理；如出现身份确认窗口，请核对 SHA-256 指纹后再决定是否信任。不会自动关闭证书校验或 NLA。'
  }
  return raw
}
