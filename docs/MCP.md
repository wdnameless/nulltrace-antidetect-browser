# MCP server

NullTrace exposes an MCP (Model Context Protocol) server so an AI agent can drive the
browser directly: create and launch profiles, navigate, click, type, take screenshots, read
the page, manage proxies and extensions, run flows, and touch cookies.

## Getting a server your agent can run

**Automation API panel → Download MCP.** The app asks for a folder, writes a
self-contained server into `<folder>/nulltrace-mcp`, and copies the agent configuration to
the clipboard. A `nulltrace-mcp.zip` sits beside it for moving to another machine.

The bundle vendors its runtime dependencies (`express`, `puppeteer-core`, `@antidetect/sdk`
and their transitive packages — about 6 MB), so **there is no `npm install` step**. The only
requirement is a Node runtime; the Windows build also ships `node.exe` next to the shell and
the generated `run.cmd` points at it.

## Pointing your agent at it

Paste this into the client's MCP configuration — Claude Desktop uses
`%APPDATA%\Claude\claude_desktop_config.json`, and most other clients accept the same shape:

```json
{
  "mcpServers": {
    "nulltrace": {
      "command": "node",
      "args": ["C:\\path\\to\\nulltrace-mcp\\index.js"],
      "env": {
        "ANTIDETECT_API_URL": "http://127.0.0.1:50325",
        "ANTIDETECT_API_TOKEN": "<the app's API key>",
        "ANTIDETECT_MCP_SCOPE": "standard"
      }
    }
  }
}
```

The app generates exactly this, with the real values filled in. `index.js` hands off to the
compiled server under `mcp/dist/`, which must be the process's main module — it starts only
when `require.main === module`.

The token is the running instance's API key, shown masked in the Automation API panel. It
changes if the app's data folder is reset; regenerate the bundle or read the current key
from the panel if calls start returning 401.

## How it runs

Four pieces, and the boundaries between them are where the bugs live.

**The app owns the lifecycle.** `src/main/mcpService.ts` is a singleton in the backend. It
picks a free loopback port, resolves the entry, spawns `node <entry>` as a child process, and
waits for the port to accept a connection before reporting success — `running` describes a real
socket, not a spawn that was merely attempted. If the child dies, the status flips back on its
own. The child's stderr is captured, so a failed start is reportable instead of a toggle that
does nothing.

**Where the entry lives.** `mcp/dist/mcp/src/index.js` — one directory deeper than expected,
because `mcp/src/browser.ts` imports from `../../src/main/motion/*`, which makes TypeScript
compute a project root above `mcp/`. It is never resolved from `process.cwd()`: in a portable
install the working directory is wherever the operator launched the exe from, so a
cwd-relative path cannot point at the app's own files. The candidates are the explicit
override, the bundled resources directory, then the directories around the running executable.
Node's own resolution also needs help: the entry sits in `mcp/dist/...` while its dependencies
live in a sibling `dist/node_modules`, which is not an ancestor of the entry, so `mcpService`
sets `NODE_PATH` from the roots the layout actually uses.

**The server is a client.** `mcp/src/tools.ts` talks to the app's own Local API through
`@antidetect/sdk` using `ANTIDETECT_API_URL` and `ANTIDETECT_API_TOKEN`. Browser control goes
the rest of the way over the profile's CDP endpoint, which the app already exposes. Nothing
listens beyond loopback, in either direction.

**Two transports, one implementation.** `stdio` (what a desktop agent client uses, and what
the generated bundle entry hands off to) and HTTP on loopback for the app's own panel. Both go
through the same `handleJsonRpcRequest`, and the configured privilege scope is read once in the
constructor so it applies to both — it was previously read only on the stdio path, which meant
an operator who configured `admin` still got `standard` over HTTP, the transport the app
actually uses.

**What a call passes through.** A tool call is checked against a prohibited list, then against
the privilege tier: `standard` covers reads and safe actions, and 12 destructive tools
(`profiles.delete`, `cookies.import`, `trash.delete_forever`, …) are refused unless the scope is
`admin`. Nonces are validated to stop replays, and every decision — allow, deny, or error — is
appended to a hash-chained audit log so the history cannot be edited after the fact. Arguments
are redacted before they reach that log: credentials would otherwise be recorded verbatim.

## Transports

- **stdio** — the default, and what desktop agent clients use. Spawning `index.js` is enough.
- **HTTP** — set `MCP_HTTP_PORT` and the server listens on
  `http://127.0.0.1:<port>/mcp` instead. The app uses this internally for its own panel.

## Tools

47 tools in two tiers. The tier is set by `ANTIDETECT_MCP_SCOPE` (`standard` by default, or
`admin` via **Settings → Security → MCP privileges**).

**Standard — reads and safe actions**

| Area | Tools |
|---|---|
| Browser | `browser.navigate`, `browser.click`, `browser.type`, `browser.human_click`, `browser.human_type`, `browser.screenshot` |
| Proxies | `proxies.list`, `proxies.create`, `proxies.check` |
| Extensions | `extensions.list`, `extensions.install` |
| Flows | `flows.list`, `flows.get`, `flows.run`, `flows.validate` |
| Task groups | `task_groups.list`, `task_groups.get`, `task_groups.tasks`, `task_groups.start`, `task_groups.stop` |
| Trash / triggers / tags / batch | `trash.list`, `triggers.list`, `triggers.create`, `triggers.toggle`, `tags.list`, `tags.attach`, `tags.detach`, `batch.start`, `batch.stop` |
| Diagnostics | `diagnostics.run` |

**Admin — destructive, refused unless the scope is `admin`**

`profiles.delete`, `profiles.restore`, `profiles.export_preserved`,
`profiles.cleanup_preserved`, `proxies.delete`, `extensions.delete`, `triggers.delete`,
`batch.delete`, `trash.delete_forever`, `cookies.export`, `cookies.import`, `browser.evaluate_allowlisted`.

## How it reaches the browser

The MCP server is an HTTP client of the app's own Local API (`ANTIDETECT_API_URL` +
bearer token). Browser control goes through the profile's CDP endpoint, which the app
already exposes for its own automation. Nothing is opened to the network: the API binds
loopback, and so does the MCP HTTP transport.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Panel says "MCP: Off" but the server runs | The status route is not answering the standard `{code,msg,data}` envelope. The panel reads `res.code === 0` and treats anything else as Off, so a bare status object renders exactly like a stopped server. This shipped once: `/api/v1/mcp/status` returned the raw status while every other route answered the envelope, and the footer said Off beside a server holding 47 tools. Check the route's shape first — it is the only thing that produces this symptom. |
| "Cannot reach the local service" | The backend is not running — the MCP panel is a client of it. |
| Agent spawns the server, gets no output | The entry must be run as the main module. Use the generated `index.js`, not a `require` of the built file. |
| `401` from tool calls | The token is stale; regenerate the bundle. |
| "MCP entry … was not found" | `mcp/dist/mcp/src/index.js` is missing from the payload. It is not resolved from the working directory — see *Where the entry lives*. |
| A destructive tool is rejected | The bundle is `standard`. Regenerate with `admin`, or raise it in Settings → Security. |
