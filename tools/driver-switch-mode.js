// 验证：主密码模式 → 免密码模式的切换
// 用轮询状态机，避免嵌套 setTimeout 里提前 return 导致后续步骤没注册
(() => {
  const log = []
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const byText = (text, sel = 'button') =>
    [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().includes(text))
  const click = (text, sel = 'button') => {
    const el = byText(text, sel)
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
    if (ticks > 60) {
      clearInterval(timer)
      log.push('timeout@step' + step)
      return
    }

    switch (step) {
      case 0: {
        // 首次启动：选择「设置主密码」
        if (click('设置主密码')) {
          log.push('chose-master-password')
          step = 1
        } else if (document.querySelector('input[type="password"]')) {
          step = 1 // 已经在密码界面
        }
        break
      }
      case 1: {
        // 填写并创建
        const fields = [...document.querySelectorAll('input[type="password"]')]
        if (fields.length >= 2) {
          setValue(fields[0], 'TestPass12345')
          setValue(fields[1], 'TestPass12345')
          if (click('创建保险箱')) {
            log.push('created-vault')
            step = 2
          }
        }
        break
      }
      case 2: {
        // 等主界面出来后进设置
        if (click('设置')) {
          log.push('opened-settings')
          step = 3
        }
        break
      }
      case 3: {
        if (click('切换方式')) {
          log.push('opened-mode-dialog')
          step = 4
        }
        break
      }
      case 4: {
        const modal = document.querySelector('.modal')
        if (!modal) break
        const pw = modal.querySelector('input[type="password"]')
        if (pw && !pw.value) setValue(pw, 'TestPass12345')
        const cb = modal.querySelector('input[type="checkbox"]')
        if (cb && !cb.checked) {
          cb.click()
          break // 下一轮再提交，给 React 更新时间
        }
        if (cb && cb.checked) {
          if (click('确认改为免密码')) {
            log.push('submitted-switch')
            step = 5
          }
        }
        break
      }
      case 5: {
        // 等对话框关闭
        if (!document.querySelector('.modal')) {
          log.push('switch-done')
          clearInterval(timer)
        }
        break
      }
    }
  }, 400)

  // 暴露日志，供截图钩子读取
  window.__driverLog = log

  return 'started'
})()
