# Muse Code ACP Bridge

`muse-code-acp-bridge` is an unofficial community adapter that exposes Meta Muse Code through the [Agent Client Protocol](https://agentclientprotocol.com/) over stdio. It is designed to run as an [acpx](https://github.com/openclaw/acpx) custom agent.

This project is not affiliated with, endorsed by, or sponsored by Meta.

## Install

```bash
npm install -g muse-code-acp-bridge
```

Register the bridge as an acpx custom agent in `~/.acpx/config.json` or a project `.acpxrc.json`:

```json
{
  "agents": {
    "muse": {
      "argv": ["muse-code-acp-bridge"]
    }
  }
}
```

The bridge defaults to the `muse` executable on `PATH`. Set `MUSE_ACP_BIN` when Muse Code is installed somewhere else or when a wrapper executable should be used.

```bash
MUSE_ACP_BIN=/path/to/muse acpx --agent muse "Review this project"
```

Node.js 22.13.0 or newer is required. Muse Code 0.2.1 is the compatibility target for the first release.

## What it does

The bridge keeps one Muse process per ACP session and translates Muse JSONL events into ACP updates. It supports:

- ACP initialization, text-only sessions, new/resumed/loaded sessions, prompts, cancellation, close, and delete.
- Working-directory binding per session.
- Serialized prompts per session with bounded queueing.
- Muse text, tool, terminal, refusal, and cancellation events.
- The `muse exec --json` process contract.
- Conservative non-interactive safety defaults for sandboxing and approval behavior.

The adapter intentionally rejects protocol features Muse Code does not support in this bridge, including images, audio, embedded resources, MCP injection, extra directories, and unsupported session controls. It also rejects prompt requests that mix unsupported content rather than silently dropping it.

## Development

```bash
npm install
npm test
npm run check
npm run smoke
# Requires Muse Code 0.2.1 and acpx@0.13.1 on the host:
bash scripts/muse-compatibility-smoke.sh
```

The tests use a deterministic fake Muse process selected with `MUSE_BRIDGE_FAKE_MUSE=1`; they do not require credentials or a live Muse account. The package is plain Node.js ESM with no build step.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MUSE_ACP_BIN` | Override the Muse executable. Defaults to `muse`. |
| `MUSE_BRIDGE_FAKE_MUSE` | Test-only fake process mode. |
| `MUSE_ACP_PROVIDER` | Test-only fake provider selector. |
| `MUSE_ACP_REASONING_EFFORT` | Override the reasoning effort passed to Muse. |
| `MUSE_ACP_SANDBOX` | Override the sandbox mode, if supported by the installed Muse version. |
| `MUSE_ACP_APPROVAL_MODE` | Override the non-interactive approval mode, if supported by the installed Muse version. |

Environment variables are passed to the child process as needed, but the bridge never writes credentials or environment values to logs.

## Relationship to acpx

acpx maps a friendly agent name such as `muse` to an external ACP process. This repository contains only the Muse Code adapter. The customized acpx skill and its documentation live in the separate [julianubico/acpx](https://github.com/julianubico/acpx) fork so upstream acpx behavior remains independently trackable.

## License

MIT. See [LICENSE](LICENSE).
