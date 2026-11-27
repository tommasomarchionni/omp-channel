# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com),
and the project uses [Semantic Versioning](https://semver.org) once it reaches 1.0.

## [Unreleased]

### Fixed

- The `reply` tool is now among the tools sent to the model (`loadMode: "essential"`). Before,
  Oh My Pi left it out, so the model could not answer and the message waited for ever.
- A run that ends normally without a reply to a message is reported as a `failure`.

## [0.2.0] - 2026-11-27

### Added

- Failed turn report: when a run ends in a model error, each message it left unanswered is
  reported to the service (`failure` event, `ChannelAdapter.failure`, `service.paths.failures`,
  `schema/failure.schema.json`). `failures.includeReason` controls the error text, which is
  cleaned of known secret shapes.

### Fixed

- The state stays `working` while Oh My Pi retries a request, instead of turning `free` between
  attempts.

## [0.1.0] - 2026-11-27

### Changed

- Configuration errors name the unknown key, the allowed keys or values, and the allowed range.
  A configuration file that is a JSON array is refused.
- `package.json` publishes with `provenance` and public access, ships the changelog, and builds
  before packing.
- CI runs the pack check and a dependency audit; the release workflow has an opt-in npm publish job
  that uses trusted publishing.
- Oh My Pi types now come from the exact devDependency `@oh-my-pi/pi-coding-agent@19.2.1`; the
  hand-written declaration subset was removed.
- `attribution` is required on every message and has no configuration default. The example server
  sends `"user"`. The effect of each value in Oh My Pi is not verified; see docs/protocol.md,
  section 3.4.

### Fixed

- The Oh My Pi check gives the extension a valid configuration. Before, the extension disabled
  itself and the check never exercised it.
- The Oh My Pi check waits up to `OMP_E2E_TURN_TIMEOUT_MS` (default 600000 ms) for each turn, so a
  slow local model is not reported as a failure.

### Added

- `/channel-status` command: shows the transport in use and the optional `describe()` text of the
  adapter (`ChannelAdapter`, docs/protocol.md section 6).
- Initial alpha: extension for Oh My Pi with MCP push, an HTTP transport with leases and
  acknowledgements, a custom adapter module interface, a validated configuration file,
  `reply` tool, agent status reports, and interrupt and close handling.
- Integration protocol version 1 (`docs/protocol.md`) with JSON Schemas in `schema/`.
- Oh My Pi verification script (`npm run omp:e2e`), opt-in: needs `OMP_E2E=1` and a model.
- Example MCP server (`examples/mcp-server`), example configuration and example adapter module.
