// 验证 SSH 认证报错是否可读
// 建一个「不填密码」的 SSH 连接并尝试连接：
//   预期看到「该连接还没有保存密码」而不是 ssh2 的
//   「All configured authentication methods failed」
(() => {
  const log = []
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const byText = (t, sel = 'button') =>
    [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().includes(t))
  const click = (t, sel = 'button') => {
    const el = byText(t, sel)
    if (el) {
      el.click()
      return true
    }
    return false
  }

  document.documentElement.dataset.theme = 'dark'

  let step = 0
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
    document.documentElement.dataset.theme = 'dark'
    if (ticks > 80) {
      clearInterval(timer)
      return
    }
    switch (step) {
      case 0:
        if (click('暂不设置')) {
          log.push('skipped')
          step = 1
        }
        break
      case 1:
        if (click('新建连接') || click('新建第一个连接') || click('＋')) {
          log.push('editor')
          step = 2
        }
        break
      case 2: {
        const modal = document.querySelector('.modal')
        if (!modal) break
        const inputs = [...modal.querySelectorAll('input')]
        // SSH 是默认类型：名称/主机/端口/用户名
        if (inputs[0]) setValue(inputs[0], 'SSH测试')
        if (inputs[1]) setValue(inputs[1], '127.0.0.1')
        if (inputs[2]) setValue(inputs[2], '2222')
        if (inputs[3]) setValue(inputs[3], 'root')
        // 故意不填密码
        if (click('保存')) {
          log.push('saved-no-password')
          step = 3
        }
        break
      }
      case 3:
        if (!document.querySelector('.modal')) {
          if (click('SSH测试', '.conn-item')) {
            log.push('opened')
            step = 4
          }
        }
        break
    }
  }, 400)

  window.__probe = () => ({
    log,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)
  })

  return 'started'
})()
