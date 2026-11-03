import { create } from 'zustand'

export const UI_FONTS = {
  system: { label: '系统默认', family: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif' },
  yahei: { label: '微软雅黑', family: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif' },
  pingfang: { label: '苹方', family: '"PingFang SC", "Microsoft YaHei", sans-serif' },
  noto: { label: '思源黑体 / Noto Sans', family: '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif' }
} as const

export const TERMINAL_FONTS = {
  cascadia: { label: 'Cascadia Mono', family: '"Cascadia Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace' },
  consolas: { label: 'Consolas', family: 'Consolas, "Cascadia Mono", "Liberation Mono", monospace' },
  jetbrains: { label: 'JetBrains Mono', family: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace' },
  dejavu: { label: 'DejaVu Sans Mono', family: '"DejaVu Sans Mono", "Liberation Mono", Consolas, monospace' }
} as const

export const UI_SCALES = [90, 100, 110, 125] as const
export const APPEARANCE_STORAGE_KEY = 'omnidesk.appearance'

export interface AppearancePreferences {
  theme: 'system' | 'light' | 'dark'
  uiFont: keyof typeof UI_FONTS
  uiScale: typeof UI_SCALES[number]
  terminalFont: keyof typeof TERMINAL_FONTS
  terminalFontSize: number
  terminalTheme: 'dark' | 'light' | 'follow'
  sidebarLayout: 'tree' | 'grouped' | 'flat' | 'tags' | 'accounts'
  sidebarShowAddress: boolean
  sidebarShowUsername: boolean
  sidebarShowTags: boolean
  sidebarShowNote: boolean
}

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'system', uiFont: 'system', uiScale: 100,
  terminalFont: 'cascadia', terminalFontSize: 14, terminalTheme: 'dark', sidebarLayout: 'tree',
  sidebarShowAddress: true, sidebarShowUsername: false, sidebarShowTags: false, sidebarShowNote: false
}

export function normalizeAppearance(value: unknown): AppearancePreferences {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    uiFont: typeof raw.uiFont === 'string' && Object.hasOwn(UI_FONTS, raw.uiFont) ? raw.uiFont as AppearancePreferences['uiFont'] : DEFAULT_APPEARANCE.uiFont,
    uiScale: UI_SCALES.includes(raw.uiScale as AppearancePreferences['uiScale']) ? raw.uiScale as AppearancePreferences['uiScale'] : DEFAULT_APPEARANCE.uiScale,
    terminalFont: typeof raw.terminalFont === 'string' && Object.hasOwn(TERMINAL_FONTS, raw.terminalFont) ? raw.terminalFont as AppearancePreferences['terminalFont'] : DEFAULT_APPEARANCE.terminalFont,
    terminalFontSize: typeof raw.terminalFontSize === 'number' && Number.isInteger(raw.terminalFontSize) && raw.terminalFontSize >= 10 && raw.terminalFontSize <= 24 ? raw.terminalFontSize : DEFAULT_APPEARANCE.terminalFontSize,
    terminalTheme: raw.terminalTheme === 'light' || raw.terminalTheme === 'follow' ? raw.terminalTheme : 'dark',
    sidebarLayout: ['grouped', 'flat', 'tags', 'accounts'].includes(String(raw.sidebarLayout)) ? raw.sidebarLayout as AppearancePreferences['sidebarLayout'] : 'tree',
    sidebarShowAddress: typeof raw.sidebarShowAddress === 'boolean' ? raw.sidebarShowAddress : true,
    sidebarShowUsername: raw.sidebarShowUsername === true,
    sidebarShowTags: raw.sidebarShowTags === true,
    sidebarShowNote: raw.sidebarShowNote === true
  }
}

function readAppearance(): AppearancePreferences {
  try {
    const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    return normalizeAppearance(saved ? JSON.parse(saved) : {
      theme: localStorage.getItem('omnidesk.theme'),
      terminalFontSize: Number(localStorage.getItem('omnidesk.terminal.fontSize') || 14)
    })
  } catch { return { ...DEFAULT_APPEARANCE } }
}

export const useAppearance = create<AppearancePreferences & { setPreferences: (patch: Partial<AppearancePreferences>) => void }>((set) => ({
  ...readAppearance(),
  setPreferences: patch => set(state => {
    const next = normalizeAppearance({ ...state, ...patch })
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next))
    localStorage.setItem('omnidesk.theme', next.theme)
    localStorage.setItem('omnidesk.terminal.fontSize', String(next.terminalFontSize))
    return next
  })
}))

const TERMINAL_PALETTES = {
  dark: {
    background: '#101820', foreground: '#d9e5eb', cursor: '#65d6af', cursorAccent: '#101820', selectionBackground: '#284c50',
    black: '#273642', red: '#f48088', green: '#89d6aa', yellow: '#e5c68b', blue: '#86b9ed', magenta: '#c6a1df', cyan: '#79d1d8', white: '#d9e5eb',
    brightBlack: '#71838f', brightRed: '#ff9ba0', brightGreen: '#a2e8bd', brightYellow: '#f4d99f', brightBlue: '#a1ceff', brightMagenta: '#ddbcf0', brightCyan: '#9ce8e8', brightWhite: '#f4f8fa'
  },
  light: {
    background: '#f5f8f7', foreground: '#203238', cursor: '#187c66', cursorAccent: '#f5f8f7', selectionBackground: '#c6ddd5',
    black: '#203238', red: '#b73547', green: '#216f45', yellow: '#825e0e', blue: '#24629b', magenta: '#82519b', cyan: '#176c75', white: '#d9e5eb',
    brightBlack: '#586e77', brightRed: '#c23c50', brightGreen: '#247c48', brightYellow: '#926a0e', brightBlue: '#266fb5', brightMagenta: '#965cb0', brightCyan: '#167984', brightWhite: '#ffffff'
  }
}

export function terminalTheme(mode = useAppearance.getState().terminalTheme, effective: 'light' | 'dark' = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark') {
  return { ...TERMINAL_PALETTES[mode === 'follow' ? effective : mode] }
}

export function initializeAppearance(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let appliedScale = 0
  const apply = () => {
    const preferences = useAppearance.getState()
    const effective = preferences.theme === 'system' ? (media.matches ? 'dark' : 'light') : preferences.theme
    const root = document.documentElement
    if (root.dataset.theme !== effective) root.dataset.theme = effective
    root.style.setProperty('--font-sans', UI_FONTS[preferences.uiFont].family)
    root.style.setProperty('--font-mono', TERMINAL_FONTS[preferences.terminalFont].family)
    const palette = terminalTheme(preferences.terminalTheme, effective)
    root.style.setProperty('--term-bg', palette.background)
    root.style.setProperty('--term-fg', palette.foreground)
    if (appliedScale !== preferences.uiScale) {
      window.omnidesk.app.setZoomFactor(preferences.uiScale / 100)
      appliedScale = preferences.uiScale
    }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === APPEARANCE_STORAGE_KEY || event.key === null)) useAppearance.setState(readAppearance())
  }
  const unsubscribe = useAppearance.subscribe(apply)
  media.addEventListener('change', apply)
  window.addEventListener('storage', onStorage)
  apply()
  return () => { unsubscribe(); media.removeEventListener('change', apply); window.removeEventListener('storage', onStorage) }
}
