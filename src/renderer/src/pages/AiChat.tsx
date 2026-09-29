import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { Modal } from '../components/Modal';
import { SettingsIcon, TrashIcon, RefreshIcon } from '../icons';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
}

interface AiConfigState {
  provider: 'openai' | 'anthropic' | 'custom';
  hasApiKey: boolean;
  apiKeyMasked?: string | null;
  baseUrl?: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
}

export function AiChat() {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const stored = localStorage.getItem('nulltrace_ai_chat_history');
      if (stored) return JSON.parse(stored);
    } catch {
      // ignore
    }
    return [
      {
        id: 'welcome',
        role: 'assistant',
        content: 'Hello! I am your NullTrace AI assistant. How can I help you today with antidetect profiles, proxies, browser automation, or scripts?',
        timestamp: Date.now(),
      },
    ];
  });

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [config, setConfig] = useState<AiConfigState | null>(null);

  // Settings modal
  const [showSettings, setShowSettings] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<'openai' | 'anthropic' | 'custom'>('openai');
  const [settingsKey, setSettingsKey] = useState('');
  const [settingsBaseUrl, setSettingsBaseUrl] = useState('');
  const [settingsModel, setSettingsModel] = useState('');
  const [settingsSystemPrompt, setSettingsSystemPrompt] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    try {
      localStorage.setItem('nulltrace_ai_chat_history', JSON.stringify(messages));
    } catch {
      // ignore
    }
  }, [messages]);

  const loadConfig = async () => {
    try {
      const res = await api.aiGetConfig();
      if (res.code === 0) {
        setConfig(res.data);
        setSettingsProvider(res.data.provider);
        setSettingsBaseUrl(res.data.baseUrl || '');
        setSettingsModel(res.data.model);
        setSettingsSystemPrompt(res.data.systemPrompt || '');
      }
    } catch (err) {
      console.warn('Failed to load AI config:', err);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const handleSaveSettings = async () => {
    setSettingsBusy(true);
    try {
      const res = await api.aiUpdateConfig({
        provider: settingsProvider,
        apiKey: settingsKey.trim() || undefined,
        baseUrl: settingsBaseUrl.trim() || undefined,
        model: settingsModel.trim() || undefined,
        systemPrompt: settingsSystemPrompt.trim() || undefined,
      });
      if (res.code === 0) {
        setShowSettings(false);
        setSettingsKey('');
        await loadConfig();
      } else {
        alert(t('Failed to save settings: ') + res.msg);
      }
    } catch (err) {
      alert(t('Error: ') + (err as Error).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || input).trim();
    if (!text || busy) return;

    if (!config?.hasApiKey && config?.provider !== 'custom') {
      setShowSettings(true);
      return;
    }

    const userMsg: ChatMessage = {
      id: String(Date.now()),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setBusy(true);
    setError('');

    try {
      const apiMessages = newMessages
        .filter((m) => m.id !== 'welcome')
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await api.aiChat(apiMessages);
      if (res.code === 0) {
        const assistantMsg: ChatMessage = {
          id: String(Date.now() + 1),
          role: 'assistant',
          content: res.data.content,
          timestamp: Date.now(),
          model: res.data.model,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleClearChat = () => {
    if (!window.confirm(t('Clear all conversation messages?'))) return;
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: 'Conversation cleared. How can I help you next?',
        timestamp: Date.now(),
      },
    ]);
  };

  const quickPrompts = [
    t('How do I prevent WebRTC IP leakage with SOCKS5?'),
    t('Write a script to warm up cookies for Facebook'),
    t('Explain difference between Canvas auto noise and real noise'),
    t('How to rotate fingerprints in bulk via API?'),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* Header */}
      <div className="page-header-actions" style={{ marginBottom: 0 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('Afina AI Assistant')}</h2>
            {config ? (
              <span className="badge" style={{ fontSize: 11, background: 'var(--surface-2)' }}>
                {config.provider.toUpperCase()} · {config.model}
              </span>
            ) : null}
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {t('Built-in AI assistant for antidetect automation, scripting, and proxy troubleshooting')}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={handleClearChat} title={t('Clear Chat History')}>
            <TrashIcon size={14} />
            <span>{t('Clear')}</span>
          </button>
          <button className="btn" onClick={() => setShowSettings(true)} title={t('AI Provider Settings')}>
            <SettingsIcon size={14} />
            <span>{t('Settings')}</span>
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {!config?.hasApiKey && config?.provider !== 'custom' ? (
        <div className="warning-banner" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{t('API Key is not configured yet. Add your OpenAI or Anthropic API key to enable AI Chat.')}</span>
          <button className="btn btn-sm primary" onClick={() => setShowSettings(true)}>
            {t('Configure API Key')}
          </button>
        </div>
      ) : null}

      {/* Chat Messages */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {messages.map((m) => {
          const isUser = m.role === 'user';
          return (
            <div
              key={m.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '75%',
                  padding: '10px 14px',
                  borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                  background: isUser ? 'var(--accent)' : 'var(--bg-app)',
                  color: isUser ? '#fff' : 'var(--text)',
                  border: isUser ? 'none' : '1px solid var(--border)',
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.content}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, padding: '0 4px' }}>
                {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {m.model ? ` · ${m.model}` : ''}
              </div>
            </div>
          );
        })}

        {busy ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
            <RefreshIcon size={14} className="spin" />
            <span>{t('AI is thinking...')}</span>
          </div>
        ) : null}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Prompts */}
      {messages.length <= 1 ? (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
          {quickPrompts.map((qp, idx) => (
            <button
              key={idx}
              type="button"
              className="btn btn-xs"
              style={{ whiteSpace: 'nowrap', borderRadius: 14 }}
              onClick={() => void handleSend(qp)}
            >
              {qp}
            </button>
          ))}
        </div>
      ) : null}

      {/* Input Area */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          rows={2}
          className="input"
          placeholder={t('Type a message... (Enter to send, Shift+Enter for newline)')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={busy}
          style={{ flex: 1, resize: 'none', padding: '10px 12px', fontSize: 13 }}
        />
        <button
          type="button"
          className="btn primary"
          onClick={() => void handleSend()}
          disabled={busy || !input.trim()}
          style={{ height: 42, padding: '0 18px' }}
        >
          {busy ? t('Sending...') : t('Send')}
        </button>
      </div>

      {/* AI Settings Modal */}
      {showSettings ? (
        <Modal
          title={t('AI Provider Settings')}
          onClose={() => setShowSettings(false)}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <button type="button" className="btn" onClick={() => setShowSettings(false)} disabled={settingsBusy}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn primary" onClick={() => void handleSaveSettings()} disabled={settingsBusy}>
                {settingsBusy ? t('Saving...') : t('Save Settings')}
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('Provider')}
              </label>
              <select
                className="input"
                value={settingsProvider}
                onChange={(e) => {
                  const val = e.target.value as 'openai' | 'anthropic' | 'custom';
                  setSettingsProvider(val);
                  if (val === 'anthropic' && !settingsModel.startsWith('claude')) {
                    setSettingsModel('claude-3-5-sonnet-20241022');
                  } else if (val === 'openai' && settingsModel.startsWith('claude')) {
                    setSettingsModel('gpt-4o-mini');
                  }
                }}
                style={{ width: '100%' }}
              >
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="custom">Custom Endpoint (Ollama, OpenRouter, DeepSeek, Local)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('API Key')} {config?.hasApiKey ? `(${t('Current')}: ${config.apiKeyMasked})` : ''}
              </label>
              <input
                type="password"
                className="input"
                placeholder={config?.hasApiKey ? t('Leave empty to keep existing key') : 'sk-...'}
                value={settingsKey}
                onChange={(e) => setSettingsKey(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('Model')}
              </label>
              <input
                className="input"
                placeholder={settingsProvider === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o-mini'}
                value={settingsModel}
                onChange={(e) => setSettingsModel(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>

            {settingsProvider === 'custom' || settingsBaseUrl ? (
              <div>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('Base URL')}
                </label>
                <input
                  className="input"
                  placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
                  value={settingsBaseUrl}
                  onChange={(e) => setSettingsBaseUrl(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
            ) : null}

            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                {t('System Prompt')}
              </label>
              <textarea
                rows={3}
                className="input"
                placeholder="You are NullTrace AI..."
                value={settingsSystemPrompt}
                onChange={(e) => setSettingsSystemPrompt(e.target.value)}
                style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
export default AiChat;
