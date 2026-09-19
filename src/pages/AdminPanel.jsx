import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowLeft, UserPlus, ShieldCheck, ShieldOff, KeyRound, Trash2,
    Ban, CheckCircle2, Loader, RefreshCw, Users, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { useAuth } from '../components/authContext.js';
import { listUsers, createUser, updateUser, deleteUser } from '../store/authStore.js';

function formatDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AdminPanel() {
    const navigate = useNavigate();
    const { user, isAdmin, config, setAllowRegistration, logout } = useAuth();

    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busyId, setBusyId] = useState(null);

    // Create form
    const [newName, setNewName] = useState('');
    const [newPass, setNewPass] = useState('');
    const [newRole, setNewRole] = useState('user');
    const [creating, setCreating] = useState(false);

    const [togglingRegistration, setTogglingRegistration] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setUsers(await listUsers());
        } catch (err) {
            setError(err.message || '加载用户列表失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!isAdmin) { navigate('/'); return; }
        load();
    }, [isAdmin, navigate, load]);

    const handleCreate = async (e) => {
        e.preventDefault();
        setError('');
        setCreating(true);
        try {
            await createUser({ username: newName.trim(), password: newPass, role: newRole });
            setNewName('');
            setNewPass('');
            setNewRole('user');
            await load();
        } catch (err) {
            setError(err.message || '创建失败');
        } finally {
            setCreating(false);
        }
    };

    const withBusy = async (id, fn) => {
        setBusyId(id);
        setError('');
        try {
            await fn();
            await load();
        } catch (err) {
            setError(err.message || '操作失败');
        } finally {
            setBusyId(null);
        }
    };

    const handleResetPassword = (target) => {
        const pw = window.prompt(`为「${target.username}」设置新密码（至少 6 位）`);
        if (pw === null) return;
        withBusy(target.id, () => updateUser(target.id, { password: pw }));
    };

    const handleToggleRole = (target) => {
        const nextRole = target.role === 'admin' ? 'user' : 'admin';
        if (!window.confirm(`确定将「${target.username}」设为${nextRole === 'admin' ? '管理员' : '普通用户'}吗？`)) return;
        withBusy(target.id, () => updateUser(target.id, { role: nextRole }));
    };

    const handleToggleDisabled = (target) => {
        const next = !target.disabled;
        if (next && !window.confirm(`确定禁用「${target.username}」吗？该账号将无法登录。`)) return;
        withBusy(target.id, () => updateUser(target.id, { disabled: next }));
    };

    const handleDelete = (target) => {
        if (!window.confirm(`确定删除「${target.username}」吗？该账号的全部任务、日志和专注记录将被永久删除，且无法恢复。`)) return;
        withBusy(target.id, () => deleteUser(target.id));
    };

    const handleRegistrationToggle = async () => {
        setTogglingRegistration(true);
        setError('');
        try {
            await setAllowRegistration(!config.allowRegistration);
        } catch (err) {
            setError(err.message || '设置失败');
        } finally {
            setTogglingRegistration(false);
        }
    };

    if (!isAdmin) return null;

    return (
        <div className="admin-page">
            <header className="admin-header">
                <div className="admin-header-left">
                    <button className="admin-back" onClick={() => navigate('/')} title="返回">
                        <ArrowLeft size={16} />
                    </button>
                    <Users size={18} className="admin-header-icon" />
                    <div>
                        <div className="admin-title">用户管理</div>
                        <div className="admin-subtitle">
                            当前账号：{user.username}（管理员）
                        </div>
                    </div>
                </div>
                <div className="admin-header-actions">
                    <button className="admin-ghost-btn" onClick={load} title="刷新">
                        <RefreshCw size={14} /> 刷新
                    </button>
                    <button className="admin-ghost-btn" onClick={logout}>退出登录</button>
                </div>
            </header>

            {error && <div className="admin-error">{error}</div>}

            <section className="admin-card">
                <div className="admin-card-title">注册设置</div>
                <button className="admin-toggle" onClick={handleRegistrationToggle} disabled={togglingRegistration}>
                    {config.allowRegistration
                        ? <ToggleRight size={22} className="admin-toggle-on" />
                        : <ToggleLeft size={22} className="admin-toggle-off" />}
                    {config.allowRegistration ? '开放自助注册' : '仅管理员创建账号'}
                </button>
                <div className="admin-hint">
                    关闭后，登录页不再显示注册入口；管理员仍可在此页面创建账号。
                </div>
            </section>

            <section className="admin-card">
                <div className="admin-card-title">新建账号</div>
                <form className="admin-create-form" onSubmit={handleCreate}>
                    <input
                        className="auth-input"
                        placeholder="用户名"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                    />
                    <input
                        className="auth-input"
                        type="password"
                        placeholder="密码（至少 6 位）"
                        value={newPass}
                        onChange={(e) => setNewPass(e.target.value)}
                    />
                    <select className="auth-input" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                        <option value="user">普通用户</option>
                        <option value="admin">管理员</option>
                    </select>
                    <button className="auth-submit admin-create-btn" type="submit" disabled={creating}>
                        {creating ? <Loader size={14} className="auth-spin" /> : <UserPlus size={14} />}
                        创建
                    </button>
                </form>
            </section>

            <section className="admin-card">
                <div className="admin-card-title">账号列表（{users.length}）</div>
                {loading ? (
                    <div className="admin-loading"><Loader size={16} className="auth-spin" /> 加载中…</div>
                ) : (
                    <div className="admin-table-wrap">
                        <table className="admin-table">
                            <thead>
                                <tr>
                                    <th>用户名</th>
                                    <th>角色</th>
                                    <th>状态</th>
                                    <th>创建时间</th>
                                    <th className="admin-col-stats">任务 / 日志 / 专注</th>
                                    <th style={{ textAlign: 'right' }}>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                {users.map((u) => (
                                    <tr key={u.id} className={u.disabled ? 'admin-row-disabled' : ''}>
                                        <td>
                                            <span className="admin-username">{u.username}</span>
                                            {u.id === user.id && <span className="admin-self-tag">当前</span>}
                                        </td>
                                        <td>
                                            {u.role === 'admin'
                                                ? <span className="admin-role admin-role-admin"><ShieldCheck size={12} /> 管理员</span>
                                                : <span className="admin-role">普通用户</span>}
                                        </td>
                                        <td>
                                            {u.disabled
                                                ? <span className="admin-status admin-status-off">已禁用</span>
                                                : <span className="admin-status admin-status-on">正常</span>}
                                        </td>
                                        <td className="admin-muted">{formatDate(u.createdAt)}</td>
                                        <td className="admin-muted admin-col-stats">
                                            {u.stats ? `${u.stats.tasks} / ${u.stats.logs} / ${u.stats.sessions}` : '—'}
                                        </td>
                                        <td className="admin-actions">
                                            {busyId === u.id ? (
                                                <Loader size={14} className="auth-spin" />
                                            ) : (
                                                <>
                                                    <button className="admin-icon-btn" title="重置密码" onClick={() => handleResetPassword(u)}>
                                                        <KeyRound size={14} />
                                                    </button>
                                                    <button className="admin-icon-btn" title={u.role === 'admin' ? '设为普通用户' : '设为管理员'} onClick={() => handleToggleRole(u)}>
                                                        {u.role === 'admin' ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                                                    </button>
                                                    {u.id !== user.id && (
                                                        <>
                                                            <button className="admin-icon-btn" title={u.disabled ? '启用账号' : '禁用账号'} onClick={() => handleToggleDisabled(u)}>
                                                                {u.disabled ? <CheckCircle2 size={14} /> : <Ban size={14} />}
                                                            </button>
                                                            <button className="admin-icon-btn admin-icon-danger" title="删除账号" onClick={() => handleDelete(u)}>
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </>
                                                    )}
                                                </>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
}
