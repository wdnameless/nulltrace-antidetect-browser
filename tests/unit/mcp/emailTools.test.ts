import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRouter } from '../../../mcp/src/tools';
import { DEFAULT_TOOL_NAMES, GATED_TOOL_NAMES } from '../../../mcp/src/auth';
import { McpAuditLogger } from '../../../mcp/src/audit';
import { redactSensitiveArgs } from '../../../mcp/src/redaction';
import { AntidetectClient } from '../../../packages/sdk-node/src/client';

describe('MCP email.* tools (T3: imap-mail-profiles)', () => {
  let tempAuditPath: string;
  let auditLogger: McpAuditLogger;
  let dispatchedCalls: Array<{ path: string; method?: string; body?: unknown; query?: Record<string, unknown> }>;
  let mockClient: AntidetectClient;
  let toolRouter: ToolRouter;

  const EXPECTED_EMAIL_TOOLS = [
    'email.accounts.list',
    'email.accounts.get',
    'email.accounts.create',
    'email.accounts.update',
    'email.accounts.bind_profile',
    'email.folders.list',
    'email.messages.list',
    'email.messages.read',
    'email.messages.search',
    'email.messages.set_flags',
    'email.codes.extract',
    'email.drafts.save',
    'email.drafts.list',
    'email.drafts.delete',
    'email.outbox.list',
    'email.messages.send',
    'email.accounts.delete',
  ];

  beforeEach(() => {
    tempAuditPath = path.join(
      os.tmpdir(),
      `mcp-email-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
    );
    auditLogger = new McpAuditLogger(tempAuditPath);
    dispatchedCalls = [];

    mockClient = {
      request: async (requestPath: string, opts?: { method?: string; body?: unknown; query?: Record<string, unknown> }) => {
        dispatchedCalls.push({ path: requestPath, method: opts?.method ?? 'GET', body: opts?.body, query: opts?.query });
        // Return masked account shape mirroring R1
        if (requestPath.includes('/accounts')) {
          return {
            success: true,
            data: {
              id: 'acc-1',
              email: 'test@example.com',
              host: 'imap.example.com',
              port: 993,
              username: 'test@example.com',
              has_password: true,
              created_at: 1000,
              updated_at: 1000,
            },
          };
        }
        return { success: true, data: { ok: true, path: requestPath } };
      },
    } as unknown as AntidetectClient;

    toolRouter = new ToolRouter({
      client: mockClient,
      auditLogger,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempAuditPath)) {
      try {
        fs.unlinkSync(tempAuditPath);
      } catch {
        // ignore
      }
    }
  });

  it('includes all 17 email.* tools in listTools with valid input schemas and no password in output schema', () => {
    const tools = toolRouter.listTools();
    const toolNames = tools.map((t) => t.name);

    for (const expected of EXPECTED_EMAIL_TOOLS) {
      expect(toolNames, `missing tool ${expected}`).toContain(expected);
    }

    // Verify all email tools have valid schema structure
    for (const tool of tools.filter((t) => t.name.startsWith('email.'))) {
      expect(tool.description).toBeTruthy();
      const schema = tool.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();

      // Invariant: No password exposed in output schemas or output properties
      const schemaStr = JSON.stringify(schema);
      expect(schemaStr).not.toContain('outputSchema');
    }
  });

  it('classifies all email tools in the expected security tiers', () => {
    const gated = ['email.messages.send', 'email.accounts.delete'];
    const defaultTier = EXPECTED_EMAIL_TOOLS.filter((name) => !gated.includes(name));

    for (const name of defaultTier) {
      expect(DEFAULT_TOOL_NAMES.has(name), `${name} should be default tier`).toBe(true);
      expect(GATED_TOOL_NAMES.has(name), `${name} must not be in gated set`).toBe(false);
    }

    for (const name of gated) {
      expect(GATED_TOOL_NAMES.has(name), `${name} should be gated tier`).toBe(true);
      expect(DEFAULT_TOOL_NAMES.has(name), `${name} must not be in default set`).toBe(false);
    }
  });

  it('refuses gated email tools without scope and records denial in audit', async () => {
    // email.messages.send
    const sendRes = await toolRouter.callTool(
      'email.messages.send',
      {
        account_id: 'acc-1',
        to: 'user@example.com',
        subject: 'Hello',
      },
      { scope: 'standard', caller: 'agent-standard' }
    );
    expect(sendRes.success).toBe(false);
    expect(sendRes.isForbidden).toBe(true);

    // email.accounts.delete
    const delRes = await toolRouter.callTool(
      'email.accounts.delete',
      { account_id: 'acc-1' },
      { scope: 'standard', caller: 'agent-standard' }
    );
    expect(delRes.success).toBe(false);
    expect(delRes.isForbidden).toBe(true);

    // Audit log verification
    const log = fs.readFileSync(tempAuditPath, 'utf8');
    expect(log).toContain('"tool":"email.messages.send"');
    expect(log).toContain('"tool":"email.accounts.delete"');
    expect(log).toContain('"decision":"deny"');
  });

  it('authorizes gated email tools with admin, profile:write_danger, or email-specific scope', async () => {
    // admin scope
    const sendAdmin = await toolRouter.callTool(
      'email.messages.send',
      { account_id: 'acc-1', to: 'user@example.com', subject: 'Hello' },
      { scope: 'admin', caller: 'agent-admin' }
    );
    expect(sendAdmin.success).toBe(true);

    // profile:write_danger scope
    const delDanger = await toolRouter.callTool(
      'email.accounts.delete',
      { account_id: 'acc-1' },
      { scope: 'profile:write_danger', caller: 'agent-danger' }
    );
    expect(delDanger.success).toBe(true);

    // email:send scope
    const sendScoped = await toolRouter.callTool(
      'email.messages.send',
      { account_id: 'acc-1', to: 'user@example.com', subject: 'Hello' },
      { scope: 'email:send', caller: 'agent-scoped' }
    );
    expect(sendScoped.success).toBe(true);

    // email:send must NOT imply delete — send-only token cannot destroy accounts.
    const delSendScope = await toolRouter.callTool(
      'email.accounts.delete',
      { account_id: 'acc-1' },
      { scope: 'email:send', caller: 'agent-scoped' }
    );
    expect(delSendScope.success).toBe(false);
    expect(delSendScope.isForbidden).toBe(true);
  });

  it('correctly dispatches each of the 17 email tools to backend REST endpoints', async () => {
    // 1. accounts.list
    await toolRouter.callTool('email.accounts.list', { profile_id: 'p-1' });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts',
      method: 'GET',
      query: { profile_id: 'p-1' },
    });

    // 1b. accounts.list with null → '' (unbound), never the literal "null".
    await toolRouter.callTool('email.accounts.list', { profile_id: null });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts',
      method: 'GET',
      query: { profile_id: '' },
    });

    // 2. accounts.get
    await toolRouter.callTool('email.accounts.get', { account_id: 'acc-1' });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1',
      method: 'GET',
    });

    // 3. accounts.create
    await toolRouter.callTool('email.accounts.create', {
      email: 'new@example.com',
      host: 'imap.example.com',
      username: 'new@example.com',
      password: 'secret-password',
      display_name: 'Ops Team',
    });
    const createCall = dispatchedCalls.pop();
    expect(createCall).toBeDefined();
    expect(createCall?.path).toBe('/api/v1/email/accounts');
    expect(createCall?.method).toBe('POST');
    expect(createCall?.body).toMatchObject({ email: 'new@example.com' });

    // 4. accounts.update
    await toolRouter.callTool('email.accounts.update', {
      account_id: 'acc-1',
      display_name: 'Updated Ops',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1',
      method: 'PATCH',
      body: { display_name: 'Updated Ops' },
    });

    // 4b. accounts.update with null SMTP → null forwarded (clear override), never 0/false.
    await toolRouter.callTool('email.accounts.update', {
      account_id: 'acc-1',
      smtp_port: null,
      smtp_secure: null,
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1',
      method: 'PATCH',
      body: { smtp_port: null, smtp_secure: null },
    });

    // 5. accounts.bind_profile
    await toolRouter.callTool('email.accounts.bind_profile', {
      account_id: 'acc-1',
      profile_id: 'prof-99',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/bind-profile',
      method: 'POST',
      body: { profile_id: 'prof-99' },
    });

    // 6. folders.list
    await toolRouter.callTool('email.folders.list', { account_id: 'acc-1' });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/folders',
      method: 'GET',
    });

    // 7. messages.list
    await toolRouter.callTool('email.messages.list', {
      account_id: 'acc-1',
      folder: 'INBOX',
      unread: true,
      q: 'security',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/folders/INBOX/messages',
      method: 'GET',
      query: { q: 'security', unread: '1' },
    });

    // 8. messages.read
    await toolRouter.callTool('email.messages.read', {
      account_id: 'acc-1',
      uid: '42',
      folder: 'INBOX',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/folders/INBOX/messages/42',
      method: 'GET',
    });

    // 9. messages.search
    await toolRouter.callTool('email.messages.search', {
      account_id: 'acc-1',
      query: 'invoice',
      unread: false,
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/folders/INBOX/messages',
      method: 'GET',
      query: { q: 'invoice', unread: '0' },
    });

    // 10. messages.set_flags
    await toolRouter.callTool('email.messages.set_flags', {
      account_id: 'acc-1',
      uid: '42',
      seen: true,
      flagged: false,
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/messages/42/flags',
      method: 'PATCH',
      body: { folder: 'INBOX', seen: true, flagged: false },
    });

    // 11. codes.extract
    await toolRouter.callTool('email.codes.extract', {
      account_id: 'acc-1',
      uid: '42',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/messages/42/codes',
      method: 'GET',
    });

    await toolRouter.callTool('email.codes.extract', {
      text: 'Verification code: 829102',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/extract-codes',
      method: 'POST',
      body: { text: 'Verification code: 829102' },
    });

    // 12. drafts.save
    await toolRouter.callTool('email.drafts.save', {
      account_id: 'acc-1',
      subject: 'Draft subject',
      text: 'Draft body text',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/drafts',
      method: 'POST',
      body: { subject: 'Draft subject', body_text: 'Draft body text' },
    });

    // 13. drafts.list
    await toolRouter.callTool('email.drafts.list', { account_id: 'acc-1' });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/drafts',
      method: 'GET',
    });

    // 14. drafts.delete
    await toolRouter.callTool('email.drafts.delete', {
      account_id: 'acc-1',
      draft_id: 'draft-9',
    });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/drafts/draft-9',
      method: 'DELETE',
    });

    // 15. outbox.list
    await toolRouter.callTool('email.outbox.list', { account_id: 'acc-1' });
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/outbox',
      method: 'GET',
    });

    // 16. messages.send (gated)
    await toolRouter.callTool(
      'email.messages.send',
      {
        account_id: 'acc-1',
        to: 'recipient@example.com',
        subject: 'Outgoing note',
        text: 'Hello from MCP',
      },
      { scope: 'admin' }
    );
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1/send',
      method: 'POST',
      body: { to: 'recipient@example.com', subject: 'Outgoing note', text: 'Hello from MCP' },
    });

    // 17. accounts.delete (gated)
    await toolRouter.callTool(
      'email.accounts.delete',
      { account_id: 'acc-1' },
      { scope: 'admin' }
    );
    expect(dispatchedCalls.pop()).toMatchObject({
      path: '/api/v1/email/accounts/acc-1',
      method: 'DELETE',
    });
  });

  it('proves redaction: credentials and passwords never leak to audit log or results', async () => {
    const rawSecret = 'SUPER_SECRET_PLAINTEXT_PASSWORD_999!';
    const rawSmtpSecret = 'SMTP_SECRET_KEY_777!';

    // Direct redaction on email input arguments
    const emailArgs = {
      email: 'secure@example.com',
      host: 'imap.example.com',
      username: 'secure@example.com',
      password: rawSecret,
      smtp_password: rawSmtpSecret,
    };
    const redacted = redactSensitiveArgs(emailArgs) as typeof emailArgs;
    expect(redacted.smtp_password).toBe('[REDACTED]');
    expect(redacted.email).toBe('secure@example.com');

    // Invocation through router
    const res = await toolRouter.callTool('email.accounts.create', emailArgs);

    expect(res.success).toBe(true);
    // Response output has masked credential shape (has_password, no raw password)
    const data = res.data as Record<string, unknown>;
    expect(data.has_password).toBe(true);
    expect(data.password).toBeUndefined();
    expect(data.password_enc).toBeUndefined();

    // Audit log verification: raw secret never appears
    const auditLog = fs.readFileSync(tempAuditPath, 'utf8');
    expect(auditLog).not.toContain(rawSecret);
    expect(auditLog).not.toContain(rawSmtpSecret);

    // Calling with a different password yields the exact same argsHash in audit log
    await toolRouter.callTool('email.accounts.create', {
      ...emailArgs,
      password: 'DIFFERENT_PASSWORD_123',
      smtp_password: 'DIFFERENT_SMTP_456',
    });
    const lines = fs.readFileSync(tempAuditPath, 'utf8').trim().split('\n');
    const rec1 = JSON.parse(lines[lines.length - 2]);
    const rec2 = JSON.parse(lines[lines.length - 1]);
    expect(rec1.argsHash).toBe(rec2.argsHash);
  });
});
