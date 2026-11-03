import type { RdpOptions } from './types.js'

export const RDP_PERFORMANCE_MODES = [
  { value: 'smooth', label: '流畅', limit: '最高 1600 × 900', description: '降低像素量，适合网络较慢或服务器性能有限时使用。', width: 1600, height: 900 },
  { value: 'balanced', label: '均衡', limit: '最高 1920 × 1080', description: '兼顾响应速度和文字细节，适合日常管理。', width: 1920, height: 1080 },
  { value: 'clear', label: '清晰', limit: '窗口原生像素', description: '保留高分辨率与高 DPI 细节，需要更多带宽和解码性能。', width: 8192, height: 8192 }
] as const

export function rdpPerformanceOptions(options: RdpOptions = {}): RdpOptions {
  if (!RDP_PERFORMANCE_MODES.some(mode => mode.value === options.performanceMode)) return options
  const clear = options.performanceMode === 'clear'
  return {
    ...options,
    colorDepth: options.performanceMode === 'smooth' ? 16 : 32,
    showWallpaper: clear,
    fontSmoothing: options.performanceMode !== 'smooth',
    desktopComposition: clear,
    showDraggedWindow: clear,
    showMenuAnimations: false,
    showThemes: options.performanceMode !== 'smooth',
    systemSmartSizing: options.systemSmartSizing ?? !clear
  }
}

export function rdpDisplaySize(width: number, height: number, devicePixelRatio = 1, performanceMode?: RdpOptions['performanceMode']): { width: number; height: number; scaleFactor: number } {
  const scale = Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(2, devicePixelRatio)) : 1
  const profile = RDP_PERFORMANCE_MODES.find(mode => mode.value === performanceMode)
  if (profile) {
    const physicalWidth = (Number.isFinite(width) && width > 0 ? width : 1280) * scale
    const physicalHeight = (Number.isFinite(height) && height > 0 ? height : 720) * scale
    const fit = Math.min(1, profile.width / physicalWidth, profile.height / physicalHeight)
    const desktopWidth = Math.max(200, Math.floor(physicalWidth * fit))
    return {
      width: desktopWidth - desktopWidth % 2,
      height: Math.max(200, Math.floor(physicalHeight * fit)),
      scaleFactor: Math.max(100, Math.min(200, Math.round(scale * fit * 100)))
    }
  }
  const pixels = (value: number, fallback: number) => Math.max(200, Math.min(8192,
    Math.floor((Number.isFinite(value) && value > 0 ? value : fallback) * scale)))
  const desktopWidth = pixels(width, 1280)
  return { width: desktopWidth - desktopWidth % 2, height: pixels(height, 720), scaleFactor: Math.round(scale * 100) }
}
