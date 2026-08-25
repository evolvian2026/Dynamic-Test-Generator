/** Settings — account, roles and user administration (spec §29). */

import { useState } from 'react';
import { TopBar } from '../App.jsx';
import api from '../lib/api.js';
import { useAsync } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../components/Toast.jsx';
import { Card, Badge, Alert, Modal, Spinner } from '../components/ui.jsx';

export default function Settings() {
  const { user, can } = useAuth();
  const toast = useToast();

  const { data: roles } = useAsync(() => api.users.roles(), []);
  const { data: users, reload: reloadUsers } = useAsync(
    () => (can('users:read') ? api.users.list() : Promise.resolve(null)),
    [],
  );

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [newUserOpen, setNewUserOpen] = useState(false);

  const changePassword = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.auth.changePassword(currentPassword, newPassword);
      toast.success('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const updateUser = async (target, patch) => {
    try {
      await api.users.update(target.id, patch);
      toast.success(`${target.name} updated.`);
      reloadUsers();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <>
      <TopBar title="Settings" subtitle="Your account, roles and access control." />

      <div className="page page-narrow">
        <Card title="Your account" className="mb-2">
          <div className="summary-line"><span className="label">Name</span><span className="value">{user.name}</span></div>
          <div className="summary-line"><span className="label">Email</span><span className="value">{user.email}</span></div>
          <div className="summary-line">
            <span className="label">Role</span>
            <span className="value"><Badge variant="brand" >{user.role}</Badge></span>
          </div>
        </Card>

        <Card title="Change password" className="mb-2">
          <form onSubmit={changePassword}>
            <div className="form-row">
              <div className="field">
                <label htmlFor="current">Current password</label>
                <input
                  id="current" type="password" value={currentPassword} required autoComplete="current-password"
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="new">New password</label>
                <input
                  id="new" type="password" value={newPassword} required minLength={8} autoComplete="new-password"
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <span className="field-hint">At least 8 characters.</span>
              </div>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>Update password</button>
          </form>
        </Card>

        <Card title="Roles and permissions" className="mb-2" bodyClass="tight">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Role</th><th>Can</th></tr></thead>
              <tbody>
                {(roles || []).map((row) => (
                  <tr key={row.role}>
                    <td><Badge variant={row.role === user.role ? 'brand' : undefined}>{row.role}</Badge></td>
                    <td>
                      <div className="flex-gap">
                        {row.permissions.map((p) => <Badge key={p}>{p}</Badge>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-hint mt-1">
            Permissions are enforced on the server for every request — hiding a button never grants access.
          </p>
        </Card>

        {can('users:read') && (
          <Card
            title="Users"
            bodyClass="tight"
            actions={can('users:write') && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setNewUserOpen(true)}>+ Add user</button>
            )}
          >
            {!users ? <Spinner label="Loading users…" /> : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {users.map((row) => (
                      <tr key={row.id}>
                        <td>{row.name}</td>
                        <td className="small">{row.email}</td>
                        <td>
                          {can('users:write') ? (
                            <select
                              value={row.role}
                              onChange={(e) => updateUser(row, { role: e.target.value })}
                              style={{ width: 'auto' }}
                              disabled={row.id === user.id}
                            >
                              <option value="admin">admin</option>
                              <option value="creator">creator</option>
                              <option value="viewer">viewer</option>
                            </select>
                          ) : <Badge>{row.role}</Badge>}
                        </td>
                        <td>
                          <Badge variant={row.is_active ? 'success' : 'danger'}>
                            {row.is_active ? 'active' : 'disabled'}
                          </Badge>
                        </td>
                        <td>
                          {can('users:write') && row.id !== user.id && (
                            <button
                              type="button" className="btn btn-xs"
                              onClick={() => updateUser(row, { is_active: !row.is_active })}
                            >
                              {row.is_active ? 'Disable' : 'Enable'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {!can('users:read') && (
          <Alert variant="info">User administration is available to administrators.</Alert>
        )}
      </div>

      {newUserOpen && <NewUserModal onClose={() => setNewUserOpen(false)} onCreated={() => { setNewUserOpen(false); reloadUsers(); }} />}
    </>
  );
}

function NewUserModal({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'creator' });
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.users.create(form);
      toast.success(`${form.name} added as ${form.role}.`);
      onCreated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-user-form" className="btn btn-primary" disabled={busy}>Create user</button>
        </>
      }
    >
      <form id="new-user-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="u-name">Name</label>
          <input id="u-name" type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="u-email">Email</label>
          <input id="u-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="u-password">Temporary password</label>
          <input id="u-password" type="text" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <span className="field-hint">At least 8 characters. Ask them to change it after signing in.</span>
        </div>
        <div className="field">
          <label htmlFor="u-role">Role</label>
          <select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">Admin — full access including user management</option>
            <option value="creator">Test Creator — create and manage own tests</option>
            <option value="viewer">Viewer — read-only</option>
          </select>
        </div>
      </form>
    </Modal>
  );
}
