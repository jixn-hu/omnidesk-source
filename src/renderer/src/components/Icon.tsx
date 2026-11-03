import type { CSSProperties } from 'react'

const paths = {
  tag: 'M3 3h8l10 10-8 8L3 11V3Zm5 4h.01',
  assistant: 'M5 8h14v12H5zM9 13h.01M15 13h.01M9 17h6M12 8V4m-2 0h4M2 12v4m20-4v4',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  gitlab: 'm12 21-9-7 2-11 4 9h6l4-9 2 11-9 7Zm-9-7h18M9 12l3 9 3-9',
  cloud: 'M6 18a4 4 0 0 1-1-7.9A7 7 0 0 1 18.5 8a5 5 0 0 1-.5 10H6m6-8v11m-4-4 4 4 4-4',
  terminal: 'm5 7 5 5-5 5m8 0h6',
  monitor: 'M4 4h16v12H4zM8 20h8m-4-4v4',
  server: 'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6',
  key: 'M15 3a6 6 0 1 1-4.8 9.6L3 20v-4l6-6A6 6 0 0 1 15 3ZM16 7h.01',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 5 7 7-7 7',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  import: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  layers: 'm12 3 10 6-10 6L2 9zM2 13l10 6 10-6M2 17l10 6 10-6',
  link: 'm10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1',
  folder: 'M3 5h7l2 3h9v12H3z',
  folderOpen: 'M3 10V5h7l2 3h9v4M3 10h19l-3 10H3L1 10h2Z',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-2l1 2M4 17l1 2a8 8 0 0 0 14-2',
  copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
  close: 'm6 6 12 12M6 18 18 6',
  shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  home: 'm3 10 9-7 9 7v11h-7v-7h-4v7H3z',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6m0-10h.01'
} as const

export default function Icon({ name, size = 18, style }: {
  name: keyof typeof paths
  size?: number
  style?: CSSProperties
}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    <path d={paths[name]} />
  </svg>
}
