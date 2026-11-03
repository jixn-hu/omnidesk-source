import { useApp } from '../store/app'
import Icon from './Icon'

interface Props {
  onNew: (kind: 'ssh' | 'rdp') => void
  onManage: () => void
  onDismiss: () => void
}

export default function QuickStartGuide({ onNew, onManage, onDismiss }: Props) {
  const connections = useApp(state => state.connections)
  const sessions = useApp(state => state.sessions)
  const tabs = useApp(state => state.tabs)
  const connected = sessions.some(session => session.status === 'connected') || tabs.some(tab => (tab.kind === 'ssh' || tab.kind === 'rdp') && tab.status === 'connected')
  return <section className="quick-start" aria-label="快速上手">
    <div className="quick-start-heading"><div><span className="eyebrow">QUICK START</span><h2>三步，进入你的远程工作空间</h2></div><button className="btn btn-ghost btn-sm" onClick={onDismiss}>收起指南<Icon name="close" size={13} /></button></div>
    <ol className="quick-start-steps">
      <li data-complete={connections.length > 0}>
        <span className="quick-start-number">01</span><h3>添加服务器{connections.length > 0 && <span className="quick-start-done">已添加</span>}</h3>
        <p>准备好主机地址、端口和登录账号。Windows 选 RDP，Linux 通常选 SSH。</p>
        <div className="quick-start-actions"><button className="btn btn-primary btn-sm" onClick={() => onNew('ssh')}><Icon name="terminal" size={15} />新建 SSH</button><button className="btn btn-sm" onClick={() => onNew('rdp')}><Icon name="monitor" size={15} />新建 RDP</button></div>
      </li>
      <li data-complete={connected}>
        <span className="quick-start-number">02</span><h3>打开连接，开始工作{connected && <span className="quick-start-done">已连接</span>}</h3>
        <p>保存后点击左侧服务器即可连接。多个 SSH、RDP 会话可以同时打开，用顶部标签切换。</p>
        <div className="quick-start-tip"><Icon name="info" size={15} /><span>SSH 右侧可看状态、管理文件；RDP 默认优先使用 TLS / NLA。</span></div>
      </li>
      <li>
        <span className="quick-start-number">03</span><h3>整理连接，少做重复工作</h3>
        <p>用分组、备注和标签管理服务器。同一账号用于多台服务器？只需维护一条公共凭据。</p>
        <div className="quick-start-actions"><button className="btn btn-sm" onClick={onManage}>服务器管理</button><button className="btn btn-ghost btn-sm" onClick={() => useApp.getState().openTab({ id: 'tab-credentials', kind: 'credentials', title: '公共凭据', status: 'idle' })}>公共凭据<Icon name="arrow" size={13} /></button></div>
      </li>
    </ol>
    <div className="quick-start-footer"><span><Icon name="shield" size={14} />无需注册账号。账号同步、共享与 WebDAV 都是可选功能。</span><button className="text-link" onClick={onManage}>已有 XTerminal / RDO 配置？前往导入<Icon name="arrow" size={13} /></button></div>
  </section>
}
