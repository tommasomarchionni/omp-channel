# Working rules for agents

These rules apply to any automated agent working in this repository.

1. **No attribution.** Do not add a line that names a tool or an assistant to commits, pull
   requests, issues, or files. Write the commit message only in the Conventional Commits form.
2. **Tests first for a fix.** Write a test that fails on the current code, then fix the code, then
   check that the test passes.
3. **No secrets.** Never write a key, token or real service URL with credentials into the repository,
   a test, a log, or an example. Examples use `example-service`, `chat.example.com` and
   `EXAMPLE_CHANNEL_KEY`.
4. **Keep the contract in step.** A change to a message, a field or a limit changes
   `docs/protocol.md`, `schema/`, and `src/protocol.ts` together.
5. **Do not overstate.** Say what was run and what was not. An unrun check is not a pass.
6. **Run the gates.** `npm run check` before reporting a change as done.
7. **Scope.** Do not change unrelated files or the public API without saying so.
