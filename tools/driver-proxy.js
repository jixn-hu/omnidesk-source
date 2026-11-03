// 驱动界面：解锁 → 开新连接编辑器 → 切 SOCKS5 代理 → 截图
(() => {
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const click = (text) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text))
    if (el) {
      el.click()
      return true
    }
    return false
  }

  document.documentElement.dataset.theme = 'dark'

  const pws = [...document.querySelectorAll('input[type="password"]')]
  if (pws.length >= 2) {
    // 首次运行：需要设置主密码（两个框都要填）
    setValue(pws[0], 'omnidesk-test-2026')
    setValue(pws[1], 'omnidesk-test-2026')
    click('创建保险箱')
  } else if (pws.length === 1) {
    // 已有保险箱：解锁
    setValue(pws[0], 'omnidesk-test-2026')
    click('解锁')
  }

  setTimeout(() => {
    document.documentElement.dataset.theme = 'dark'
    click('新建第一个连接') || click('＋')
    setTimeout(() => {
      const inputs = [...document.querySelectorAll('.modal input')]
      if (inputs[0]) setValue(inputs[0], '海外跳板机')
      if (inputs[1]) setValue(inputs[1], '203.0.113.42')
      if (inputs[3]) setValue(inputs[3], 'root')
      // 切到 SOCKS5 代理
      setTimeout(() => {
        click('SOCKS5')
        setTimeout(() => {
          const after = [...document.querySelectorAll('.modal input')]
          // 代理地址/端口在表单靠后位置
          const labels = [...document.querySelectorAll('.modal .field-label')]
          const proxyHostIdx = labels.findIndex((l) => l.textContent.includes('代理地址'))
          if (proxyHostIdx >= 0) {
            const allFields = [...document.querySelectorAll('.modal .field')]
            const hostField = allFields.find((f) =>
              f.querySelector('.field-label')?.textContent.includes('代理地址')
            )
            const portField = allFields.find((f) =>
              f.querySelector('.field-label')?.textContent.includes('端口') &&
              f.querySelector('input')?.placeholder === '1080'
            )
            if (hostField) setValue(hostField.querySelector('input'), '127.0.0.1')
            if (portField) setValue(portField.querySelector('input'), '1080')
          }
        }, 300)
      }, 200)
    }, 300)
  }, 1500)

  return 'started'
})()
