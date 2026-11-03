/**
 * 窗口管理
 *
 * 单独成模块是为了避免循环依赖：主入口和事件桥都要用窗口列表，
 * 如果窗口管理写在主入口里，事件桥 import 主入口、主入口又 import 事件桥，
 * 就形成环。CJS 下这种环大多数时候能跑，但初始化顺序敏感，容易出玄学问题。
 *
 * 多窗口设计要点：服务层是单例，所有窗口天然共享同一批 SSH 会话。
 * 在窗口 A 连上的机器，窗口 B 直接就能用 —— 不需要任何同步代码。
 */
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants.js'

/** 需要 __dirname（由构建工具注入，CJS 产物天然可用） */
declare const __dirname: string

const windows = new Set<BrowserWindow>()

/** 主窗口（第一个创建的）。用于「需要弹在用户眼前」的场景，如 MCP 审批 */
let primary: BrowserWindow | null = null

export function createAppWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全底线：隔离上下文，preload 只暴露白名单 API
      contextIsolation: true,
      sandbox: false, // preload 需要少量 Node API，但仍不暴露 ipcRenderer 本体
      nodeIntegration: false,
      webSecurity: true,
      // 刻意不关闭任何安全开关：不设 ignore-certificate-errors / disable-web-security
      spellcheck: false
    }
  })

  windows.add(win)
  if (!primary) primary = win

  win.on('closed', () => {
    windows.delete(win)
    if (primary === win) primary = null
  })

  /**
   * 窗口显示兜底 —— 这段是血泪教训换来的，别删。
   *
   * 正常路径是等 ready-to-show 再 show()，避免白屏闪烁。
   * 但 ready-to-show 依赖渲染进程完成首次绘制：GPU 进程崩溃、渲染进程挂掉、
   * 页面加载失败……任何一种都会让这个事件永远不来。
   *
   * 后果是灾难性的：窗口不出现、不报错、进程活着占着单实例锁，
   * 用户再点图标也没反应（第二个实例被锁挡住直接退出），
   * 只能去任务管理器杀进程 —— 表现就是「双击没反应，打不开」。
   *
   * 所以：超过 3 秒无论如何把窗口亮出来。哪怕里面是白的，
   * 也比「什么都没发生」强得多 —— 至少用户知道程序起来了、能关掉、能看到报错。
   */
  const SHOW_FALLBACK_MS = 3000
  let shown = false
  const forceShow = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    try {
      win.show()
    } catch {
      /* ignore */
    }
  }
  const showTimer = setTimeout(forceShow, SHOW_FALLBACK_MS)

  // 测试钩子：完全不注册 ready-to-show，模拟「该事件永不触发」的真实故障，
  // 用来验证上面的兜底定时器确实能把窗口亮出来
  const skipReadyShow = process.env['OMNIDESK_TEST_SKIP_READY_SHOW'] === '1'

  if (!skipReadyShow) {
    win.once('ready-to-show', () => {
      clearTimeout(showTimer)
      forceShow()
    })
  }

  // 页面加载失败：把原因直接渲染到窗口里，而不是留给用户一个白屏
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    clearTimeout(showTimer)
    forceShow()
    const html = buildDiagnosticPage(
      '页面加载失败',
      [
        ['错误码', String(errorCode)],
        ['描述', errorDescription || '(无)'],
        ['目标', validatedURL || '(空)']
      ],
      '这通常意味着应用文件不完整。请重新安装，或确认杀毒软件没有隔离安装目录下的文件。'
    )
    void win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })

  // 渲染进程崩溃（GPU 异常、内存耗尽等）
  win.webContents.on('render-process-gone', (_e, details) => {
    clearTimeout(showTimer)
    forceShow()
    const html = buildDiagnosticPage(
      '界面进程异常退出',
      [
        ['原因', details.reason],
        ['退出码', String(details.exitCode ?? '(无)')]
      ],
      '最常见的原因是显卡驱动与硬件加速不兼容。可在 settings.json 中确认 ' +
        '"graphics": { "disableHardwareAcceleration": true }，然后重启应用。'
    )
    void win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })

  // 外部链接交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

/** 新建窗口。多窗口共享服务层，所以新窗口能直接看到已有的会话 */
export function openNewWindow(): BrowserWindow {
  return createAppWindow()
}

export function getPrimaryWindow(): BrowserWindow | null {
  if (primary && !primary.isDestroyed()) return primary
  // 主窗口被关了就随便找一个还活着的
  const alive = [...windows].find((w) => !w.isDestroyed())
  return alive ?? null
}

export function getAllWindows(): BrowserWindow[] {
  return [...windows].filter((w) => !w.isDestroyed())
}

export function windowCount(): number {
  return getAllWindows().length
}

/** 向所有窗口广播 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of getAllWindows()) {
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* 窗口可能正在销毁 */
    }
  }
}

/** 只发给主窗口 */
export function sendToPrimary(channel: string, payload: unknown): void {
  const win = getPrimaryWindow()
  if (!win) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 故障诊断页                                                          */
/* ------------------------------------------------------------------ */

/**
 * 渲染一张纯 HTML 的诊断页（不依赖任何本地资源）。
 *
 * 用 data: URL 而不是本地文件，是因为本地资源可能正是坏掉的那个东西 ——
 * 诊断页必须在最恶劣的条件下都能显示出来。
 */
function buildDiagnosticPage(
  title: string,
  rows: Array<[string, string]>,
  advice: string
): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="color:#98a2b3;padding:6px 14px 6px 0;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
        `<td style="font-family:ui-monospace,Consolas,monospace;word-break:break-all">${esc(v)}</td></tr>`
    )
    .join('')

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>OmniDesk · 启动异常</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0e1014;color:#e8ecf2;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
<div style="max-width:620px;padding:36px;border:1px solid #262c36;border-radius:14px;background:#14171d">
  <div style="font-size:34px;margin-bottom:14px">&#9888;&#65039;</div>
  <h1 style="font-size:17px;font-weight:600;margin:0 0 16px">${esc(title)}</h1>
  <table style="border-collapse:collapse;font-size:12.5px;margin-bottom:18px">${rowsHtml}</table>
  <p style="font-size:12.5px;line-height:1.75;color:#9aa4b2;margin:0 0 18px">${esc(advice)}</p>
  <p style="font-size:12px;color:#6b7482;margin:0">
    用户数据目录：<span style="font-family:ui-monospace,Consolas,monospace">${esc(
      (() => {
        try {
          return require('electron').app.getPath('userData')
        } catch {
          return '(未知)'
        }
      })()
    )}</span>
  </p>
</div></body></html>`
}
