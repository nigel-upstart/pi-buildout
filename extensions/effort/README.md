# `/effort`

Provides a TUI picker for pi's thinking level. The selection can apply only to the current session or also update the
global `defaultThinkingLevel` setting.

With pi 0.82.0 and newer, the picker uses the current model's `reasoning` and provider-verified `thinkingLevelMap`
metadata, so unsupported effort levels are hidden and cannot be selected. Older pi versions retain the historical full
list.

## Install

Run `scripts/install-extensions.sh` from the repository root, then use `/reload` in pi.

## Test

```bash
node --test extensions/effort/index.test.mjs
```
