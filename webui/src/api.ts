import type { ListResponse } from './types'

export async function listFiles(path: string): Promise<ListResponse> {
  const params = new URLSearchParams()
  if (path) {
    params.set('path', path)
  }
  const res = await fetch(`/api/files/list?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List failed: ${res.status}`)
  }
  return res.json() as Promise<ListResponse>
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Delete failed: ${res.status}`)
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  const res = await fetch('/api/files/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Move failed: ${res.status}`)
  }
}
