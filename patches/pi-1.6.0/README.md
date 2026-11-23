# Pi 1.6.0 `/skills` patch

This patch makes skill activation opt-in for `@earendil-works/pi-coding-agent@1.6.0`. It uses the shared
[TypeScript overlay](../../pi-overlay) and a [version-specific integration patch](../../pi-overlay/versions/1.6.0/integration.patch).
Pi 1.6.0 changed the model-resolver import next to the CLI hook; the skill-management logic and CLI/RPC wrappers
are unchanged from 1.5.2.

The [upstream manifest](../../pi-overlay/versions/1.6.0/upstream.json) pins the source release and npm package.
The builder compares the unmodified source build with the published runtime, enforces the 48-line integration budget,
and verifies the patched files against `patched.sha256`. The installer checks `baseline.sha256` and `baseline.absent`
before applying the patch. Do not apply it to another Pi version.

```bash
node scripts/build-pi-patch.mjs --version 1.6.0
node scripts/build-pi-patch.mjs --version 1.6.0 --check
```

## 1.6.0 regression checks

The generated skill-management modules and CLI/RPC wrappers are byte-identical to this fork's 1.5.2 artifacts.
The real-package suite covers opt-in loading, explicit `--skill` with `--no-skills`, catalog precedence, project
trust (including saved distrust), global mutations without project trust, portable path activation/removal,
concurrent persisted updates, diagnostics, installer idempotency, and unknown/mixed-state refusal. Offline checks
also cover interactive dispatch and the checksum-pinned bundled loader. No live Pi installation is modified.

To test against a clean Pi 1.6.0 installation without modifying it:

```bash
PI_SKILLS_TEST_PACKAGES=/path/to/clean/pi-package \
  node --test scripts/skills-catalog.test.mjs scripts/skills-patch-dispatch.test.mjs scripts/skills-patch-entrypoint.test.mjs
```

The candidate package must expose a `node_modules` directory. If npm hoists every dependency, a symlink to the
fixture installation's `node_modules` is sufficient; the tests copy the package before patching it.
