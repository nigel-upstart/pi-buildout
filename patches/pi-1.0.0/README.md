# Pi 1.0.0 `/skills` patch

Generated from the clean published `@earendil-works/pi-coding-agent@1.0.0` package and the TypeScript overlay in
[`pi-overlay/`](../../pi-overlay). The shared skill-management logic is unchanged: discovered skills form an inactive
catalog, with explicit global, repository, session, and CLI activation. CLI and interactive commands share catalog,
trust, path normalization, configuration validation, and serialized configuration updates.

## Regenerating

Do not hand-edit the generated artifacts:

```bash
node scripts/build-pi-patch.mjs --version 1.0.0
node scripts/build-pi-patch.mjs --version 1.0.0 --check
npm run patches:check
```

[`upstream.json`](../../pi-overlay/versions/1.0.0/upstream.json) pins the release source archive, npm tarball, their
checksums, the npm `gitHead`, TypeScript 7.0.2, and upstream's workspace build order, including the new codemode and MCP
packages. Generation verifies upstream's published `SHA256SUMS`, reproduces every tracked unmodified runtime file
byte-for-byte, and enforces a 48-line edit budget on pre-existing upstream runtime files.

## Contents and installation

- `skills.patch`: generated runtime and documentation changes.
- `baseline.sha256`: clean published files, including the unchanged `dist/bundle/cli.js` loader.
- `baseline.absent`: the two skill-management modules added by the overlay.
- `patched.sha256`: the complete installed file set and expected patched checksums.

Pi 1.0.0 retains the 0.87.1 bin layout: `dist/bundle/cli.js` enables Node's compile cache and requires
`dist/bundle/cli-runtime.js`. The patch replaces that runtime and the `./rpc-entry` export's `dist/bundle/rpc-entry.js`
with wrappers around the patched unbundled runtime. Both manifests pin the untouched loader. The published CLI,
`pi skills`, CLI RPC children (`--mode rpc`), and the RPC export therefore reach the same patched skill loader.

`scripts/install-extensions.sh` selects this directory automatically for Pi 1.0.0. It verifies the version and clean
baseline, stages and checksums the patch, replaces files atomically with rollback, and leaves matching patched installs
unchanged. Unknown or mixed states are rejected. This first 1.0.0 patch has no historical upgrade states.

## Tests

The declaration, dispatch, and bundled-entrypoint tests include this version. The real package tests exercise catalog
sources and precedence, project trust, activation, path normalization, concurrent global/repository updates, checksums,
and installer idempotence. `scripts/skills-patch-rpc.test.mjs` also exercises opt-in loading, `--no-skills`, and explicit
`--skill` through both real RPC entrypoints. CI installs a separate clean 1.0.0 package for these integration tests.
For local tests, supply a clean package with resolvable dependencies to avoid skipping them:

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/clean/pi-coding-agent-1.0.0 npm test
```

The package must contain the published `package.json`, `dist/`, `docs/`, and a resolvable `node_modules/`; a symlink to
its dependency directory is sufficient. Tests only read the clean package and patch temporary copies. Development
dependencies remain pinned to Pi 0.87.1; this patch does not claim 1.0.0 compatibility for every repository extension.

Apply this patch only to Pi 1.0.0; other releases require their own versioned overlay and baseline.
