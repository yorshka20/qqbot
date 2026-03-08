export interface FileItem {
  name: string
  path: string
  isDir: boolean
  size?: number
  mtime?: number
}

export interface ListResponse {
  items: FileItem[]
}
