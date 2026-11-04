# Add abworks-dev/dsh-hooks

Adds **DSH Hooks**, a local command lifecycle plugin for DeepSeek Harness.

- Repository: https://github.com/abworks-dev/dsh-hooks
- Release: https://github.com/abworks-dev/dsh-hooks/releases/tag/v0.19.1
- Category: workflow
- Visual rule editing, explicit user/project scope, reviewed executable/file fingerprints, restricted Codex JSON/TOML imports and selected-source change checks.
- Twelve DSH event mappings; ten support opt-in metadata-only background notifications. These mappings are not full Codex protocol compatibility.
- Synchronous PreToolUse deny and opt-in PermissionRequest deny policies never automatically approve requests.
- Five documented recipes: local audit, command policy, notification, model usage and project check. Test suite: 446 passing tests; OS notification delivery is not claimed as verified.
- Local scripts are trusted code, not sandboxed. Import/save defaults are disabled and untrusted.
- Prebuilt GitHub Release tarball; no npm publication required.
- Repository has the `dsh-plugin` topic and is older than 24 hours.

Only `data/plugins/abworks-dev__dsh-hooks.yml` is added. Generated READMEs are not edited.
