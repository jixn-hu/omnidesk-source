import { DEFAULT_APPEARANCE, TERMINAL_FONTS, UI_FONTS, UI_SCALES, useAppearance, type AppearancePreferences } from '../../store/appearance'
import Icon from '../../components/Icon'

export default function AppearanceSettings({ embedded = false }: { embedded?: boolean }) {
  const preferences = useAppearance()
  const { setPreferences } = preferences
  return <section className="card appearance-settings" aria-label="外观与字体设置">
    <div className="appearance-heading"><div>{!embedded && <div className="card-title">外观与字体</div>}<div className="card-desc">即时生效，自动保存在本机；切换页面保持同一布局，不会重连会话。</div></div>
      <button className="btn btn-ghost btn-sm" onClick={() => setPreferences(DEFAULT_APPEARANCE)}>恢复默认外观</button></div>
    <div className="appearance-layout">
      <div className="appearance-controls">
        <div className="field"><span className="field-label" id="appearance-theme-label">应用主题</span><div className="segmented appearance-themes" role="group" aria-labelledby="appearance-theme-label">
          {([{ value: 'system', label: '跟随系统', icon: 'monitor' }, { value: 'light', label: '浅色', icon: 'sun' }, { value: 'dark', label: '深色', icon: 'moon' }] as const).map(option =>
            <button key={option.value} aria-pressed={preferences.theme === option.value} data-active={preferences.theme === option.value} onClick={() => setPreferences({ theme: option.value })}><Icon name={option.icon} size={14} />{option.label}</button>)}
        </div></div>
        <div className="appearance-fields">
          <label className="field"><span className="field-label">界面字体</span><select aria-label="界面字体" value={preferences.uiFont} onChange={event => setPreferences({ uiFont: event.target.value as AppearancePreferences['uiFont'] })}>
            {Object.entries(UI_FONTS).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
          </select></label>
          <label className="field"><span className="field-label">界面缩放 · 含字号</span><select aria-label="界面缩放" value={preferences.uiScale} onChange={event => setPreferences({ uiScale: Number(event.target.value) as AppearancePreferences['uiScale'] })}>
            {UI_SCALES.map(value => <option key={value} value={value}>{value}%{value === 100 ? ' · 标准' : ''}</option>)}
          </select></label>
          <label className="field"><span className="field-label">SSH 终端字体</span><select aria-label="SSH 终端字体" value={preferences.terminalFont} onChange={event => setPreferences({ terminalFont: event.target.value as AppearancePreferences['terminalFont'] })}>
            {Object.entries(TERMINAL_FONTS).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
          </select></label>
          <label className="field"><span className="field-label">SSH 终端字号</span><select aria-label="SSH 终端字号" value={preferences.terminalFontSize} onChange={event => setPreferences({ terminalFontSize: Number(event.target.value) })}>
            {Array.from({ length: 15 }, (_, index) => index + 10).map(value => <option key={value} value={value}>{value} px{value === 14 ? ' · 默认' : ''}</option>)}
          </select></label>
        </div>
        <label className="field"><span className="field-label">SSH 终端配色</span><select aria-label="SSH 终端配色" value={preferences.terminalTheme} onChange={event => setPreferences({ terminalTheme: event.target.value as AppearancePreferences['terminalTheme'] })}>
          <option value="dark">经典深色</option><option value="light">柔和浅色</option><option value="follow">跟随应用主题</option>
        </select></label>
      </div>
      <div className="appearance-preview" aria-label="外观实时预览">
        <div className="appearance-preview-heading"><span className="dot dot-connected" />实时预览<span>LOCAL</span></div>
        <div className="appearance-preview-copy"><strong>远程工作，清晰从容。</strong><span>Windows / Linux · 多会话工作区</span></div>
        <div className="appearance-terminal-preview" style={{ fontFamily: TERMINAL_FONTS[preferences.terminalFont].family, fontSize: preferences.terminalFontSize }}><span>user@server:~$</span> ls -la<br /><span className="appearance-preview-directory">documents/  projects/</span><br />中文路径 · 0123456789<span className="appearance-preview-cursor" /></div>
        <p>预览不会连接服务器或执行命令。</p>
      </div>
    </div>
    <fieldset className="sidebar-layout-settings">
      <legend>连接目录样式</legend>
      <p className="card-desc" id="sidebar-layout-description">选择首页侧边连接目录的显示方式，切换后即时生效。</p>
      <div className="sidebar-layout-options" aria-describedby="sidebar-layout-description">
        {([
          { value: 'tree', label: '树状目录', description: '按协议和多级文件夹逐层展开' },
          { value: 'grouped', label: '分组列表', description: '完整分组路径，一层展示连接' },
          { value: 'flat', label: '平铺列表', description: '所有连接直接排列，快速浏览' },
          { value: 'tags', label: '标签分类', description: '同一服务器可出现在多个标签下' },
          { value: 'accounts', label: '账号分类', description: '按登录用户名归类，快速区分身份' }
        ] as const).map(option => <label className="sidebar-layout-option" key={option.value} data-selected={preferences.sidebarLayout === option.value}>
          <input type="radio" name="sidebar-layout" value={option.value} checked={preferences.sidebarLayout === option.value} onChange={() => setPreferences({ sidebarLayout: option.value })} />
          <span className="sidebar-layout-preview" data-layout={option.value} aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</span>
          <strong>{option.label}</strong><small>{option.description}</small>
        </label>)}
      </div>
      <div className="sidebar-detail-settings"><strong>服务器显示信息</strong><p className="card-desc">按需要显示辅助信息；完整内容始终可以悬停查看。</p><div className="sidebar-detail-options">{([
        ['sidebarShowAddress', '地址与端口'], ['sidebarShowUsername', '登录账号'], ['sidebarShowTags', '标签'], ['sidebarShowNote', '备注']
      ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={event => setPreferences({ [key]: event.target.checked })} />{label}</label>)}</div></div>
    </fieldset>
    <div className="appearance-footnote"><Icon name="info" size={14} /><span>字体未安装时自动使用备用字体；终端调整同步应用到已打开的 SSH 标签。Windows 远程桌面的系统字体仍由远端 Windows 设置。</span></div>
  </section>
}
