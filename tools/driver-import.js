// 驱动界面：创建保险箱 → 打开 XTerminal 导入 → 截图
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
    setValue(pws[0], 'omnidesk-test-2026')
    setValue(pws[1], 'omnidesk-test-2026')
    click('创建保险箱')
  } else if (pws.length === 1) {
    setValue(pws[0], 'omnidesk-test-2026')
    click('解锁')
  }

  // 等主界面出来后打开导入对话框
  setTimeout(() => {
    document.documentElement.dataset.theme = 'dark'
    const ok = click('导入 XTerminal') || click('从 XTerminal 导入')
    return ok
  }, 1800)

  return 'started'
})()
