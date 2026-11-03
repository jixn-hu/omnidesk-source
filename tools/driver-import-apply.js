// 端到端验证：解锁 → 打开导入 → 点「导入 N 条」→ 回到主界面确认连接已落盘
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

  // 打开导入
  setTimeout(() => {
    document.documentElement.dataset.theme = 'dark'
    click('导入 XTerminal') || click('从 XTerminal 导入')
  }, 1800)

  // 点导入按钮（文案形如「导入 13 条」）
  setTimeout(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /^导入 \d+ 条$/.test(b.textContent.trim())
    )
    if (btn) btn.click()
  }, 4200)

  // 关闭完成页
  setTimeout(() => {
    click('完成')
  }, 6000)

  return 'started'
})()
