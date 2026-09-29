import { getDb } from '../db';
import { protectSecret, revealSecret } from '../util/secretStore';

export interface AiConfig {
  provider: 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

const DEFAULT_CONFIG: AiConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  systemPrompt: 'You are NullTrace AI, an expert antidetect browser, web automation, scraping, and proxy assistant.',
  temperature: 0.7,
};

function ensureAiTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      api_key_encrypted TEXT,
      base_url TEXT,
      model TEXT NOT NULL,
      system_prompt TEXT,
      temperature REAL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

export function getAiConfig(): AiConfig {
  ensureAiTables();
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_config WHERE id = 1').get() as
    | {
        provider: string;
        api_key_encrypted: string | null;
        base_url: string | null;
        model: string;
        system_prompt: string | null;
        temperature: number | null;
      }
    | undefined;

  if (!row) return DEFAULT_CONFIG;

  let apiKey: string | undefined;
  if (row.api_key_encrypted) {
    try {
      apiKey = revealSecret(row.api_key_encrypted);
    } catch {
      apiKey = undefined;
    }
  }

  return {
    provider: (row.provider as AiConfig['provider']) || 'openai',
    apiKey,
    baseUrl: row.base_url || (row.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
    model: row.model || 'gpt-4o-mini',
    systemPrompt: row.system_prompt || DEFAULT_CONFIG.systemPrompt,
    temperature: row.temperature ?? DEFAULT_CONFIG.temperature,
  };
}

export function updateAiConfig(cfg: Partial<AiConfig>): AiConfig {
  ensureAiTables();
  const current = getAiConfig();
  const merged: AiConfig = {
    provider: cfg.provider ?? current.provider,
    model: cfg.model ?? current.model,
    baseUrl: cfg.baseUrl !== undefined ? cfg.baseUrl : current.baseUrl,
    systemPrompt: cfg.systemPrompt !== undefined ? cfg.systemPrompt : current.systemPrompt,
    temperature: cfg.temperature !== undefined ? cfg.temperature : current.temperature,
    apiKey: cfg.apiKey !== undefined ? cfg.apiKey : current.apiKey,
  };

  const encryptedKey = merged.apiKey ? protectSecret(merged.apiKey) : null;
  const db = getDb();
  db.prepare(`
    INSERT INTO ai_config (id, provider, api_key_encrypted, base_url, model, system_prompt, temperature, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      api_key_encrypted = excluded.api_key_encrypted,
      base_url = excluded.base_url,
      model = excluded.model,
      system_prompt = excluded.system_prompt,
      temperature = excluded.temperature,
      updated_at = excluded.updated_at
  `).run(
    merged.provider,
    encryptedKey,
    merged.baseUrl || null,
    merged.model,
    merged.systemPrompt || null,
    merged.temperature ?? null,
    Date.now()
  );

  return merged;
}

export async function sendChatMessage(messages: ChatMessage[], overrideConfig?: Partial<AiConfig>): Promise<{ content: string; model: string }> {
  const config = { ...getAiConfig(), ...overrideConfig };
  if (!config.apiKey && config.provider !== 'custom') {
    throw new Error('API key is not configured. Set your API key in AI Chat settings.');
  }

  const allMessages: ChatMessage[] = [];
  if (config.systemPrompt) {
    allMessages.push({ role: 'system', content: config.systemPrompt });
  }
  allMessages.push(...messages);

  if (config.provider === 'anthropic') {
    const systemMsg = allMessages.find((m) => m.role === 'system');
    const nonSystem = allMessages.filter((m) => m.role !== 'system');
    const url = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '') + '/messages';

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model || 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemMsg?.content,
        messages: nonSystem.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as { content: Array<{ type: string; text: string }>; model: string };
    const text = data.content?.[0]?.text || '';
    return { content: text, model: data.model || config.model };
  } else {
    // OpenAI or OpenAI-compatible endpoint
    const url = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
        temperature: config.temperature ?? 0.7,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API error (${resp.status}): ${errText}`);
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
      model: string;
    };
    const text = data.choices?.[0]?.message?.content || '';
    return { content: text, model: data.model || config.model };
  }
}
