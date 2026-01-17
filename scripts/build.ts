#!/usr/bin/env bun
/**
 * Build script using Bun.build() API
 * Similar to Vite's build process, but using Bun's native bundler
 *
 * Usage:
 *   bun run scripts/build.ts [production|development|bundleAll]
 */

import { buildConfigs } from '../build.config';

const buildType = process.argv[2] || 'production';
const config = buildConfigs[buildType];

if (!config) {
    console.error(`Unknown build type: ${buildType}`);
    console.error(`Available types: ${Object.keys(buildConfigs).join(', ')}`);
    process.exit(1);
}

console.log(`Building with config: ${buildType}`);
console.log(`Entrypoints: ${config.entrypoints.join(', ')}`);
console.log(`Output directory: ${config.outdir}`);
console.log(`Bundling mode: ${config.packages === 'bundle' ? 'All dependencies bundled' : 'External'}`);
if (config.splitting) {
    console.log(`Code splitting: Enabled`);
}

const result = await Bun.build(config);

if (result.success) {
    console.log('\n✅ Build successful!');
    console.log(`Output files: ${result.outputs.length}`);

    // Show bundle sizes
    for (const output of result.outputs) {
        const sizeKB = (output.size / 1024).toFixed(2);
        const sizeMB = (output.size / 1024 / 1024).toFixed(2);
        const sizeStr = output.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;
        console.log(`  - ${output.path}: ${sizeStr}`);
    }

    if (result.logs.length > 0) {
        console.log('\nBuild logs:');
        for (const log of result.logs) {
            console.log(`  ${log.message}`);
        }
    }
} else {
    console.error('\n❌ Build failed!');
    for (const message of result.logs) {
        console.error(`  ${message.message}`);
    }
    process.exit(1);
}
