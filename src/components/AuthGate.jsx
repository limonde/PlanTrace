import { useAuth } from './AuthContext.jsx';
import { ThemeProvider } from './ThemeContext.jsx';
import LoginScreen from './LoginScreen.jsx';
import { Atom } from 'lucide-react';

function SplashScreen({ message }) {
    return (
        <div className="auth-splash">
            <div className="auth-splash-icon">
                <Atom size={30} />
            </div>
            <div className="auth-splash-title">PlanTrace</div>
            <div className="auth-splash-msg">{message}</div>
        </div>
    );
}

/**
 * Blocks the app until the session is resolved:
 *  - restoring session → splash
 *  - not logged in → LoginScreen
 *  - logged in → children (with per-user theme/data already loaded)
 */
export default function AuthGate({ children }) {
    const { user, bootState } = useAuth();

    if (bootState === 'loading') return <SplashScreen message="正在连接服务…" />;
    if (!user) return <LoginScreen />;

    return <ThemeProvider>{children}</ThemeProvider>;
}
