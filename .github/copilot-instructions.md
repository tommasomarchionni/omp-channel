# Instructions for GitHub Copilot and code agents

- Write code, comments and documentation in English.
- Keep the integration contract in `docs/protocol.md`, `schema/` and `src/protocol.ts` consistent.
- Add a test for every behaviour change; for a bug, write the failing test first.
- Use `node --import tsx --test` tests under `test/`; no network calls in unit tests.
- Never commit secrets or personal paths. Use `EXAMPLE_CHANNEL_KEY` and `chat.example.com` in examples.
- Do not add tool or assistant attribution to commits or pull requests.
- Run `npm run check` before finishing.
