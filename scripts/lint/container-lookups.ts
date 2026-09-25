// Flags run-time DI container lookups in code that should take its dependencies through the
// constructor. The rule and its exceptions are documented in docs/ARCHITECTURE.md
// ("Constructor injection vs. getContainer().resolve() at run time").
//
// Paths where lookups are the norm (plugins, the composition root and startup steps, tests,
// static-server backends) are allowed wholesale. Anywhere else, a lookup must carry a marker
// on the same line or the line above naming which documented exception it is:
//
//   // container-lookup: <registry|not-di-built|plugin-state|optional-service|startup> <why>
//
// Usage: bun run scripts/lint/container-lookups.ts   (exit 1 on any unmarked lookup)

import { relative } from 'node:path';
import { Glob } from 'bun';

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC_GLOB = 'packages/bot/src/**/*.ts';

const CATEGORIES = ['registry', 'not-di-built', 'plugin-state', 'optional-service', 'startup'] as const;

/** Exceptions 1, 2 and 4 of the documented rule, by location. */
const ALLOWED_PATHS: RegExp[] = [
  // 1. Plugins: built by PluginManager, deliberately outside DI.
  /^packages\/bot\/src\/plugins\/plugins\//,
  /^packages\/bot\/src\/integrations\/[^/]+\/plugins\//,
  /^packages\/bot\/src\/services\/[^/]+\/plugins\//,
  // 2. Composition root and startup steps.
  /^packages\/bot\/src\/core\/(bootstrap|app|wiring|DIContainer)\.ts$/,
  /Initializer\.ts$/,
  /^packages\/bot\/src\/cli\//,
  // 4. Static-server backends: built by the server's backend registry, not by DI.
  /^packages\/bot\/src\/services\/staticServer\/backends\//,
  // Tests build their own graphs.
  /\/__tests__\//,
  /\.test\.ts$/,
];

const LOOKUP = /\bgetContainer\(\)/;
// tsyringe's global container is reached only through getContainer() (core/DIContainer.ts).
const RAW_CONTAINER_IMPORT = /^\s*import\s*\{[^}]*\bcontainer\b[^}]*\}\s*from\s*'tsyringe'/;
const MARKER = /\/\/\s*container-lookup:\s*([a-z-]+)\s+\S/;

/** The line with comments and string literals blanked, so only real code is matched. */
function codeOnly(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return '';
  }
  return line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""').replace(/\/\/.*$/, '');
}

function markerCategory(line: string | undefined): string | null {
  const m = line ? MARKER.exec(line) : null;
  return m ? m[1] : null;
}

const problems: string[] = [];
for await (const file of new Glob(SRC_GLOB).scan({ cwd: ROOT })) {
  const path = relative(ROOT, `${ROOT}${file}`);
  if (ALLOWED_PATHS.some((re) => re.test(path))) {
    continue;
  }
  const lines = (await Bun.file(`${ROOT}${file}`).text()).split('\n');
  lines.forEach((line, i) => {
    if (RAW_CONTAINER_IMPORT.test(line)) {
      problems.push(`${path}:${i + 1}: imports tsyringe's container directly; use getContainer()\n    ${line.trim()}`);
      return;
    }
    if (!LOOKUP.test(codeOnly(line))) {
      return;
    }
    const category = markerCategory(line) ?? markerCategory(lines[i - 1]);
    if (category && (CATEGORIES as readonly string[]).includes(category)) {
      return;
    }
    const why = category ? `unknown category "${category}"` : 'no container-lookup marker';
    problems.push(`${path}:${i + 1}: ${why}\n    ${line.trim()}`);
  });
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} run-time container lookup(s) outside plugins and the composition root:\n`);
  console.error(problems.join('\n'));
  console.error(`
An object the container builds, whose dependencies exist when it is built, takes them
through its constructor (@inject). Inject it instead.

If this lookup really is one of the documented exceptions (docs/ARCHITECTURE.md,
"Constructor injection vs. getContainer().resolve() at run time"), say which one on the
same line or the line above:

  // container-lookup: <${CATEGORIES.join('|')}> <why>
`);
  process.exit(1);
}
console.log('✓ container lookups: every run-time lookup is a documented exception');
