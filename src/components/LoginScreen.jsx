import { useState } from 'react';
import { Atom, LogIn, UserPlus, Loader, ShieldCheck } from 'lucide-react';
import { useAuth } from './authContext.js';

export default function LoginScreen() {
    const { config, login, register } = useAuth();
    const firstRun = !config.hasUsers;
    const canRegister = config.allowRegistration || firstRun;

    const [mode, setMode] = useState(firstRun ? 'register' : 'login'); // 'login' | 'register'
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [setupToken, setSetupToken] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const switchMode = (next) => {
        setMode(next);
        setError('');
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        const name = username.trim();
        if (name.length < 2) { setError('用户名至少需要 2 个字符'); return; }
        if (password.length < 6) { setError('密码至少需要 6 位'); return; }
        if (mode === 'register' && password !== confirm) { setError('两次输入的密码不一致'); return; }

        setBusy(true);
        try {
            if (mode === 'register') await register(name, password, setupToken);
            else await login(name, password);
            // AuthGate swaps to the app on success.
        } catch (err) {
            setError(err.message || '操作失败，请重试');
            setBusy(false);
        }
    };

    return (
        <div className="auth-overlay">
            <form className="auth-card" onSubmit={handleSubmit}>
                <div className="auth-brand">
                    <div className="auth-brand-icon"><Atom size={22} /></div>
                    <div>
                        <div className="auth-brand-title">PlanTrace</div>
                        <div className="auth-brand-sub">个人任务 · 日记 · 时间追踪</div>
                    </div>
                </div>

                {firstRun ? (
                    <div className="auth-notice">
                        <ShieldCheck size={14} />
                        首次使用，将创建管理员账号
                    </div>
                ) : canRegister ? (
                    <div className="auth-tabs">
                        <button
                            type="button"
                            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
                            onClick={() => switchMode('login')}
                        >
                            登录
                        </button>
                        <button
                            type="button"
                            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
                            onClick={() => switchMode('register')}
                        >
                            注册
                        </button>
                    </div>
                ) : (
                    <div className="auth-notice auth-notice-muted">
                        当前未开放注册，请联系管理员创建账号
                    </div>
                )}

                <label className="auth-field">
                    <span>用户名</span>
                    <input
                        className="auth-input"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="2-20 位中文 / 字母 / 数字"
                        autoFocus
                        autoComplete="username"
                    />
                </label>

                <label className="auth-field">
                    <span>密码</span>
                    <input
                        className="auth-input"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="至少 6 位"
                        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    />
                </label>

                {mode === 'register' && (
                    <label className="auth-field">
                        <span>确认密码</span>
                        <input
                            className="auth-input"
                            type="password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            placeholder="再次输入密码"
                            autoComplete="new-password"
                        />
                    </label>
                )}

                {mode === 'register' && firstRun && (
                    <label className="auth-field">
                        <span>初始化令牌（首次部署）</span>
                        <input
                            className="auth-input"
                            value={setupToken}
                            onChange={(e) => setSetupToken(e.target.value)}
                            placeholder="见服务器日志 / data/setup-token.txt"
                            autoComplete="off"
                        />
                    </label>
                )}

                {error && <div className="auth-error">{error}</div>}

                <button className="auth-submit" type="submit" disabled={busy}>
                    {busy ? <Loader size={15} className="auth-spin" /> : (mode === 'register' ? <UserPlus size={15} /> : <LogIn size={15} />)}
                    {busy ? '请稍候…' : (mode === 'register' ? '创建账号' : '登录')}
                </button>

                <div className="auth-footer">
                    账号数据保存在本机，不同账号互不影响
                </div>
            </form>
        </div>
    );
}
