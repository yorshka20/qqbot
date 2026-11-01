// `/api/files` — output-directory file manager.

/** One entry of a directory listing; `path` is relative to the served root. */
export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

/** `GET /api/files/list` */
export interface ListResponse {
  items: FileItem[];
}

/** `POST /api/files/move` */
export interface MoveBody {
  from: string;
  to: string;
}

/** `POST /api/files/rename` */
export interface RenameBody {
  path: string;
  newName: string;
}
