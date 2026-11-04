import { GitBranch, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { checkToken, signIn, type TokenCheck } from './session';

const CHECK_ERROR: Record<Exclude<TokenCheck, 'ok'>, string> = {
  rejected: 'Token 不对（401）。请核对 cluster.jsonc 的 auth.token。',
  unreachable: '连不上 daemon，请确认它在运行。',
};

export function TokenGate({ rejected }: { rejected: boolean }) {
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(rejected ? 'Token 已失效（401），请重新输入。' : null);

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
    <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-100 dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-5 flex flex-col gap-4"
      >
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
          <div className="font-semibold">Agent Cluster</div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Daemon token（cluster.jsonc 的 auth.token）</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the token is the only thing this screen asks for
            autoFocus
            className="w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          />
        </label>
        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={checking || !token.trim()}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
        >
          <KeyRound className="w-4 h-4" />
          {checking ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  );
}
