import { app, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { registerIpcHandlers } from './ipc/index.js'
import { services } from './services/index.js'
import { bridgeServiceEvents } from './events.js'
import { createAppWindow, getPrimaryWindow, openNewWindow, windowCount } from './windows.js'
import { IPC } from '@shared/ipc.js'
import { SETTINGS_FILE } from '@shared/constants.js'

/**
 * 主进程入口
 *
 * 主进程以 CommonJS 构建。原因：Electron 的主进程 ESM 支持有限 ——
 * 实测 v44 下 `import { app } from 'electron'` 与默认导入都拿不到
 * Electron API（解析到了 npm 包而非内置模块）。
 *
 * 另一坑：若运行环境设置了 ELECTRON_RUN_AS_NODE=1，Electron 会以纯 Node
 * 模式启动，症状同上。启动前需 `env -u ELECTRON_RUN_AS_NODE`。
 *
 * 窗口管理见 ./windows.ts，服务层见 ./services/index.ts。
 */

/* ------------------------------------------------------------------ */
/* 开发辅助：无头环境截图                                              */
/* ------------------------------------------------------------------ */

/**
 * 设置 OMNIDESK_CAPTURE=<路径> 时，加载完成后截图并退出。
 * 用于在没有显示器的环境里验证界面实际渲染效果。
 *   OMNIDESK_CAPTURE_SCRIPT —— base64 编码的 JS，截图前在页面执行（驱动界面状态）
 *   OMNIDESK_CAPTURE_DELAY  —— 页面加载后等多久执行脚本
 *   OMNIDESK_CAPTURE_WAIT   —— 脚本执行后再等多久截图
 */
function attachCaptureHook(win: Electron.BrowserWindow): void {
  const capturePath = process.env['OMNIDESK_CAPTURE']
  if (!capturePath) return

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const scriptB64 = process.env['OMNIDESK_CAPTURE_SCRIPT']
        if (scriptB64) {
          const script = Buffer.from(scriptB64, 'base64').toString('utf8')
          const result = await win.webContents.executeJavaScript(script, true)
          console.log('[capture] 脚本执行结果：', JSON.stringify(result))
        }
        await new Promise((r) => setTimeout(r, Number(process.env['OMNIDESK_CAPTURE_WAIT'] ?? 1200)))
        // 顺带报告窗口可见性 —— 验证「窗口是否真的显示出来」而不是只截到内容
        console.log(
          `[capture] 窗口可见=${win.isVisible()} 尺寸=${JSON.stringify(win.getContentSize())}`
        )
        const image = await win.webContents.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(capturePath, image.toPNG())
        console.log('[capture] 已保存：' + capturePath)
      } catch (err) {
        console.error('[capture] 失败：', err)
      }
      app.quit()
    }, Number(process.env['OMNIDESK_CAPTURE_DELAY'] ?? 2500))
  })
}

/* ------------------------------------------------------------------ */
/* 图形渲染兜底（非常重要，别删）                                       */
/* ------------------------------------------------------------------ */

/**
 * 默认禁用硬件加速。
 *
 * 【为什么必须这么做】
 *
 * Chromium 的 GPU 进程在相当多的环境里不稳定：显卡驱动问题、远程桌面会话、
 * 虚拟机、以及 —— 最常见的 —— GPU 缓存目录被上一个残留进程占用。
 *
 * 一旦 GPU 进程启动失败，Chromium 会走到这条路径：
 *     FATAL: gpu_data_manager_impl_private.cc
 *     "GPU process isn't usable. Goodbye."
 * 然后**直接放弃整个应用**：窗口永远不出现，也不报错，进程还活着占着单实例锁，
 * 用户再点也没反应，只能去任务管理器杀进程。
 *
 * 对 OmniDesk 这种以终端和远程桌面为主的应用，软件渲染完全够用
 * （xterm.js 是 DOM/Canvas 渲染，RDP 画面走 Canvas 2D），
 * 兼容性远比那点渲染性能重要。
 *
 * 想用硬件加速的用户，可以在 settings.json 里设
 *     "graphics": { "disableHardwareAcceleration": false }
 */
