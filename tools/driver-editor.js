// 驱动界面：解锁 → 切深色 → 打开新建连接 → 选 RDP → 填字段
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

  // 阶段一：解锁
  const pw = document.querySelector('input[type="password"]')
  if (pw) {
    setValue(pw, 'omnidesk-test-2026')
    click('解锁')
  }

  // 阶段二：等主界面出现后打开编辑器
  setTimeout(() => {
    document.documentElement.dataset.theme = 'dark'
    click('新建第一个连接') || click('＋')
    setTimeout(() => {
      click('RDP · Windows')
      setTimeout(() => {
        const inputs = [...document.querySelectorAll('.modal input')]
        if (inputs[0]) setValue(inputs[0], '生产环境 Windows Server')
        if (inputs[1]) setValue(inputs[1], '192.0.2.25')
        if (inputs[3]) setValue(inputs[3], 'Administrator')
        if (inputs[4]) setValue(inputs[4], '运维组')
      }, 250)
    }, 300)
  }, 1500)

  return 'started'
})()
