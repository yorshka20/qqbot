// Plugins configuration

export interface PluginsConfig {
  list: Array<{
    name: string;
    enabled: boolean;
    config?: any; // Each plugin has its own config structure
  }>;
}
