import { getFileApiBase } from './config'
import type { ListResponse } from './types'

function apiBase(): string {
  return getFileApiBase()
}

export async function listFiles(path: string): Promise<ListResponse> {
  const params = new URLSearchParams()
  if (path) {
    params.set('path', path)
  }
  const res = await fetch(`${apiBase()}/list?${params}`)
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `List failed: ${res.status}`)
  }
  return res.json() as Promise<ListResponse>
}

export async function deleteFile(path: string): Promise<void> {
  const res = await fetch(`${apiBase()}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Delete failed: ${res.status}`)
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  const res = await fetch(`${apiBase()}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Move failed: ${res.status}`)
  }
}

export async function renameFile(path: string, newName: string): Promise<void> {
  const res = await fetch(`${apiBase()}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, newName: newName.trim() }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Rename failed: ${res.status}`)
  }
}
