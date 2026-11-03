// 验证系统 VPN 列表能否读到
(() => {
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
    if (ticks > 60) {
      clearInterval(timer)
      return
    }
    switch (step) {
      case 0:
        if (click('暂不设置')) step = 1
        break
      case 1:
        if (click('设置')) step = 2
        break
      case 2:
        // 滚到 VPN 区块
        {
          const cards = [...document.querySelectorAll('.card')]
          const vpnCard = cards.find((c) => c.textContent.includes('系统 VPN'))
          if (vpnCard) vpnCard.scrollIntoView({ block: 'center' })
        }
        break
    }
  }, 400)

  return 'started'
})()
