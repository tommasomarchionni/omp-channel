# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com),
and the project uses [Semantic Versioning](https://semver.org) once it reaches 1.0.

## [Unreleased]

### Added

- Initial alpha: extension for Oh My Pi with MCP push, an HTTP transport with leases and
  acknowledgements, a custom adapter module interface, a validated configuration file,
  `reply` tool, agent status reports, and interrupt and close handling.
- Integration protocol version 1 (`docs/protocol.md`) with JSON Schemas in `schema/`.
- Example MCP server (`examples/mcp-server`), example configuration and example adapter module.
