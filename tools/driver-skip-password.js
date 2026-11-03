// 验证免密码模式：点「暂不设置」→ 应直接进入主界面
(() => {
  const click = (text) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text))
    if (el) {
      el.click()
      return true
    }
    return false
  }

  document.documentElement.dataset.theme = 'dark'

  // 首次启动应显示两个选择
  const hasChoice = [...document.querySelectorAll('button')].some((b) =>
    b.textContent.includes('暂不设置')
  )
  if (!hasChoice) return 'no-choice-screen: ' + document.body.innerText.slice(0, 120)

  click('暂不设置')
  return 'clicked-skip'
})()
