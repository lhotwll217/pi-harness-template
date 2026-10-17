# Vendored: writing-for-agents

A verbatim copy of the `writing-for-agents` skill from
[lhotwll217/skills](https://github.com/lhotwll217/skills), the owner's fork of Matt Pocock's
skills. The agent definition loads it in every session as `skill:writing-for-agents`.

- **Upstream:** https://github.com/lhotwll217/skills, path
  `plugins/mattpocock-skills/skills/productivity/writing-for-agents`
- **Synced from:** `main` @ `e5e80202789fdb0bc8ec02d478937ec39f8cbe94`

## Rules

- Change the skill upstream, then copy it here again and update **Synced from**.
- Copied: `SKILL.md`, `SKILL-MECHANICS.md`, and `scripts/jev-lint.py`, plus the upstream
  `LICENSE` (MIT, Matt Pocock). Left out: `agents/openai.yaml`, which configures Codex and
  which Pi does not read.
- `scripts/jev-lint.py` runs the `jev` CLI, which the harness does not install.

## Verify this copy

```sh
SRC=plugins/mattpocock-skills/skills/productivity/writing-for-agents
for f in SKILL.md SKILL-MECHANICS.md scripts/jev-lint.py; do
  git -C <skills checkout> show e5e80202789fdb0bc8ec02d478937ec39f8cbe94:$SRC/$f | diff - src/agent/skills/writing-for-agents/$f
done
```
