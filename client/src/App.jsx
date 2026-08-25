import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CreateTest from './pages/CreateTest.jsx';
import QuestionBank from './pages/QuestionBank.jsx';
import Templates from './pages/Templates.jsx';
import GeneratedTests from './pages/GeneratedTests.jsx';
import TestDetail from './pages/TestDetail.jsx';
import Analytics from './pages/Analytics.jsx';
import Settings from './pages/Settings.jsx';
import { Spinner } from './components/ui.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧', end: true },
  { to: '/create', label: 'Create Test', icon: '＋', permission: 'tests:write' },
  { to: '/questions', label: 'Question Bank', icon: '☰' },
  { to: '/templates', label: 'Test Templates', icon: '❑' },
  { to: '/tests', label: 'Generated Tests', icon: '✓' },
  { to: '/analytics', label: 'Analytics', icon: '◔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

function Sidebar() {
  const { user, logout, can } = useAuth();
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <strong>Test Generator</strong>
        <span>QID-driven</span>
      </div>
      <nav className="sidebar-nav">
        {NAV.filter((item) => !item.permission || can(item.permission)).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="user-name">{user.name}</div>
        <div className="user-role mb-1">{user.role}</div>
        <button type="button" className="btn btn-sm btn-block" onClick={logout}>Sign out</button>
      </div>
    </aside>
  );
}

/** Blocks a route the current role may not use, server checks notwithstanding. */
function RequirePermission({ permission, children }) {
  const { can } = useAuth();
  if (permission && !can(permission)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="login-screen">
        <div className="login-card center"><Spinner label="Loading your workspace…" /></div>
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <Routes location={location}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/create" element={<RequirePermission permission="tests:write"><CreateTest /></RequirePermission>} />
          <Route path="/questions" element={<QuestionBank />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/tests" element={<GeneratedTests />} />
          <Route path="/tests/:id" element={<TestDetail />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export function TopBar({ title, subtitle, actions }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="topbar-actions">{actions}</div>}
    </header>
  );
}
