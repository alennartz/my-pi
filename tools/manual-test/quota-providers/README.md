# quota-providers

Drive the quota-only extension through a real `pi --mode rpc` process and the
executable usage runner. The harness registers a local complete provider and a
deterministic quota source, so it tests provider attachment, stream blocking,
soft-cap bypass, `/quota`, unattached-provider isolation, and atomic usage-cache
persistence without spending a live account quota. If `LLMGATEWAY_API_KEY` is
set, it also starts a real `llmgateway` session and checks provider/model
resolution.

## Invocation

```sh
node tools/manual-test/quota-providers/run.mjs [--keep] [--timeout <sec>] [--workdir <dir>]
```

`QP_GATEWAY_MODEL` overrides the model used by the live Gateway probe.
`QP_VERBOSE=1` forwards child pi stderr. Exit 0 means every runnable check
passed. The JSON result on stdout includes `checks`, `observed`, and
`limitations`; phase logs go to stderr.

## Prerequisites

`pi` must be on `PATH` and this repository must be loadable as a pi package.
The local-provider phases need no credentials. The Gateway phase needs
`LLMGATEWAY_API_KEY` and a currently available model.
