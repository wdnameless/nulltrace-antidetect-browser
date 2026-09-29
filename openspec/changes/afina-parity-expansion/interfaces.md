# Interfaces: Afina Parity Expansion

## 1. Clear Cache Interface
```ts
// src/main/profiles/profileManager.ts
export interface ClearCacheResult {
  freedBytes: number;
  clearedDirs: string[];
}

export function clearProfileCache(profileId: string): Promise<ClearCacheResult>;
export function clearBulkProfileCache(profileIds: string[]): Promise<Record<string, ClearCacheResult>>;

// API Route: POST /api/v1/browser-profile/clear-cache
// Body: { user_ids: string[] }
// Response: { code: 0, msg: 'success', data: { results: Record<string, ClearCacheResult> } }
```

## 2. Proxy XLSX Import/Export Interface
```ts
// API Route: GET /api/v1/proxies/export-xlsx
// Response: Buffer (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)

// API Route: POST /api/v1/proxies/import-xlsx
// Body: { base64: string }
// Response: { code: 0, msg: 'success', data: { imported: number, errors: string[] } }
```

## 3. Token Login Interface
```ts
// src/main/profiles/tokenLogin.ts
export type TokenType = 'discord' | 'telegram' | 'twitter' | 'custom_cookie' | 'custom_local_storage';

export interface TokenLoginPayload {
  user_id: string;
  type: TokenType;
  token: string;
  origin?: string; // for custom localStorage/cookie
  key?: string;    // for custom localStorage
}

export function injectLoginToken(payload: TokenLoginPayload): Promise<{ ok: boolean; message?: string }>;

// API Route: POST /api/v1/browser-profile/login-token
// Body: TokenLoginPayload
// Response: { code: 0, msg: 'success', data: { ok: boolean } }
```

## 4. User Databases & SQL Terminal Interface
```ts
// src/main/db/userDatabases.ts
export interface UserTableColumn {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  primaryKey?: boolean;
}

export interface UserTableSummary {
  name: string;
  columns: UserTableColumn[];
  rowCount: number;
}

export interface SqlQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  changes?: number;
  executionTimeMs: number;
}

export function listUserTables(): UserTableSummary[];
export function createUserTable(name: string, columns: UserTableColumn[]): void;
export function dropUserTable(name: string): void;
export function executeUserSql(sql: string, params?: unknown[]): SqlQueryResult;

// API Routes:
// GET /api/v1/databases/tables
// POST /api/v1/databases/tables
// DELETE /api/v1/databases/tables/:name
// POST /api/v1/databases/query (body: { sql: string, params?: unknown[] })
```

## 5. AI Chat Interface
```ts
// src/main/ai/chatManager.ts
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AiChatRequest {
  provider: 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
}

export function sendAiChatMessage(req: AiChatRequest): Promise<{ content: string; tokensUsed?: number }>;

// API Routes:
// POST /api/v1/ai/chat
// GET /api/v1/ai/config
// POST /api/v1/ai/config
```
