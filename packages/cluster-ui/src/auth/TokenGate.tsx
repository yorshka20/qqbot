import { type FormEvent, useState } from 'react';
import { Button } from '../ui/Button';
import { INPUT_CLASS } from '../ui/Field';
import { checkToken, signIn, type TokenCheck } from './session';

const CHECK_ERROR: Record<Exclude<TokenCheck, 'ok'>, string> = {
  rejected: 'Token 不对。核对 config.d 里的 clusterDaemon.auth.token 后再试。',
  unreachable: 'daemon 没有响应。确认它在运行后再试。',
};

export function TokenGate({ rejected }: { rejected: boolean }) {
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(rejected ? 'Token 已失效。重新输入一次。' : null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = token.trim();
    if (!candidate || checking) {
      return;
    }
    setChecking(true);
    setError(null);
    const result = await checkToken(candidate);
    setChecking(false);
    if (result === 'ok') {
      signIn(candidate);
    } else {
      setError(CHECK_ERROR[result]);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-17 font-medium">Agent Cluster</h1>
        <label className="flex flex-col gap-1">
          <span className="text-13 text-ink-muted">Daemon token（config.d 里的 clusterDaemon.auth.token）</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the token is the only thing this screen asks for
            autoFocus
            className={`${INPUT_CLASS} font-mono`}
          />
        </label>
        {error && <p className="text-13 text-failed">{error}</p>}
        <Button type="submit" variant="solid" disabled={checking || !token.trim()} className="justify-center py-1.5">
          {checking ? '正在验证…' : '进入控制台'}
        </Button>
      </form>
    </div>
  );
}
