import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Session } from '../types';
import { IconLock, LogoMark } from './Icons';

export function Login({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      onSignedIn(await api.login(password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setPending(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <LogoMark />
          <h1>Mail Triage</h1>
        </div>
        <p className="muted">This server requires its app password.</p>
        <label className="field">
          <span>App password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            required
            maxLength={1024}
          />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="btn btn-primary btn-block" type="submit" disabled={pending || !password}>
          <IconLock /> {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
