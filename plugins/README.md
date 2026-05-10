# Third-Party Plugins (Reserved)

This directory is reserved for **third-party / user-installed plugins** in a
future release. **It is not yet supported.** Files placed here today are not
loaded by the bot.

## Current status

- ❌ Not loaded by `PluginManager` (no scanner targets this directory).
- ❌ No marketplace / installer integration.
- ✅ The directory itself is preserved (via `.gitkeep`) so the path stays stable
  for future tooling.

## Why we are not loading it yet

First-party plugins are now loaded via a **registry consumption** model
(see `packages/bot/src/plugins/PluginManager.ts`): plugin classes register
themselves through the `@RegisterPlugin` decorator at import time, and the
manager iterates the static registry. This gives us:

- Static analysis (bundlers, IDE refactor, tree-shake).
- Co-location of service-specific plugins with their service module.
- Per-plugin failure isolation with aggregated error reporting.

The same model **cannot be applied to third-party code unmodified** without
addressing several open questions:

1. **API stability** — third-party plugins must not `import '@/...'` from
   internal source paths. We need a public SDK package
   (`@qqbot/plugin-sdk` or similar) that re-exports `PluginBase`, decorators,
   and stable types, with a versioned contract.
2. **Manifest + permission model** — each third-party plugin should ship a
   `plugin.json` declaring `name`, `version`, `entry`, `apiVersion` (semver
   against the host's `PLUGIN_API_VERSION`), declared permissions, and an
   optional checksum. The loader reads the manifest *before* importing code.
3. **User opt-in gate** — `config.jsonc` must whitelist each enabled
   third-party plugin by name, so a marketplace install cannot silently take
   effect.
4. **Failure isolation policy** — a broken third-party plugin must be
   disabled and logged, never crash bootstrap. (First-party failures still
   throw aggregate errors, because they indicate internal regressions.)
5. **Security boundary** — Bun/Node has no in-process sandbox. A loaded
   plugin can read the filesystem, make network calls, read env vars, and
   resolve any service from the DI container. Acceptable mitigations
   (signed manifests, `worker_threads` isolation, restricted RPC bus) are
   future work and must be documented before this directory accepts code.

Until those pieces land, accepting plugin code here would either bypass
the security gate or duplicate the loader logic. We would rather close
the door than leave it half-open.

## Roadmap (not yet scheduled)

- [ ] Extract a public `@qqbot/plugin-sdk` package.
- [ ] Define `PLUGIN_API_VERSION` and a manifest schema.
- [ ] Implement `ThirdPartyPluginLoader` that scans this directory, validates
      manifests, gates by config whitelist, dynamic-imports the entry, and
      writes into the same plugin registry.
- [ ] Decide on a security tier (signed manifests at minimum; worker-thread
      isolation if engineering capacity allows).
- [ ] Marketplace tooling (download, verify, install into this directory) is
      a separate component layered on top of the loader.

## For contributors

If you are writing a plugin **inside this repository**, do **not** put it
here. First-party plugins live under
`packages/bot/src/plugins/plugins/` (or co-located under their owning
service, e.g. `packages/bot/src/services/claudeCode/plugins/`). They are
discovered via the registry barrel
(`packages/bot/src/plugins/index.ts`), not via filesystem scan.

If you want to experiment with third-party loading early, please open a
ticket / discussion before adding loader code — the open questions above
need answers first.
