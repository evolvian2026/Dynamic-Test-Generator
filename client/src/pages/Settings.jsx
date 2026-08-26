/** Settings — account, roles and user administration (spec §29). */

import { useEffect, useState } from 'react';
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

        {can('settings:write') && <Branding />}

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

/**
 * Branding printed on exported papers.
 *
 * Kept installation-wide rather than per-test: the institution does not change
 * between papers, and asking for it on every export is how a logo ends up on
 * half the tests and missing from the other half.
 */
function Branding() {
  const toast = useToast();
  const { data, reload } = useAsync(() => api.settings.get(), []);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (data) setForm({
      institution_name: data.institution_name || '',
      paper_footer: data.paper_footer || '',
      institution_logo: data.institution_logo || null,
    });
  }, [data]);

  if (!form) return <Card title="Paper branding" className="mb-2"><Spinner label="Loading settings…" /></Card>;

  const readLogo = (file) => {
    setError(null);
    if (file.size > 1_000_000) {
      setError('That image is larger than about 1 MB. Use a smaller PNG or JPEG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, institution_logo: String(reader.result) }));
    reader.onerror = () => setError('That file could not be read.');
    reader.readAsDataURL(file);
  };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.settings.update({
        institution_name: form.institution_name.trim() || null,
        paper_footer: form.paper_footer.trim() || null,
        institution_logo: form.institution_logo,
      });
      toast.success('Branding updated. New PDF exports will use it.');
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Paper branding" className="mb-2">
      {error && <Alert variant="error">{error}</Alert>}
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="inst-name">Institution name</label>
          <input
            id="inst-name" type="text" maxLength={200} placeholder="Evolvian Institute of Technology"
            value={form.institution_name}
            onChange={(e) => setForm({ ...form, institution_name: e.target.value })}
          />
          <span className="field-hint">Printed above the test title on exported question papers.</span>
        </div>

        <div className="field">
          <label htmlFor="inst-footer">Paper footer</label>
          <input
            id="inst-footer" type="text" maxLength={300} placeholder="Confidential — for internal assessment only"
            value={form.paper_footer}
            onChange={(e) => setForm({ ...form, paper_footer: e.target.value })}
          />
          <span className="field-hint">Printed beside the page number on every page.</span>
        </div>

        <div className="field">
          <label htmlFor="inst-logo">Logo</label>
          <input
            id="inst-logo" type="file" accept="image/png,image/jpeg"
            onChange={(e) => e.target.files?.[0] && readLogo(e.target.files[0])}
          />
          <span className="field-hint">
            PNG or JPEG, under about 1 MB. The image is embedded in the database, so exports never
            reach out to a remote URL.
          </span>
        </div>

        {form.institution_logo && (
          <div className="flex-gap mb-2" style={{ alignItems: 'center' }}>
            <span className="logo-preview"><img src={form.institution_logo} alt="Institution logo preview" /></span>
            <button type="button" className="btn btn-xs" onClick={() => setForm({ ...form, institution_logo: null })}>
              Remove logo
            </button>
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save branding'}
        </button>
      </form>
    </Card>
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
