# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com),
and the project uses [Semantic Versioning](https://semver.org) once it reaches 1.0.

## [Unreleased]

### Changed

- Configuration errors name the unknown key, the allowed keys or values, and the allowed range.
  A configuration file that is a JSON array is refused.
- `package.json` publishes with `provenance` and public access, ships the changelog, and builds
  before packing.
- CI runs the pack check and a dependency audit; the release workflow has an opt-in npm publish job
  that uses trusted publishing.

- Oh My Pi types now come from the exact devDependency `@oh-my-pi/pi-coding-agent@19.2.1`; the
  hand-written declaration subset was removed.
- `attribution` is required on every message. There is no configuration default for it; the open
  point is documented in docs/protocol.md, section 3.4.

### Added

- Initial alpha: extension for Oh My Pi with MCP push, an HTTP transport with leases and
  acknowledgements, a custom adapter module interface, a validated configuration file,
  `reply` tool, agent status reports, and interrupt and close handling.
- Integration protocol version 1 (`docs/protocol.md`) with JSON Schemas in `schema/`.
- Oh My Pi verification script (`npm run omp:e2e`), opt-in: needs `OMP_E2E=1` and a model.
- Example MCP server (`examples/mcp-server`), example configuration and example adapter module.
