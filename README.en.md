# Snap

A local-first desktop AI workspace for project context, visible Agent execution, Todo and knowledge workflows.

[Website](https://shuaishuaisylas.github.io/snap/) · [Download 0.20.0](https://github.com/shuaishuaisylas/snap/releases/tag/v0.20.0)

This release provides a macOS Apple Silicon DMG and ZIP. It uses an independent `~/.snap` data directory and does not import other clients' accounts or projects. Bring your own model provider and API key. The package is ad hoc signed, not notarized by Apple; review macOS Privacy & Security if Gatekeeper blocks it.

The scenic startup background has been removed. Core workflows include contextual references, execution traces with optional model explanations, project memory, Todo/calendar, local scheduled tasks, Obsidian, files and terminal tools. Four document Skills without redistribution permission are excluded.

Use Bun 1.3.14: `bun install --frozen-lockfile`, then `bun run electron:dev`. Build instructions and practical limits are in [README.md](README.md). Original authorship and modification notices are retained in [NOTICE](NOTICE); the project is distributed under [LICENSE](LICENSE).
