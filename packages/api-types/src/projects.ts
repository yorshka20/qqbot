// `/api/cluster/projects` — ProjectRegistry snapshot.

export interface ProjectRegistryEntry {
  alias: string;
  path: string;
  type: string;
  description?: string;
  hasClaudeMd: boolean;
  promptTemplateKey?: string;
  isDefault: boolean;
  isConfig: boolean;
}

export interface ProjectsResponse {
  defaultAlias: string;
  projects: ProjectRegistryEntry[];
}
