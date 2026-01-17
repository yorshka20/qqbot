/**
 * Build configuration file for Bun
 * Similar to Vite's build config, but using Bun.build() API
 *
 * This allows fine-grained control over bundling, including:
 * - Code splitting configuration
 * - Custom naming patterns
 * - All dependencies are bundled (no externalization)
 */

import type { BuildConfig } from 'bun';

// Build configurations for different environments
export const buildConfigs: Record<string, BuildConfig> = {
  // Production build - bundle all dependencies
  production: {
    entrypoints: ['src/index.ts'],
    outdir: './dist',
    target: 'bun',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
    // Bundle all packages - no externalization
    packages: 'bundle',
    naming: {
      entry: '[name].js',
      chunk: '[name]-[hash].js',
      asset: '[name]-[hash].[ext]',
    },
  },

  // Development build (no minification, with sourcemaps)
  development: {
    entrypoints: ['src/index.ts'],
    outdir: './dist',
    target: 'bun',
    format: 'esm',
    minify: false,
    sourcemap: 'external',
    // Bundle all packages - no externalization
    packages: 'bundle',
    naming: {
      entry: '[name].js',
      chunk: '[name]-[hash].js',
      asset: '[name]-[hash].[ext]',
    },
  },

  // Bundle everything with code splitting enabled
  bundleAll: {
    entrypoints: ['src/index.ts'],
    outdir: './dist',
    target: 'bun',
    format: 'esm',
    minify: true,
    sourcemap: 'external',
    splitting: true,
    // Bundle all packages
    packages: 'bundle',
    naming: {
      entry: '[name].js',
      chunk: '[name]-[hash].js',
      asset: '[name]-[hash].[ext]',
    },
  },
};

// Default export for easy import
export default buildConfigs.production;