function applyGraphicsFallback(): void {
  let disable = true // 默认关闭硬件加速

  try {
    const settingsPath = join(app.getPath('userData'), SETTINGS_FILE)
    if (existsSync(settingsPath)) {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        graphics?: { disableHardwareAcceleration?: boolean }
      }
      if (raw?.graphics?.disableHardwareAcceleration === false) disable = false
    }
  } catch {
    // 读取失败就按默认（禁用）处理 —— 保守方向
  }

  if (disable) {
    app.disableHardwareAcceleration()
    // disableHardwareAcceleration() 只影响合成器选择，Chromium 仍会拉起 GPU 进程。
    // 在部分环境里那样仍会崩，所以再显式关掉 —— 这是实测有效的组合。
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')
  }

  // GPU 进程若仍然崩溃，至少留下线索，而不是静默卡死
  app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU' && details.reason === 'crashed') {
      console.error(
        `[gpu] GPU 进程崩溃（${details.reason}）。若窗口未出现，请删除用户数据目录下的 ` +
          `GPUPersistentCache / ShaderCache 后重试。`
      )
    }
  })
}

/* ------------------------------------------------------------------ */
/* 数据目录隔离                                                        */
/* ------------------------------------------------------------------ */

/**
 * 支持用环境变量指定独立的数据目录。
 *
 * 有两个用途：
 *   1. 便携模式 —— 把配置放在 U 盘或程序目录旁，不污染系统
 *   2. 自动化测试 —— 在隔离目录里跑，绝不碰用户的真实配置
 *
 * 必须在 app.whenReady() 之前调用，否则路径已固化。
 */
function applyUserDataDirOverride(): void {
  const dir = process.env['OMNIDESK_USER_DATA_DIR'] || process.env['PLAYWRIGHT_ELECTRON_USER_DATA_DIR']
  if (!dir) return
  try {
    app.setPath('userData', dir)
    app.setPath('appData', join(dir, 'appData'))
  } catch {
    // 设置失败就退回默认目录，不要让应用起不来
  }
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

// 顺序有讲究：先定数据目录（决定 settings.json 从哪读），再据此决定渲染策略
applyUserDataDirOverride()
applyGraphicsFallback()

/* ------------------------------------------------------------------ */
/* 单实例与重复启动                                                    */
/* ------------------------------------------------------------------ */

/**
 * 先说清楚一件事，免得后来的人被任务管理器吓到：
 *
 *   任务管理器里看到 3 个 OmniDesk.exe 是**正常的**，那是 1 个实例。
 *   Electron 天生多进程：主进程 + GPU 进程 + 渲染进程（还有若干工具进程）。
 *   判断有几个实例要看「有没有拿到单实例锁」，不能数进程数。
 *
 * 单实例锁本身一直有效。真正的坑在于：拿不到锁的第二个实例原本是**静默退出**的，
 * 用户看不到任何反馈，就会以为「双击没反应 = 程序坏了」，
 * 然后反复双击 —— 而每次都被静默挡回，体验上像程序死了。
 *
 * 所以这里加了心跳机制，让第二个实例能判断第一个是活着还是卡死，分别处理：
 *   活着  → 静默退出（第一个实例会收到 second-instance 事件并把窗口唤到前台）
 *   卡死  → 明确告诉用户发生了什么、该怎么办
 */

// Windows 任务栏身份。不设的话系统可能把它当成多个独立程序，任务栏会出现重复图标。
app.setAppUserModelId('cn.omnidesk.app')

const HEARTBEAT_FILE = 'instance.heartbeat'
/** 心跳超过这个时长没更新，就认为第一个实例已经不响应了 */
const HEARTBEAT_STALE_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 3_000

function heartbeatPath(): string {
  try {
    return join(app.getPath('userData'), HEARTBEAT_FILE)
  } catch {
    return ''
  }
}

/** 第一实例：定期写心跳，供后来者判断我们是否还活着 */
let heartbeatTimer: NodeJS.Timeout | null = null

function startHeartbeat(): void {
  const p = heartbeatPath()
  if (!p) return

  const beat = (): void => {
    try {
      writeFileSync(p, String(Date.now()))
    } catch {
      /* 写不进去不影响主流程 */
    }
  }

  beat()
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS)

  app.on('before-quit', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    // 正常退出时清掉心跳，这样下次启动不会误判为「上次异常退出」
    try {
      unlinkSync(p)
    } catch {
      /* ignore */
    }
  })
}

