---

title: omp-channel
description: Connect a service to an Oh My Pi agent session.
---

omp-channel is an extension for [Oh My Pi](https://github.com/can1357/oh-my-pi). It lets an
external service send messages to an agent session and receive its answers. It is independent of
any product: a service implements the protocol, or an adapter module for its own protocol.

## Install

```sh
omp install omp-channel
```

Then start a session and run `/channel-status` to see the transport in use.

## Documents

- [Integration protocol]({{ site.baseurl }}/protocol.html): the contract between a service and the
  agent, version 1. Its JSON Schemas are in the [repository](https://github.com/tommasomarchionni/omp-channel/tree/main/schema).
- [Verification in Oh My Pi]({{ site.baseurl }}/omp-verification.html): what was checked in a real
  session, and what was not.
- [Releasing]({{ site.baseurl }}/releasing.html): how a release is made.
- [Changelog](https://github.com/tommasomarchionni/omp-channel/blob/main/CHANGELOG.md) and [source code](https://github.com/tommasomarchionni/omp-channel).

Licensed under Apache-2.0.
