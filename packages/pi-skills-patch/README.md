# @upstart/pi-skills-patch

Alpha standalone package for the versioned Pi `/skills` runtime patch. After installing this npm package globally from
the authenticated CodeArtifact registry
(`npm install -g @upstart/pi-skills-patch@0.1.0-alpha.0 --registry "$REGISTRY"`), run `pi-skills-patch` to locate the
installed `@earendil-works/pi-coding-agent`, verify the exact version and baseline checksums, and apply the
corresponding patch. It refuses unknown/mixed states. Set `PI_PACKAGE_DIR` when Pi cannot be located automatically.
**This modifies the installed Pi package; it does not install extensions.**

The router/OTel bundle is separate: `pi install npm:@upstart/pi-router-otel@0.1.0-alpha.0`. Clear, effort, backlinks,
and subagents have separate à-la-carte packages. See
[release instructions](https://github.com/nigel-upstart/pi-buildout/blob/main/packages/README.md) for all install and
manual release steps.
