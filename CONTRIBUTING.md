# Contributing

Thank you for helping. This project is small; the rules below keep it that way.

## Ground rules

- Open an issue before a large change, so the design can be agreed first.
- Keep changes focused. One pull request should do one thing.
- Protocol changes change `docs/protocol.md`, `schema/`, and `src/protocol.ts` in the same pull
  request. The three must agree; tests in `test/schema.test.ts` check that they do.
- Behaviour changes come with a test. A bug fix starts with a test that fails on the current code.
- Do not commit secrets, real service URLs with keys, or personal paths.

## Setup

Use the Node.js version in `.nvmrc` (22) or any version from 20.

```sh
npm ci
npm run check
```

`npm run check` runs the typecheck, the linter, the format check and the tests. Run the single
commands while you work (`npm test`, `npm run lint`) and the full check before you push.

## Commits and pull requests

- Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat(protocol): ...`, `fix(http): ...`, `docs: ...`, `test: ...`, `chore: ...`.
- The pull request title is checked by the `pr-title` workflow.
- The pull request template asks what was verified and how.
- Do not add generated-by or tool attribution lines to commits or pull requests.
- Add a line under `Unreleased` in CHANGELOG.md for a visible change. Versions are changed only when a release is prepared (see docs/releasing.md).

## Tests

- Unit tests run without network access.
- The HTTP transport end-to-end test uses a server bound to `127.0.0.1` that simulates a service.
  It never contacts an external host.
- `npm run omp:e2e` runs real Oh My Pi against a model you choose. It needs `OMP_E2E=1` and
  `OMP_E2E_MODEL`, so it never runs in CI or by accident. See docs/omp-verification.md.
- Do not skip or retry tests to make them pass. Fix the cause.

## Style

`.editorconfig` and `biome.json` define the layout. Run `npm run format` before committing.
Comments and documentation are in English.
