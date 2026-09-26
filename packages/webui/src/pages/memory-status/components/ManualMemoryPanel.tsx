import { useEffect, useState } from 'react';
import { saveManualMemory } from '../../../api';

export function ManualMemoryPanel({
  groupId,
  userId,
  text,
  onSaved,
}: {
  groupId: string;
  userId: string;
  text: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [shown, setShown] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setShown(text);
  }, [text]);

  const startEdit = () => {
    setDraft(shown);
    setError(null);
    setNotice(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveManualMemory(groupId, userId, draft);
      setShown(draft);
      setEditing(false);
      setNotice(result.indexed ? '已保存' : '已写入文件，索引未更新');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-700">
        <h2 className="text-sm font-medium">手动记忆</h2>
        {notice && <span className="text-xs text-zinc-400">{notice}</span>}
        <div className="ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="text-xs px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving || draft === shown}
                className="text-xs px-2 py-1 rounded-md bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={startEdit}
              className="text-xs px-2 py-1 rounded-md text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-950/40"
            >
              编辑
            </button>
          )}
        </div>
      </div>
      {error && <p className="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {editing ? (
        <>
          <p className="px-4 pt-3 text-xs text-zinc-400">写成 [context] 然后换行写内容，可以有多段。</p>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={8}
            className="w-full px-4 py-3 text-sm bg-transparent outline-none resize-y font-mono"
            aria-label="手动记忆"
          />
        </>
      ) : (
        <pre className="px-4 py-3 text-sm whitespace-pre-wrap break-words font-sans">
          {shown.trim() ? shown : <span className="text-zinc-400">还没有手动记忆</span>}
        </pre>
      )}
    </section>
  );
}
