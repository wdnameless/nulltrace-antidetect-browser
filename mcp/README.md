# @antidetect/mcp-server

Constrained, audit-logged Model Context Protocol (MCP) server for Antidetect Browser.

## Security Architecture

The MCP server enforces defense-in-depth access controls:

1. **Protocol & Transports**:
   - JSON-RPC 2.0 interface.
   - `stdio` transport for direct process integration.
   - `http` transport strictly bound to loopback `127.0.0.1` (`/mcp` endpoint).

2. **Tool Tiers & RBAC**:
   - **Tier 1 (Default)** — metadata reads and routine, reversible operations (`profiles.list`, `profiles.get`, `profiles.create`, `profiles.start`, `profiles.stop`, `browser.navigate`, `browser.click`, `browser.type`, `browser.human_type`, `browser.human_click`, `browser.screenshot`, `android.start`, `android.stop`, `android.status`, `android.tap`, `android.swipe`, `android.type`, `android.key`, `android.screencap`, `android.install_apk`, `browser.run_round`, `browser.snapshot`, `browser.tabs`, `diagnostics.run`, `proxies.list`, `proxies.create`, `proxies.check`, `extensions.list`, `extensions.install`, `flows.list`, `flows.get`, `flows.run`, `flows.validate`, `task_groups.list`, `task_groups.get`, `task_groups.tasks`, `task_groups.start`, `task_groups.stop`, `trash.list`, `triggers.list`, `triggers.create`, `triggers.toggle`, `tags.list`, `tags.attach`, `tags.detach`, `batch.start`, `batch.stop`, `email.accounts.list`, `email.accounts.get`, `email.accounts.create`, `email.accounts.update`, `email.accounts.bind_profile`, `email.folders.list`, `email.messages.list`, `email.messages.read`, `email.messages.search`, `email.messages.set_flags`, `email.codes.extract`, `email.drafts.save`, `email.drafts.list`, `email.drafts.delete`, `email.outbox.list`).
   - **Tier 2 (Gated)** — destructive or credential/secret-touching operations requiring `admin` or `profile:write_danger` token scope, or explicit `ANTIDETECT_MCP_GATED` environment variable allowlisting (`profiles.delete`, `profiles.restore`, `profiles.export_preserved`, `profiles.cleanup_preserved`, `browser.evaluate_allowlisted`, `proxies.delete`, `extensions.delete`, `trash.delete_forever`, `cookies.export`, `cookies.import`, `triggers.delete`, `batch.delete`, `email.messages.send`, `email.accounts.delete`).
   - **Prohibited Operations**: Raw CDP execution (`cdp.send`, `Runtime.evaluate`), process execution, arbitrary filesystem manipulation, and unbounded JS evaluation are hard-blocked for all callers and roles.

3. **Allowlisted Script Registry**:
   - `browser.evaluate_allowlisted` only executes scripts defined in `mcp/allowlist.json` by matching `script_id`. Arbitrary scripts are rejected immediately.

4. **Replay Defense & Audit**:
   - Monotonic/sliding-window nonce validation rejects replayed nonces.
   - 15-minute max TTL token validation.
   - Hash-chained audit logger (SHA-256 prevHash chain) recording every call decision (`allow`, `deny`, `error`).

## Installation & Build

```bash
cd mcp
npm install
npm run build
```

## Running the Server

### Stdio Mode (Default)
```bash
node dist/index.js
```

### HTTP Mode (Loopback Only)
```bash
MCP_HTTP_PORT=8080 node dist/index.js
```
Endpoint: `http://127.0.0.1:8080/mcp`
