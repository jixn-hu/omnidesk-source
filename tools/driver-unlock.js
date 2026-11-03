// 驱动界面：填入主密码 → 创建保险箱 → 等主界面渲染完成
// 用于截图验证，不参与生产逻辑
(() => {
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const inputs = [...document.querySelectorAll('input[type="password"]')]
  if (inputs.length >= 2) {
    setValue(inputs[0], 'omnidesk-test-2026')
    setValue(inputs[1], 'omnidesk-test-2026')
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('创建保险箱')
    )
    if (btn) {
      btn.click()
      return 'vault-created'
    }
    return 'button-not-found'
  }
  return 'inputs=' + inputs.length
})()
