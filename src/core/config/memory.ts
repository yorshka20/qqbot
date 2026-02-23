// Memory (plugin) configuration - file-based persistence path

export interface MemoryConfig {
  /** Directory for memory files (relative to cwd). Group memory: {dir}/{groupId}/_global_.txt, user: {dir}/{groupId}/{userId}.txt */
  dir?: string;
}
