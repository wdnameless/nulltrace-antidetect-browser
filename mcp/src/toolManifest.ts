// The tool MANIFEST — names, descriptions, tiers and input schemas — and nothing else.
//
// Kept separate from `tools.ts` on purpose. The main process needs the tool COUNTS for the
// status endpoint, and importing them from `tools.ts` dragged that whole module in: it
// imports `@antidetect/sdk`, a workspace package electron-builder does not package into the
// app. The result was a packaged build that CRASHED ON STARTUP with
// `Cannot find module '@antidetect/sdk'`. A data-only module carries no dependency graph.
import type { ToolManifest } from './toolManifestTypes';

export type { ToolManifest };

export const TOOL_DEFINITIONS: ToolManifest[] = [
  // Tier 1: Default
  {
    name: 'profiles.list',
    description: 'Enumerate profiles metadata (excluding sensitive credentials).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number' },
        page_size: { type: 'number', description: 'Page size limit' },
        group_id: { type: 'string', description: 'Filter by group ID' },
      },
    },
  },
  {
    name: 'profiles.get',
    description: 'Retrieve profile details by profile ID.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'profiles.create',
    description: 'Provision a new browser profile with optional configuration.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Profile name' },
        group_id: { type: 'string', description: 'Assigned group ID' },
        proxy_id: { type: 'string', description: 'Proxy ID' },
        tags: { type: 'array', items: { type: 'string' } },
        os: { type: 'string', enum: ['windows', 'macos', 'linux'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'profiles.start',
    description: 'Launch a profile browser session and return CDP connection info.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        headless: { type: 'boolean', description: 'Run headless mode' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'profiles.stop',
    description: 'Terminate an active profile browser session.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'browser.navigate',
    description: 'Navigate active browser page of a profile to the specified URL.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        url: { type: 'string', description: 'Target URL to load' },
      },
      required: ['profile_id', 'url'],
    },
  },
  {
    name: 'browser.click',
    description: 'Click a DOM element on the active page matching selector.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        selector: { type: 'string', description: 'CSS/XPath selector of element to click' },
      },
      required: ['profile_id', 'selector'],
    },
  },
  {
    name: 'browser.type',
    description: 'Type text into a DOM input element matching selector.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        selector: { type: 'string', description: 'CSS selector of input field' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['profile_id', 'selector', 'text'],
    },
  },
  {
    name: 'browser.human_type',
    description: 'Type text into an input field with per-key human pacing (Motion domain): per-key delays, optional typo model.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        selector: { type: 'string', description: 'CSS selector of input field' },
        text: { type: 'string', description: 'Text to type' },
        allow_typos: { type: 'boolean', description: 'Enable the human typo model (default false)' },
      },
      required: ['profile_id', 'selector', 'text'],
    },
  },
  {
    name: 'browser.human_click',
    description: 'Click an element via a Fitts-law human cursor glide (Motion domain).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        selector: { type: 'string', description: 'CSS/XPath selector of element to click' },
        target_width: { type: 'number', description: 'Target width in px feeding Fitts law (default 32)' },
      },
      required: ['profile_id', 'selector'],
    },
  },
  {
    name: 'browser.screenshot',
    description: 'Capture screenshot of the active page as base64 PNG (capped at 5MB).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        full_page: { type: 'boolean', description: 'Capture full scrollable page' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'browser.run_round',
    description: 'Execute a sandboxed browser automation round (code snippet) against a running profile.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        code: { type: 'string', description: 'JavaScript round snippet executing against sandboxed app.browser surface' },
        timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds' },
      },
      required: ['profile_id', 'code'],
    },
  },
  {
    name: 'browser.snapshot',
    description: 'Capture a semantic accessibility role-tree snapshot with stable @ref identifiers.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        scope: { type: 'string', enum: ['viewport', 'full_page', 'subtree'], description: 'Snapshot scope' },
        root: { type: 'string', description: 'Root element ref for subtree scope (e.g. @21)' },
        page: { type: 'string', description: 'Page label identifier (e.g. p1)' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'browser.tabs',
    description: 'List open tabs and their metadata for a running profile.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'diagnostics.run',
    description: 'Execute health and proxy verification probes for a profile.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID to run diagnostics on' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'proxies.list',
    description: 'List configured proxies (metadata only, credentials excluded).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'proxies.create',
    description: 'Create a new proxy entry.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['http', 'https', 'socks5', 'ssh'], description: 'Proxy protocol' },
        host: { type: 'string', description: 'Proxy host' },
        port: { type: 'number', description: 'Proxy port' },
        username: { type: 'string', description: 'Proxy username' },
        password: { type: 'string', description: 'Proxy password (redacted in audit logs)' },
        privateKey: { type: 'string', description: 'SSH private key for ssh-type proxies' },
      },
      required: ['type', 'host', 'port'],
    },
  },
  {
    name: 'proxies.check',
    description: 'Run a live health check against a proxy.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        proxy_id: { type: 'string', description: 'Proxy ID to check' },
      },
      required: ['proxy_id'],
    },
  },
  {
    name: 'extensions.list',
    description: 'List installed browser extensions.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'extensions.install',
    description: 'Install an extension from the Chrome Web Store (url), a known id, or a local path.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Chrome Web Store URL of the extension' },
        id: { type: 'string', description: 'Known extension id' },
        path: { type: 'string', description: 'Local path to the unpacked extension' },
      },
    },
  },
  {
    name: 'flows.list',
    description: 'List all automation flows.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'flows.get',
    description: 'Retrieve a flow document by id.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow id' },
      },
      required: ['flow_id'],
    },
  },
  {
    name: 'flows.run',
    description: 'Run a flow across the given profile ids via a task group.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow id to run' },
        profile_ids: { type: 'array', items: { type: 'string' }, description: 'Profiles to run the flow on' },
        concurrency: { type: 'number', description: 'Optional concurrency cap' },
        trigger: { type: 'string', enum: ['manual', 'cron'], description: 'Trigger type' },
        cron_schedule: { type: 'string', description: 'Cron schedule when trigger=cron' },
      },
      required: ['flow_id', 'profile_ids'],
    },
  },
  {
    name: 'flows.validate',
    description: 'Validate a flow document (by flow_id or inline document).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow id to validate (loaded from storage)' },
        document: { type: 'object', description: 'Inline flow document to validate, when flow_id is not given' },
      },
    },
  },
  {
    name: 'task_groups.list',
    description: 'List script task groups.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'task_groups.get',
    description: 'Retrieve a task group by id.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Task group id' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_groups.tasks',
    description: 'List tasks belonging to a task group.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Task group id' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_groups.start',
    description: 'Start or resume a task group.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Task group id' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_groups.stop',
    description: 'Gracefully stop a running task group.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Task group id' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'trash.list',
    description: 'List soft-deleted profiles in the trash.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'triggers.list',
    description: 'List automation triggers.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'triggers.create',
    description: 'Create a new trigger (schedule or event based).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Trigger name' },
        script_id: { type: 'string', description: 'Script id to run' },
        type: { type: 'string', enum: ['schedule', 'event'], description: 'Trigger type' },
        schedule: { type: 'string', description: 'Cron schedule when type=schedule' },
        event: { type: 'string', enum: ['profile_started', 'profile_stopped'], description: 'Event when type=event' },
      },
      required: ['name', 'script_id', 'type'],
    },
  },
  {
    name: 'triggers.toggle',
    description: 'Enable or disable a trigger.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: { type: 'string', description: 'Trigger id' },
        enabled: { type: 'boolean', description: 'Desired enabled state' },
      },
      required: ['trigger_id', 'enabled'],
    },
  },
  {
    name: 'tags.list',
    description: 'List profile tags.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'tags.attach',
    description: 'Attach a tag to one or more profiles.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        tag_id: { type: 'string', description: 'Tag id' },
        user_ids: { type: 'array', items: { type: 'string' }, description: 'Profile ids to attach the tag to' },
      },
      required: ['tag_id', 'user_ids'],
    },
  },
  {
    name: 'tags.detach',
    description: 'Detach a tag from one or more profiles.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        tag_id: { type: 'string', description: 'Tag id' },
        user_ids: { type: 'array', items: { type: 'string' }, description: 'Profile ids to detach the tag from' },
      },
      required: ['tag_id', 'user_ids'],
    },
  },
  {
    name: 'batch.start',
    description: 'Start multiple profiles in one request, returning a per-item success/failure report.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        user_ids: { type: 'array', items: { type: 'string' }, description: 'Profile ids to start' },
      },
      required: ['user_ids'],
    },
  },
  {
    name: 'batch.stop',
    description: 'Stop multiple profiles in one request, returning a per-item success/failure report.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        user_ids: { type: 'array', items: { type: 'string' }, description: 'Profile ids to stop' },
      },
      required: ['user_ids'],
    },
  },

  // Tier 2: Gated
  {
    name: 'profiles.delete',
    description: 'Permanently or soft-delete a browser profile (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID to delete' },
        permanent: { type: 'boolean', description: 'Permanent deletion' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'profiles.restore',
    description: 'Restore a soft-deleted profile from trash (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID to restore' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'profiles.export_preserved',
    description: 'Export preserved legacy browser data archive (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        registry_id: { type: 'string', description: 'Preserved data registry ID' },
      },
      required: ['registry_id'],
    },
  },
  {
    name: 'profiles.cleanup_preserved',
    description: 'Permanently cleanup and delete preserved legacy data archive (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        registry_id: { type: 'string', description: 'Preserved data registry ID' },
        confirmation: { type: 'string', description: 'Confirmation token' },
      },
      required: ['registry_id'],
    },
  },
  {
    name: 'browser.evaluate_allowlisted',
    description: 'Execute pre-registered script template by unique registered script_id with structured params.',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Unique profile identifier' },
        script_id: { type: 'string', description: 'Allowlisted script identifier' },
        params: { type: 'object', description: 'Parameters to pass to the script function' },
      },
      required: ['profile_id', 'script_id'],
    },
  },
  {
    name: 'proxies.delete',
    description: 'Permanently delete a proxy entry (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        proxy_id: { type: 'string', description: 'Proxy ID to delete' },
      },
      required: ['proxy_id'],
    },
  },
  {
    name: 'extensions.delete',
    description: 'Permanently remove an installed extension (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        extension_id: { type: 'string', description: 'Extension ID to delete' },
      },
      required: ['extension_id'],
    },
  },
  {
    name: 'trash.delete_forever',
    description: 'Purge a soft-deleted profile from trash permanently (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID to purge forever' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'cookies.export',
    description: 'Export a profile\'s cookies (requires admin / profile:write_danger scope — cookie values are secret material).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID to export cookies from' },
        format: { type: 'string', enum: ['json', 'netscape'], description: 'Export format (default json)' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'cookies.import',
    description: 'Import cookies into a profile (requires admin / profile:write_danger scope — cookie values are secret material).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Profile ID to import cookies into' },
        cookies: { type: 'array', items: { type: 'object' }, description: 'Structured cookie objects (json format)' },
        format: { type: 'string', enum: ['json', 'netscape', 'sqlite', 'cookies'], description: 'Import format' },
        text: { type: 'string', description: 'Raw cookie payload (netscape text or sqlite base64)' },
      },
      required: ['profile_id'],
    },
  },
  {
    name: 'triggers.delete',
    description: 'Permanently delete a trigger (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: { type: 'string', description: 'Trigger ID to delete' },
      },
      required: ['trigger_id'],
    },
  },
  {
    name: 'batch.delete',
    description: 'Bulk soft-delete multiple profiles in one request (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        user_ids: { type: 'array', items: { type: 'string' }, description: 'Profile ids to delete' },
      },
      required: ['user_ids'],
    },
  },
  // Email tools (Default tier)
  {
    name: 'email.accounts.list',
    description: 'List email accounts metadata (excluding sensitive credentials), optionally filtered by profile ID.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string', description: 'Filter accounts by browser profile ID' },
      },
    },
  },
  {
    name: 'email.accounts.get',
    description: 'Retrieve email account details by ID (excluding password).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.accounts.create',
    description: 'Provision a new email account with IMAP and optional SMTP configuration.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address' },
        host: { type: 'string', description: 'IMAP server host' },
        port: { type: 'number', description: 'IMAP server port (default 993)' },
        username: { type: 'string', description: 'IMAP username' },
        password: { type: 'string', description: 'IMAP password' },
        label: { type: 'string', description: 'Optional display label' },
        display_name: { type: 'string', description: 'Sender display name' },
        signature: { type: 'string', description: 'Email signature text' },
        smtp_host: { type: 'string', description: 'SMTP server host' },
        smtp_port: { type: 'number', description: 'SMTP server port' },
        smtp_secure: { type: 'boolean', description: 'Use TLS for SMTP' },
        profile_id: { type: 'string', description: 'Linked browser profile ID' },
      },
      required: ['email', 'host', 'username'],
    },
  },
  {
    name: 'email.accounts.update',
    description: 'Update an existing email account configuration.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        email: { type: 'string', description: 'Email address' },
        host: { type: 'string', description: 'IMAP server host' },
        port: { type: 'number', description: 'IMAP server port' },
        username: { type: 'string', description: 'IMAP username' },
        password: { type: 'string', description: 'IMAP password' },
        label: { type: 'string', description: 'Display label' },
        display_name: { type: 'string', description: 'Sender display name' },
        signature: { type: 'string', description: 'Email signature text' },
        smtp_host: { type: 'string', description: 'SMTP server host' },
        smtp_port: { type: 'number', description: 'SMTP server port' },
        smtp_secure: { type: 'boolean', description: 'Use TLS for SMTP' },
        profile_id: { type: 'string', description: 'Linked browser profile ID (null to unbind)' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.accounts.bind_profile',
    description: 'Bind or unbind an email account to a browser profile.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        profile_id: { type: 'string', description: 'Browser profile ID to bind, or null to unbind' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.folders.list',
    description: 'List mailbox folders and unread counts for an email account.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.messages.list',
    description: 'List messages in a folder for an email account.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        folder: { type: 'string', description: 'Folder name (default INBOX)' },
        unread: { type: 'boolean', description: 'Filter unread messages only' },
        q: { type: 'string', description: 'Search query string' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.messages.read',
    description: 'Read an email message body and headers by UID.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        uid: { type: 'string', description: 'Message UID' },
        folder: { type: 'string', description: 'Folder name (default INBOX)' },
      },
      required: ['account_id', 'uid'],
    },
  },
  {
    name: 'email.messages.search',
    description: 'Search messages in a folder for an email account by query.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        query: { type: 'string', description: 'Search term or query' },
        folder: { type: 'string', description: 'Folder name (default INBOX)' },
        unread: { type: 'boolean', description: 'Filter unread messages only' },
      },
      required: ['account_id', 'query'],
    },
  },
  {
    name: 'email.messages.set_flags',
    description: 'Set or update message flags (seen, flagged, answered).',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        uid: { type: 'string', description: 'Message UID' },
        folder: { type: 'string', description: 'Folder name (default INBOX)' },
        seen: { type: 'boolean', description: 'Mark message as seen/read' },
        flagged: { type: 'boolean', description: 'Mark message as flagged/starred' },
        answered: { type: 'boolean', description: 'Mark message as answered/replied' },
      },
      required: ['account_id', 'uid'],
    },
  },
  {
    name: 'email.codes.extract',
    description: 'Extract verification codes and OTP tokens from an email message or raw text.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw message body or text to extract codes from' },
        account_id: { type: 'string', description: 'Account ID (if extracting from account messages)' },
        uid: { type: 'string', description: 'Message UID (if extracting from a specific message)' },
      },
    },
  },
  {
    name: 'email.drafts.save',
    description: 'Save or update a draft message.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        id: { type: 'string', description: 'Draft ID (optional, creates new draft if omitted)' },
        to: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Recipient email address(es)',
        },
        cc: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Carbon copy recipients',
        },
        bcc: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Blind carbon copy recipients',
        },
        subject: { type: 'string', description: 'Email subject' },
        text: { type: 'string', description: 'Plain text body' },
        html: { type: 'string', description: 'HTML body' },
        in_reply_to: { type: 'string', description: 'In-Reply-To message ID' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.drafts.list',
    description: 'List saved draft messages for an email account.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'email.drafts.delete',
    description: 'Delete a draft message by ID.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        draft_id: { type: 'string', description: 'Draft ID to delete' },
      },
      required: ['account_id', 'draft_id'],
    },
  },
  {
    name: 'email.outbox.list',
    description: 'List sent/pending/failed outbox message logs for an email account.',
    tier: 'default',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
      },
      required: ['account_id'],
    },
  },
  // Email tools (Gated tier)
  {
    name: 'email.messages.send',
    description: 'Send an email message via SMTP (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
        to: {
          oneOf: [
            { type: 'string', description: 'Recipient email address' },
            { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
          ],
        },
        cc: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Carbon copy recipients',
        },
        bcc: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Blind carbon copy recipients',
        },
        subject: { type: 'string', description: 'Email subject' },
        text: { type: 'string', description: 'Plain text email body' },
        html: { type: 'string', description: 'HTML email body' },
        in_reply_to: { type: 'string', description: 'In-Reply-To message ID' },
        references: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'References message IDs',
        },
      },
      required: ['account_id', 'to', 'subject'],
    },
  },
  {
    name: 'email.accounts.delete',
    description: 'Delete an email account and its associated local cache (requires admin / profile:write_danger scope).',
    tier: 'gated',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Unique email account identifier' },
      },
      required: ['account_id'],
    },
  },
];
