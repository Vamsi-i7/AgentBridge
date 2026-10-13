# macOS Accessibility Helper Build Artifacts Cleanup Guide (AR-09)

## Executive Summary
During initial development, Swift Package Manager build artifacts under `tools/macos-accessibility-helper/.build/` were committed to the Git index (2,890 tracked files, comprising intermediate object files, module caches, and symbols).

Per the Hard Rules of this mission:
- No git commits, index staging, or history modifications are performed autonomously.
- `.gitignore` has been updated with `tools/macos-accessibility-helper/.build/` to prevent newly compiled files from appearing as untracked.
- Runtime dependency analysis confirms that `src/control-plane/swift-ax-bridge.js` resolves the checked-in standalone binary `tools/macos-accessibility-helper/bridge-ax-helper` if `.build` is removed, ensuring zero runtime impact.

---

## Recommended Human Action

When the human operator chooses to commit working tree changes, run the following command to remove the tracked `.build/` tree from the Git index without deleting local files from disk:

```bash
git rm -r --cached tools/macos-accessibility-helper/.build
```

Then commit the hygiene change:
```bash
git commit -m "chore(build): untrack Swift build artifacts and ignore .build directory"
```

---

## Tracked Artifact Inventory Summary

- **Total tracked files in `.build`:** 2,890 files
- **Primary artifact directories:**
  - `tools/macos-accessibility-helper/.build/arm64-apple-macosx/release/`
  - `tools/macos-accessibility-helper/.build/ModuleCache/`
  - `tools/macos-accessibility-helper/.build/out/Products/Release/`
- **Helper binary resolution order in runtime (`src/control-plane/swift-ax-bridge.js`):**
  1. `BUILT_HELPER_BIN`: `tools/macos-accessibility-helper/.build/out/Products/Release/bridge-ax-helper` (if present)
  2. `CHECKED_IN_HELPER_BIN`: `tools/macos-accessibility-helper/bridge-ax-helper` (fallback standalone binary, 334 KB)
