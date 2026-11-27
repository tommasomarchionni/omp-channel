# Releasing

A release is made by hand from the **Release** workflow. Nothing is published automatically.

## Before the first release (once)

These steps need the maintainer's accounts and are not done by the repository:

1. The repository account (`tommasomarchionni`) is set in `package.json`, `.github/CODEOWNERS`,
   `.github/ISSUE_TEMPLATE/config.yml` and the README badges. Change them together if the
   repository moves to an organization.
2. Decide the npm package name and publish scope (the name `omp-channel` may be taken or may be
   better under a scope).
3. On npmjs.com add a **trusted publisher** for the package: owner, repository, workflow file name
   `release.yml` (exact, with the extension). The `repository.url` in `package.json` must match
   the repository exactly. A first publish with a token may be needed to create the package;
   after that, disallow tokens in the package settings.
4. Close or accept the open rows in [omp-verification.md](omp-verification.md), or keep the
   README statement of the gap.

## Each release

1. Update `version` in `package.json` and move the `Unreleased` entries of `CHANGELOG.md` under the
   new version and date, in a pull request.
2. After it is merged, run the **Release** workflow with that version. It checks that the input
   equals `package.json`, runs `npm run check` and creates the tag and the GitHub release.
3. To publish to npm, tick `publish`. The job uses OIDC (`id-token: write`) with npm 11.5.1 or
   later on Node 24, so no token is stored. Provenance is attached automatically for a public
   repository and a public package.

Check a release locally without publishing: `npm run pack:check`.
