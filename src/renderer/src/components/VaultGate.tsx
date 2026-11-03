import { useState } from 'react'
import { useApp } from '../store/app'
import Icon from './Icon'

/**
 * 凭据保护的选择与解锁
 *
 * 首次使用给两个明确选项，而不是强制设密码：
 *   设置主密码 —— 安全性最高，代价是每次启动要输入
 *   暂不设置   —— 启动直接进，用本机密钥保护（能防拷贝，不防本机读取）
 *
 * 两者的差别在界面上要讲清楚，让用户自己做知情选择，
 * 而不是用"推荐"两个字把人往一边推。
 */
export default function VaultGate() {
  const vaultStatus = useApp((s) => s.vaultStatus)
  const setVaultStatus = useApp((s) => s.setVaultStatus)
  const setReady = useApp((s) => s.setReady)

  const isInit = vaultStatus === 'uninitialized'

  /** 首次使用时：null 表示还没选，'password' 表示选了设密码 */
  const [choice, setChoice] = useState<'password' | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /** 解锁后的收尾：重新拉数据并进入主界面 */
  const afterUnlock = async (): Promise<void> => {
    const api = window.omnidesk
    const conns = await api.connections.list()
    if (conns.ok) useApp.getState().setConnections(conns.data)
    setVaultStatus('unlocked')
    setReady(true)
  }

  /** 免密码模式：不传密码即创建设备密钥保险箱 */
  const skipPassword = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const res = await window.omnidesk.vault.init()
      if (!res.ok) {
        setError(res.message)
        return
      }
      await afterUnlock()
    } finally {
      setBusy(false)
    }
  }

  /** 主密码模式：创建 或 解锁 */
  const submitPassword = async (): Promise<void> => {
    setError('')
    if (!password) return setError('请输入主密码')

    if (isInit) {
      if (password.length < 8) return setError('主密码至少 8 位')
      if (password !== confirm) return setError('两次输入不一致')
    }

    setBusy(true)
    try {
      const api = window.omnidesk
      const res = isInit ? await api.vault.init(password) : await api.vault.unlock(password)
      if (!res.ok) {
        setError(res.message)
        return
      }
      await afterUnlock()
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- 首次使用：选择保护方式 ---------------- */

  if (isInit && !choice) {
    return (
      <div className="vault-gate">
        <div className="vault-card" style={{ maxWidth: 520 }}>
          <div className="vault-onboarding-step">首次使用 · 1 / 2</div>
          <div className="vault-icon"><Icon name="shield" size={32} /></div>
          <h1 className="vault-title">保护你的服务器凭据</h1>
          <p className="vault-desc">
            先选择本机凭据的保护方式，下一步即可添加服务器。无需注册账号，之后也可以在设置中切换保护方式。
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, textAlign: 'left' }}>
            <button
              className="vault-choice"
              onClick={() => setChoice('password')}
              disabled={busy}
            >
              <div className="vault-choice-head">
                <span className="vault-choice-title">设置主密码</span>
                <span className="badge badge-success">更安全</span>
              </div>
              <div className="vault-choice-desc">
                凭据用你设定的密码加密。即使配置文件被拷到别的机器也解不开。
              </div>
              <div className="vault-choice-tradeoff">代价：每次启动需要输入一次</div>
            </button>

            <button className="vault-choice" onClick={skipPassword} disabled={busy}>
              <div className="vault-choice-head">
                <span className="vault-choice-title">暂不设置</span>
                <span className="badge">更方便</span>
              </div>
              <div className="vault-choice-desc">
                使用本机生成的密钥加密，启动直接进入，不用输密码。
              </div>
              <div className="vault-choice-tradeoff">
                注意：能防止配置被拷走后泄密，但挡不住能直接读取你电脑的人
              </div>
            </button>
          </div>

          {error && (
            <div className="vault-error" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    )
  }

  /* ---------------- 主密码输入（创建 或 解锁） ---------------- */

  return (
    <div className="vault-gate">
      <div className="vault-card">
        <div className="vault-icon">🔒</div>
        <h1 className="vault-title">{isInit ? '设置主密码' : '解锁'}</h1>
        <p className="vault-desc">
          {isInit
            ? '主密码用于加密你的服务器凭据。它只存在于你的记忆中，不会上传到任何地方。'
            : '输入主密码以解密本地保存的凭据。'}
        </p>

        <div className="vault-form">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isInit && submitPassword()}
            placeholder="主密码"
            autoFocus
            disabled={busy}
          />

          {isInit && (
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
              placeholder="再次输入主密码"
              disabled={busy}
            />
          )}

          {error && <div className="vault-error">{error}</div>}

          <button className="btn btn-primary" onClick={submitPassword} disabled={busy}>
            {busy ? '处理中…' : isInit ? '创建保险箱' : '解锁'}
          </button>

          {isInit && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setChoice(null)
                setError('')
              }}
              disabled={busy}
            >
              返回上一步
            </button>
          )}
        </div>

        {isInit && (
          <div className="alert alert-warning vault-warning">
            <span>⚠</span>
            <div>
              <strong>请务必记住主密码。</strong>
              它没有被记录在任何地方 —— 忘记后将无法恢复已保存的服务器密码，只能重新录入。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
