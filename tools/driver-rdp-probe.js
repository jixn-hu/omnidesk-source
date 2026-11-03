// 验证 RDP 是否还在卡「加载协议栈」
// 用一个必然连不上的地址（127.0.0.1:3389）：
//   若 WASM 正常加载 → 应报「连不上服务器」
//   若仍卡在「加载协议栈」→ CSP 修复无效
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
    if (ticks > 90) {
      clearInterval(timer)
      return
    }

    switch (step) {
      case 0:
        if (click('暂不设置')) {
          log.push('skipped-password')
          step = 1
        }
        break

      case 1:
        if (click('新建连接') || click('新建第一个连接') || click('＋')) {
          log.push('opened-editor')
          step = 2
        }
        break

      case 2: {
        const modal = document.querySelector('.modal')
        if (!modal) break
        if (!byText('RDP · Windows')) break
        click('RDP · Windows')
        step = 3
        break
      }

      case 3: {
        const modal = document.querySelector('.modal')
        if (!modal) break
        const inputs = [...modal.querySelectorAll('input')]
        // 名称 / 主机 / 端口 / 用户名
        if (inputs[0]) setValue(inputs[0], 'RDP测试')
        if (inputs[1]) setValue(inputs[1], '127.0.0.1')
        if (inputs[2]) setValue(inputs[2], '3399')
        if (inputs[3]) setValue(inputs[3], 'test')
        if (click('保存')) {
          log.push('saved')
          step = 4
        }
        break
      }

      case 4:
        // 等编辑器关闭后点连接
        if (!document.querySelector('.modal')) {
          if (click('RDP测试', '.conn-item') || click('RDP测试')) {
            log.push('opened-rdp-tab')
            step = 5
          }
        }
        break

      case 5:
        // 观察界面文字，判断最终状态
        break
    }
  }, 400)

  // 暴露状态供截图钩子读取
  window.__probe = () => {
    const t = document.body.innerText
    return {
      log,
      step,
      loadingStack: t.includes('加载协议栈') || t.includes('加载 RDP 协议栈'),
      connError: t.includes('无法连接') || t.includes('连接失败') || t.includes('超时'),
      snippet: t.replace(/\s+/g, ' ').slice(0, 300)
    }
  }

  return 'started'
})()
