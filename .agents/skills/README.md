# Vendored agent skills

Shared skills for every coding agent that works in this repository. Codex discovers this directory natively; Claude Code reads it through the `.claude/skills` symlink.

| Source | Version | Skills | License |
|---|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | 6.3.0 | brainstorming, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers, verification-before-completion, writing-plans, writing-skills | LICENSE.superpowers |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | 4.9.0 | ponytail, ponytail-audit, ponytail-debt, ponytail-gain, ponytail-help, ponytail-review | LICENSE.ponytail |
| [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) | 0.3.0 | i-have-adhd | LICENSE.i-have-adhd |

Do not edit vendored skills in place. To update, install the newer plugin version in Claude Code, copy `skills/*` from the plugin cache under `~/.claude/plugins/cache/` back here, and bump the version in this table.

Repository-specific skills go in their own `<name>/SKILL.md` directory alongside these.
