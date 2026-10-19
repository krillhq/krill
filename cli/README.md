# krill-rules

Find the rules your code reviewers keep repeating but nobody wrote down, and put them where your AI coding agents will read them (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot instructions).

```bash
npx krill-rules              # inside a checkout, or: npx krill-rules owner/repo
# review .krill/rules.md, then:
npx krill-rules sync
```

You need Node.js 20+ and the [GitHub CLI](https://cli.github.com) logged in, plus one of these models: [Claude Code](https://claude.com/claude-code) (uses your subscription), `ANTHROPIC_API_KEY`, or [Ollama](https://ollama.com) (free and local).

See the [full README](https://github.com/krillhq/krill#readme) for how it works and results on real repos.

MIT