/** 第二实例：判断第一个实例是否还在正常响应 */
function isRunningInstanceAlive(): boolean {
  // 测试钩子：强制判定为「已卡死」，用于验证提示对话框这条分支
  if (process.env['OMNIDESK_TEST_FORCE_STALE_HEARTBEAT'] === '1') return false

  const p = heartbeatPath()
  if (!p) return false
  try {
    if (!existsSync(p)) return false
    const ts = Number(readFileSync(p, 'utf8'))
    return Number.isFinite(ts) && Date.now() - ts < HEARTBEAT_STALE_MS
  } catch {
    return false
  }
}

/**
 * 把已有窗口唤到用户面前。
 * 只在第一步失败（窗口全没了）时才开新窗口 —— 开新窗口属于兜底，不是常态。
 */
function revealExistingWindow(): void {
  const win = getPrimaryWindow()
  if (!win) {
    openNewWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  // focus() 有时会被其他置顶窗口压住，再抬一次更稳
  try {
    win.moveTop()
  } catch {
    /* 部分平台/情况下不支持，忽略 */
  }
}

const gotLock = app.requestSingleInstanceLock()

if (gotLock) {
  startHeartbeat()
  app.on('second-instance', () => revealExistingWindow())
} else {
  // 已经有一个实例在跑。等 app ready 后再决定怎么反馈 —— 这时候才弹得了对话框。
  app.whenReady().then(() => {
    if (!isRunningInstanceAlive()) {
      // 有心跳但没有第二个实例的响应 —— 说明第一个实例卡住了。
      // 这时候静默退出就是最糟的选择：用户会一直双击、一直没反应。
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'OmniDesk 已在运行（但未响应）',
        message: '检测到 OmniDesk 已在运行，但那个窗口没有响应。',
        detail:
          '这通常是上一次运行没有正常退出导致的。\n\n' +
          '处理方法：打开任务管理器，找到所有 OmniDesk 进程，全部结束，然后重新启动。',
        buttons: ['知道了'],
        noLink: true
      })
    }
    // 如果第一个实例有心跳（活着），它会收到 second-instance 事件把窗口唤到前台，
    // 这里就静默退出 —— 不给用户多余打扰。
    app.quit()
  })
}

app.whenReady().then(async () => {
  // 初始化服务层（Vault / SSH / SFTP / RDP / 转发 / 设置）
  await services.init()

  registerIpcHandlers(ipcMain)

  // 多窗口：渲染进程请求开新窗口
  ipcMain.handle(IPC.appOpenWindow, () => {
    const win = openNewWindow()
    return { id: win.id }
  })
  ipcMain.handle(IPC.appWindowCount, () => windowCount())

  const win = createAppWindow()
  attachCaptureHook(win)

  // 服务层事件 → 广播给所有窗口
  bridgeServiceEvents()
  if (app.isPackaged) services.updates.start()

  app.on('activate', () => {
    // macOS 点 Dock 图标时，没有窗口就开一个
    if (windowCount() === 0) createAppWindow()
  })
})

// 所有窗口关闭才退出（多窗口下不能一关就退）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await services.dispose()
})
