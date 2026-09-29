import { Router } from 'express';
import { z } from 'zod';
import { getAiConfig, updateAiConfig, sendChatMessage, ChatMessage } from '../../ai/chatManager';

const router = Router();

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
});

const configSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'custom']).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const chatSchema = z.object({
  messages: z.array(messageSchema).min(1),
  config: configSchema.optional(),
});

router.get('/api/v1/ai/config', (_req, res) => {
  try {
    const cfg = getAiConfig();
    res.json({
      code: 0,
      msg: 'success',
      data: {
        provider: cfg.provider,
        hasApiKey: Boolean(cfg.apiKey && cfg.apiKey.length > 0),
        apiKeyMasked: cfg.apiKey ? `${cfg.apiKey.slice(0, 4)}...${cfg.apiKey.slice(-4)}` : null,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        systemPrompt: cfg.systemPrompt,
        temperature: cfg.temperature,
      },
    });
  } catch (err) {
    res.status(500).json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.post('/api/v1/ai/config', (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const updated = updateAiConfig(parsed.data);
    res.json({
      code: 0,
      msg: 'success',
      data: {
        provider: updated.provider,
        hasApiKey: Boolean(updated.apiKey && updated.apiKey.length > 0),
        baseUrl: updated.baseUrl,
        model: updated.model,
        systemPrompt: updated.systemPrompt,
        temperature: updated.temperature,
      },
    });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.post('/api/v1/ai/chat', async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const response = await sendChatMessage(parsed.data.messages as ChatMessage[], parsed.data.config);
    res.json({ code: 0, msg: 'success', data: response });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

export default router;
