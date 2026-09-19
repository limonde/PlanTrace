import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    fetchAuthConfig,
    fetchMe,
    login as apiLogin,
    register as apiRegister,
    saveAuthConfig,
    bootstrapUser,
    doLogout,
} from '../store/authStore.js';
import { resetUserData } from '../store/storage.js';
import { clearActiveSessionSS } from '../store/atomicStore.js';
import { AuthContext } from './authContext.js';

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [config, setConfig] = useState({ allowRegistration: true, hasUsers: false });
    const [bootState, setBootState] = useState('loading'); // 'loading' | 'ready'

    // Restore session on mount
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const cfg = await fetchAuthConfig();
                if (!cancelled) setConfig(cfg);

                try {
                    let me = await fetchMe();
                    me = await bootstrapUser(me);
                    if (!cancelled) setUser(me);
                } catch (err) {
                    if (err.status !== 401) console.warn('会话恢复失败:', err.message);
                }
            } catch (err) {
                console.warn('无法连接 PlanTrace 服务:', err.message);
            } finally {
                if (!cancelled) setBootState('ready');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const login = useCallback(async (username, password) => {
        let me = (await apiLogin(username, password)).user;
        me = await bootstrapUser(me);
        setUser(me);
        setConfig((c) => ({ ...c, hasUsers: true }));
        return me;
    }, []);

    const register = useCallback(async (username, password, setupToken) => {
        let me = (await apiRegister(username, password, setupToken)).user;
        me = await bootstrapUser(me);
        setUser(me);
        setConfig((c) => ({ ...c, hasUsers: true, setupRequired: false }));
        return me;
    }, []);

    // Session expired / revoked on the server → drop back to the login screen
    useEffect(() => {
        const onUnauthorized = () => {
            resetUserData();
            clearActiveSessionSS();
            setUser(null);
        };
        window.addEventListener('plantrace:unauthorized', onUnauthorized);
        return () => window.removeEventListener('plantrace:unauthorized', onUnauthorized);
    }, []);

    const logout = useCallback(async () => {
        await doLogout();
        setUser(null);
    }, []);

    const setAllowRegistration = useCallback(async (allow) => {
        await saveAuthConfig(allow);
        setConfig((c) => ({ ...c, allowRegistration: allow }));
    }, []);

    const value = useMemo(() => ({
        user,
        config,
        bootState,
        isAdmin: user?.role === 'admin',
        login,
        register,
        logout,
        setAllowRegistration,
    }), [user, config, bootState, login, register, logout, setAllowRegistration]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
