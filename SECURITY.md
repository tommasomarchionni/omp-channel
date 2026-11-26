# Security policy

## Supported versions

Only the latest released version receives security fixes. Version 0.x is alpha.

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately through
**GitHub Security Advisories**: open the repository's "Security" tab and choose "Report a
vulnerability". If that option is not available, open a regular issue that asks for a private
contact, without any details of the problem.

Please include:

- the version or commit, and the Node.js and Oh My Pi versions;
- steps to reproduce, or a minimal test;
- the impact you expect.

We aim to acknowledge a report within 5 working days and to publish a fix or a mitigation as soon
as it is verified.

## Scope

In scope: the extension code in `src/`, the example server in `examples/`, the published schemas,
and the handling of keys, inbound text and replies.

Out of scope: the services that implement the protocol, Oh My Pi itself (report to its own
project), and the models that an agent uses.

## Handling of secrets

The service key is read from an environment variable or a file and is never logged or returned to
the model. Never put a real key in an issue, a pull request, or a configuration file committed to
the repository.
