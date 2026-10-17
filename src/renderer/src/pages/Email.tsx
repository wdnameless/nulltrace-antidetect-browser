import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '../i18n';
import {
  api,
  type EmailAccount,
  type EmailFolder,
  type EmailMessageSummary,
  type EmailMessageDetail,
  type EmailDraft,
  type EmailOutboxItem,
  type ProfileListItem,
} from '../api';

export function Email(): JSX.Element {
  const { t } = useI18n();

  // Accounts & Profile bindings
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [profileFilter, setProfileFilter] = useState<string>('');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // Folder sidebar
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('INBOX');
  const [isOutboxView, setIsOutboxView] = useState<boolean>(false);
  const [isDraftsView, setIsDraftsView] = useState<boolean>(false);

  // Messages / Outbox / Drafts data
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [outboxItems, setOutboxItems] = useState<EmailOutboxItem[]>([]);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [isCached, setIsCached] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [unreadOnly, setUnreadOnly] = useState<boolean>(false);

  // Selected message & Code extraction (byte-identical flow)
  const [selectedMessage, setSelectedMessage] = useState<EmailMessageDetail | null>(null);
  const [extractedCodes, setExtractedCodes] = useState<string[]>([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Loading & Error states
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Account Settings / Add Modal
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [formEmail, setFormEmail] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('993');
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formSignature, setFormSignature] = useState('');
  const [formSmtpHost, setFormSmtpHost] = useState('');
  const [formSmtpPort, setFormSmtpPort] = useState('465');
  const [formSmtpSecure, setFormSmtpSecure] = useState(true);
  const [formProfileId, setFormProfileId] = useState<string>('');
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);

  // Composer Modal
  const [showComposer, setShowComposer] = useState(false);
  const [composerDraftId, setComposerDraftId] = useState<string | null>(null);
  const [composerTo, setComposerTo] = useState('');
  const [composerCc, setComposerCc] = useState('');
  const [composerBcc, setComposerBcc] = useState('');
  const [composerSubject, setComposerSubject] = useState('');
  const [composerBodyText, setComposerBodyText] = useState('');
  const [composerBodyHtml, setComposerBodyHtml] = useState('');
  const [composerIsHtml, setComposerIsHtml] = useState(false);
  const [composerInReplyTo, setComposerInReplyTo] = useState<string | undefined>(undefined);
  const [composerReferences, setComposerReferences] = useState<string[] | undefined>(undefined);
  const [composerSending, setComposerSending] = useState(false);
  const [composerSavingDraft, setComposerSavingDraft] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  // Load profiles for binding picker
  useEffect(() => {
    api.list({ pageSize: 100 })
      .then((res) => {
        if (res.code === 0 && res.data?.list) {
          setProfiles(res.data.list);
        }
      })
      .catch(() => undefined);
  }, []);

  // Load Accounts
  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    setError(null);
    try {
      const res = await api.emailAccountsList(profileFilter ? profileFilter : undefined);
      if (res.code === 0 && Array.isArray(res.data)) {
        setAccounts(res.data);
        if (res.data.length > 0) {
          if (!selectedAccountId || !res.data.some((a) => a.id === selectedAccountId)) {
            setSelectedAccountId(res.data[0].id);
          }
        } else {
          setSelectedAccountId(null);
          setFolders([]);
          setMessages([]);
          setSelectedMessage(null);
        }
      } else {
        setError(res.msg || 'Failed to load email accounts');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAccounts(false);
    }
  }, [profileFilter, selectedAccountId]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // Load Folders for selected account
  const loadFolders = useCallback(async (accountId: string) => {
    setLoadingFolders(true);
    try {
      const res = await api.emailFoldersList(accountId);
      if (res.code === 0 && Array.isArray(res.data)) {
        setFolders(res.data);
      }
    } catch {
      // Non-fatal, fallback to standard INBOX
      setFolders([{ name: 'INBOX', unread: 0 }]);
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  // Load Messages, Outbox, or Drafts
  const loadContent = useCallback(async (accountId: string) => {
    setLoadingMessages(true);
    setError(null);
    setSelectedMessage(null);
    setExtractedCodes([]);

    try {
      if (isOutboxView) {
        const res = await api.emailOutboxList(accountId);
        if (res.code === 0 && Array.isArray(res.data)) {
          setOutboxItems(res.data);
        } else {
          setError(res.msg || 'Failed to fetch outbox');
        }
      } else if (isDraftsView) {
        const res = await api.emailDraftsList(accountId);
        if (res.code === 0 && Array.isArray(res.data)) {
          setDrafts(res.data);
        } else {
          setError(res.msg || 'Failed to fetch drafts');
        }
      } else {
        const res = await api.emailMessagesList(accountId, selectedFolder, {
          q: searchQuery.trim() || undefined,
          unread: unreadOnly || undefined,
        });
        if (res.code === 0 && res.data) {
          setMessages(res.data.messages || []);
          setIsCached(Boolean(res.data.cached));
          if (res.data.error) {
            setError(`${t('email.liveReadFailed') || 'Could not read the mailbox'}: ${res.data.error}`);
          }
        } else {
          setError(res.msg || 'Failed to fetch messages');
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMessages(false);
    }
  }, [isOutboxView, isDraftsView, selectedFolder, searchQuery, unreadOnly, t]);

  useEffect(() => {
    if (selectedAccountId) {
      void loadFolders(selectedAccountId);
      void loadContent(selectedAccountId);
    }
  }, [selectedAccountId, loadFolders, loadContent]);

  // Read message detail & preserve codes extraction byte-identical
  const loadMessage = useCallback(async (accountId: string, uid: string, folderName: string) => {
    setLoadingMessage(true);
    setError(null);
    try {
      const res = await api.emailMessageRead(accountId, folderName, uid);
      if (res.code === 0 && res.data) {
        setSelectedMessage(res.data);
        // Byte-identical extraction flow
        const extractRes = await api.emailExtractCodes(`${res.data.subject}\n\n${res.data.body}`);
        if (extractRes.code === 0 && extractRes.data) {
          setExtractedCodes(extractRes.data.codes || []);
        }
        // Auto mark as seen in UI and server
        if (!res.data.seen) {
          void api.emailSetFlags(accountId, uid, { seen: true, folder: folderName });
          setMessages((prev) =>
            prev.map((m) => (m.uid === uid ? { ...m, seen: true } : m))
          );
        }
      } else {
        setError(res.msg || 'Failed to fetch message');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMessage(false);
    }
  }, []);

  // Toggle flags: seen, flagged
  const handleToggleFlag = async (uid: string, flag: 'seen' | 'flagged', currentValue: boolean) => {
    if (!selectedAccountId) return;
    const nextValue = !currentValue;
    try {
      await api.emailSetFlags(selectedAccountId, uid, {
        [flag]: nextValue,
        folder: selectedFolder,
      });
      setMessages((prev) =>
        prev.map((m) => (m.uid === uid ? { ...m, [flag]: nextValue } : m))
      );
      if (selectedMessage && selectedMessage.uid === uid) {
        setSelectedMessage({ ...selectedMessage, [flag]: nextValue });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyCode = (code: string) => {
    void navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  // Open modal in create mode
  const openCreateAccountModal = () => {
    setModalMode('create');
    setFormEmail('');
    setFormHost('');
    setFormPort('993');
    setFormUsername('');
    setFormPassword('');
    setFormLabel('');
    setFormDisplayName('');
    setFormSignature('');
    setFormSmtpHost('');
    setFormSmtpPort('465');
    setFormSmtpSecure(true);
    setFormProfileId('');
    setRevealedPassword(null);
    setShowAccountModal(true);
  };

  // Open modal in edit mode
  const openEditAccountModal = (acc: EmailAccount) => {
    setModalMode('edit');
    setFormEmail(acc.email);
    setFormHost(acc.host);
    setFormPort(String(acc.port || 993));
    setFormUsername(acc.username);
    setFormPassword('');
    setFormLabel(acc.label || '');
    setFormDisplayName(acc.display_name || '');
    setFormSignature(acc.signature || '');
    setFormSmtpHost(acc.smtp_host || '');
    setFormSmtpPort(acc.smtp_port ? String(acc.smtp_port) : '465');
    setFormSmtpSecure(acc.smtp_secure !== false);
    setFormProfileId(acc.profile_id || '');
    setRevealedPassword(null);
    setShowAccountModal(true);
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (modalMode === 'create') {
        const res = await api.emailAccountCreate({
          email: formEmail,
          host: formHost,
          port: parseInt(formPort, 10) || 993,
          username: formUsername || formEmail,
          password: formPassword || undefined,
          label: formLabel || undefined,
          display_name: formDisplayName || undefined,
          signature: formSignature || undefined,
          smtp_host: formSmtpHost || undefined,
          smtp_port: formSmtpPort ? parseInt(formSmtpPort, 10) : undefined,
          smtp_secure: formSmtpSecure,
          profile_id: formProfileId || null,
        });
        if (res.code === 0 && res.data) {
          setShowAccountModal(false);
          await loadAccounts();
          setSelectedAccountId(res.data.id);
        } else {
          setError(res.msg || 'Failed to create email account');
        }
      } else if (selectedAccountId) {
        const updateBody: Parameters<typeof api.emailAccountUpdate>[1] = {
          email: formEmail,
          host: formHost,
          port: parseInt(formPort, 10) || 993,
          username: formUsername || formEmail,
          label: formLabel || undefined,
          display_name: formDisplayName || undefined,
          signature: formSignature || undefined,
          smtp_host: formSmtpHost || undefined,
          smtp_port: formSmtpPort ? parseInt(formSmtpPort, 10) : undefined,
          smtp_secure: formSmtpSecure,
          profile_id: formProfileId || null,
        };
        if (formPassword) {
          updateBody.password = formPassword;
        }
        const res = await api.emailAccountUpdate(selectedAccountId, updateBody);
        if (res.code === 0 && res.data) {
          setShowAccountModal(false);
          await loadAccounts();
        } else {
          setError(res.msg || 'Failed to update email account');
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevealPassword = async () => {
    if (!selectedAccountId) return;
    try {
      const res = await api.emailAccountReveal(selectedAccountId);
      if (res.code === 0 && res.data) {
        setRevealedPassword(res.data.password);
      } else {
        setError(res.msg || 'Failed to reveal password');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    if (!window.confirm('Are you sure you want to delete this email account?')) return;
    try {
      await api.emailAccountDelete(accountId);
      if (selectedAccountId === accountId) {
        setSelectedAccountId(null);
        setMessages([]);
        setSelectedMessage(null);
      }
      await loadAccounts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Composer Actions
  const openNewComposer = () => {
    setComposerDraftId(null);
    setComposerTo('');
    setComposerCc('');
    setComposerBcc('');
    setComposerSubject('');
    const sig = selectedAccount?.signature ? `\n\n-- \n${selectedAccount.signature}` : '';
    setComposerBodyText(sig);
    setComposerBodyHtml('');
    setComposerIsHtml(false);
    setComposerInReplyTo(undefined);
    setComposerReferences(undefined);
    setComposerError(null);
    setComposerNotice(null);
    setShowComposer(true);
  };

  const openReplyComposer = (msg: EmailMessageDetail) => {
    setComposerDraftId(null);
    // Extract clean email address from "Name <user@domain>"
    const emailMatch = msg.from.match(/<([^>]+)>/);
    const replyTo = emailMatch ? emailMatch[1] : msg.from;
    const sub = msg.subject.toLowerCase().startsWith('re:') ? msg.subject : `Re: ${msg.subject}`;
    const sig = selectedAccount?.signature ? `\n\n-- \n${selectedAccount.signature}` : '';
    const quote = `\n\n--- On ${msg.date}, ${msg.from} wrote: ---\n> ${(msg.body || '').split('\n').join('\n> ')}`;

    setComposerTo(replyTo);
    setComposerCc('');
    setComposerBcc('');
    setComposerSubject(sub);
    setComposerBodyText(`${sig}${quote}`);
    setComposerBodyHtml('');
    setComposerIsHtml(false);
    // Thread by RFC 5322 Message-ID, never the IMAP UID (folder-scoped number, unusable as In-Reply-To).
    setComposerInReplyTo(msg.messageId);
    setComposerReferences(msg.messageId ? [msg.messageId] : undefined);
    setComposerError(null);
    setComposerNotice(null);
    setShowComposer(true);
  };

  const openForwardComposer = (msg: EmailMessageDetail) => {
    setComposerDraftId(null);
    const sub = msg.subject.toLowerCase().startsWith('fwd:') ? msg.subject : `Fwd: ${msg.subject}`;
    const sig = selectedAccount?.signature ? `\n\n-- \n${selectedAccount.signature}` : '';
    const fwdBody = `\n\n--- Forwarded message ---\nFrom: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${msg.body || ''}`;

    setComposerTo('');
    setComposerCc('');
    setComposerBcc('');
    setComposerSubject(sub);
    setComposerBodyText(`${sig}${fwdBody}`);
    setComposerBodyHtml('');
    setComposerIsHtml(false);
    setComposerInReplyTo(undefined);
    setComposerReferences(undefined);
    setComposerError(null);
    setComposerNotice(null);
    setShowComposer(true);
  };

  const openDraftInComposer = (d: EmailDraft) => {
    setComposerDraftId(d.id);
    const toStr = Array.isArray(d.to) ? d.to.join(', ') : d.to_addrs || '';
    const ccStr = Array.isArray(d.cc) ? d.cc.join(', ') : d.cc || '';
    const bccStr = Array.isArray(d.bcc) ? d.bcc.join(', ') : d.bcc || '';
    setComposerTo(toStr);
    setComposerCc(ccStr);
    setComposerBcc(bccStr);
    setComposerSubject(d.subject || '');
    setComposerBodyText(d.bodyText || d.body_text || '');
    setComposerBodyHtml(d.bodyHtml || d.body_html || '');
    setComposerIsHtml(Boolean(d.bodyHtml || d.body_html));
    setComposerInReplyTo(d.inReplyTo || d.in_reply_to || undefined);
    setComposerReferences(d.inReplyTo || d.in_reply_to ? [d.inReplyTo || d.in_reply_to!] : undefined);
    setComposerError(null);
    setComposerNotice(null);
    setShowComposer(true);
  };

  const handleSaveDraft = async () => {
    if (!selectedAccountId) return;
    setComposerSavingDraft(true);
    setComposerError(null);
    setComposerNotice(null);
    try {
      const toList = composerTo.split(',').map((s) => s.trim()).filter(Boolean);
      const ccList = composerCc ? composerCc.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const bccList = composerBcc ? composerBcc.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      const res = await api.emailDraftSave(selectedAccountId, {
        id: composerDraftId || undefined,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: composerSubject,
        bodyText: composerBodyText,
        bodyHtml: composerIsHtml ? composerBodyHtml : undefined,
        inReplyTo: composerInReplyTo,
      });

      if (res.code === 0 && res.data) {
        setComposerDraftId(res.data.id);
        setComposerNotice(t('email.draftSaved') || 'Draft saved');
        setTimeout(() => setComposerNotice(null), 3000);
        if (isDraftsView) {
          void loadContent(selectedAccountId);
        }
      } else {
        setComposerError(res.msg || 'Failed to save draft');
      }
    } catch (err: unknown) {
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setComposerSavingDraft(false);
    }
  };

  const handleDeleteDraft = async (draftId: string) => {
    if (!selectedAccountId) return;
    if (!window.confirm(t('email.deleteDraftConfirm') || 'Delete this draft?')) return;
    try {
      await api.emailDraftDelete(selectedAccountId, draftId);
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSendMail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId) return;
    setComposerSending(true);
    setComposerError(null);
    setComposerNotice(null);

    try {
      const toList = composerTo.split(',').map((s) => s.trim()).filter(Boolean);
      const ccList = composerCc ? composerCc.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const bccList = composerBcc ? composerBcc.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      if (toList.length === 0) {
        setComposerError('At least one recipient is required');
        setComposerSending(false);
        return;
      }

      const res = await api.emailSend(selectedAccountId, {
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: composerSubject,
        text: composerBodyText || undefined,
        html: composerIsHtml && composerBodyHtml ? composerBodyHtml : undefined,
        inReplyTo: composerInReplyTo,
        references: composerReferences,
      });

      if (res.code === 0) {
        // If sending from a saved draft, clean it up
        if (composerDraftId) {
          void api.emailDraftDelete(selectedAccountId, composerDraftId);
        }
        setShowComposer(false);
        // Refresh folders & content
        void loadFolders(selectedAccountId);
        void loadContent(selectedAccountId);
      } else {
        // Surface the provider error text!
        setComposerError(res.msg || (t('email.sendFailed') || 'Failed to send message'));
      }
    } catch (err: unknown) {
      // Surface provider error text
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setComposerSending(false);
    }
  };

  const boundProfileName = useMemo(() => {
    if (!selectedAccount?.profile_id) return null;
    const prof = profiles.find((p) => p.user_id === selectedAccount.profile_id);
    return prof?.name || selectedAccount.profile_id;
  }, [selectedAccount, profiles]);

  return (
    <div className="email-page" style={{ padding: '24px', display: 'flex', flexDirection: 'column', height: '100%', gap: '16px' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600 }}>{t('email.title') || 'Email Manager'}</h1>
            {selectedAccount && (
              <span style={{ fontSize: '13px', padding: '3px 8px', borderRadius: '4px', backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                {selectedAccount.display_name ? `${selectedAccount.display_name} <${selectedAccount.email}>` : selectedAccount.email}
                {boundProfileName && (
                  <span style={{ marginLeft: '8px', color: 'var(--accent)', fontWeight: 500 }}>
                    🔗 {boundProfileName}
                  </span>
                )}
              </span>
            )}
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: '14px' }}>
            {t('email.subtitle') || 'IMAP & SMTP mail client with verification code extraction'}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Profile Filter */}
          <select
            value={profileFilter}
            onChange={(e) => setProfileFilter(e.target.value)}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--surface-1)',
              color: 'var(--text)',
              fontSize: '13px',
            }}
            title={t('email.filterProfile') || 'Filter by Profile'}
          >
            <option value="">{t('email.allProfiles') || 'All Profiles'}</option>
            {profiles.map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {p.name || p.user_id}
              </option>
            ))}
          </select>

          {selectedAccount && (
            <button
              className="btn"
              onClick={() => openEditAccountModal(selectedAccount)}
              style={{ fontSize: '13px' }}
            >
              ⚙ {t('email.settings') || 'Settings'}
            </button>
          )}

          <button
            className="btn"
            onClick={openCreateAccountModal}
            style={{ fontSize: '13px' }}
          >
            + {t('email.addAccount') || 'Add Account'}
          </button>

          <button
            className="btn primary"
            disabled={!selectedAccountId}
            onClick={openNewComposer}
            style={{ fontSize: '13px' }}
          >
            ✉ {t('email.compose') || 'Compose'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', backgroundColor: 'var(--danger-bg, rgba(239, 68, 68, 0.1))', border: '1px solid var(--danger)', borderRadius: '6px', color: 'var(--danger)', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {/* Main 4-column Layout: Accounts (220px) | Folders (180px) | Message List (340px) | View (1fr) */}
      <div style={{ display: 'grid', gridTemplateColumns: '220px 180px 340px 1fr', gap: '14px', flex: 1, minHeight: 0 }}>
        {/* Column 1: Accounts Switcher */}
        <div style={{ backgroundColor: 'var(--surface-1)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: '13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{t('email.accounts') || 'Accounts'} ({accounts.length})</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {loadingAccounts && accounts.length === 0 && (
              <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                {t('email.loading') || 'Loading...'}
              </div>
            )}
            {accounts.length === 0 && !loadingAccounts && (
              <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                {t('email.noAccounts') || 'No accounts configured'}
              </div>
            )}
            {accounts.map((acc) => {
              const active = acc.id === selectedAccountId;
              const prof = profiles.find((p) => p.user_id === acc.profile_id);
              return (
                <div
                  key={acc.id}
                  onClick={() => setSelectedAccountId(acc.id)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    backgroundColor: active ? 'var(--control-bg-active)' : 'transparent',
                    border: active ? '1px solid var(--accent)' : '1px solid transparent',
                    marginBottom: '6px',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {acc.label || acc.display_name || acc.email}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {acc.email}
                  </div>
                  {prof && (
                    <div style={{ fontSize: '10px', color: 'var(--accent)', marginTop: '3px' }}>
                      🔗 {prof.name || prof.user_id}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{acc.host}:{acc.port}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteAccount(acc.id);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--danger)',
                        cursor: 'pointer',
                        fontSize: '11px',
                        padding: '1px 3px',
                      }}
                      title={t('email.delete') || 'Delete'}
                    >
                      {t('email.delete') || 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Column 2: Folder Sidebar + Unread Counts */}
        <div style={{ backgroundColor: 'var(--surface-1)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: '13px' }}>
            {t('email.folders') || 'Folders'}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {loadingFolders && folders.length === 0 && (
              <div style={{ padding: '12px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '12px' }}>
                {t('email.loading') || 'Loading...'}
              </div>
            )}

            {/* Standard IMAP Folders */}
            {folders.map((f) => {
              const active = !isOutboxView && !isDraftsView && selectedFolder === f.name;
              return (
                <div
                  key={f.name}
                  onClick={() => {
                    setIsOutboxView(false);
                    setIsDraftsView(false);
                    setSelectedFolder(f.name);
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    backgroundColor: active ? 'var(--control-bg-active)' : 'transparent',
                    border: active ? '1px solid var(--accent)' : '1px solid transparent',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '13px',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    📁 {f.name}
                  </span>
                  {f.unread > 0 && (
                    <span
                      style={{
                        backgroundColor: 'var(--accent)',
                        color: '#fff',
                        borderRadius: '10px',
                        padding: '1px 6px',
                        fontSize: '11px',
                        fontWeight: 600,
                      }}
                    >
                      {f.unread}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Virtual Folders: Drafts & Outbox */}
            <div style={{ margin: '8px 0 4px', borderTop: '1px solid var(--border)' }} />

            <div
              onClick={() => {
                setIsOutboxView(false);
                setIsDraftsView(true);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                cursor: 'pointer',
                backgroundColor: isDraftsView ? 'var(--control-bg-active)' : 'transparent',
                border: isDraftsView ? '1px solid var(--accent)' : '1px solid transparent',
                fontSize: '13px',
                fontWeight: isDraftsView ? 600 : 400,
              }}
            >
              📝 {t('email.drafts') || 'Drafts'}
            </div>

            <div
              onClick={() => {
                setIsDraftsView(false);
                setIsOutboxView(true);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                cursor: 'pointer',
                backgroundColor: isOutboxView ? 'var(--control-bg-active)' : 'transparent',
                border: isOutboxView ? '1px solid var(--accent)' : '1px solid transparent',
                fontSize: '13px',
                fontWeight: isOutboxView ? 600 : 400,
              }}
            >
              📤 {t('email.outbox') || 'Outbox'}
            </div>
          </div>
        </div>

        {/* Column 3: Message / Drafts / Outbox List */}
        <div style={{ backgroundColor: 'var(--surface-1)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Header & Search */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: '13px' }}>
                {isOutboxView
                  ? t('email.outbox') || 'Outbox'
                  : isDraftsView
                  ? t('email.drafts') || 'Drafts'
                  : selectedFolder}
                {isCached && !isOutboxView && !isDraftsView && (
                  <span style={{ fontSize: '11px', padding: '2px 5px', backgroundColor: 'var(--warn, #eab308)', color: '#000', borderRadius: '4px', marginLeft: '6px' }}>
                    {t('email.cached') || 'Cached'}
                  </span>
                )}
              </span>
              {selectedAccountId && (
                <button
                  onClick={() => void loadContent(selectedAccountId)}
                  disabled={loadingMessages}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  {loadingMessages ? '...' : (t('email.refresh') || 'Refresh')}
                </button>
              )}
            </div>

            {!isOutboxView && !isDraftsView && (
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder={t('email.searchPlaceholder') || 'Search messages...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && selectedAccountId) {
                      void loadContent(selectedAccountId);
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: '5px 8px',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: '12px',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setUnreadOnly(!unreadOnly)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    backgroundColor: unreadOnly ? 'var(--control-bg-active)' : 'transparent',
                    color: unreadOnly ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: unreadOnly ? 600 : 400,
                  }}
                  title={t('email.markUnread') || 'Filter unread only'}
                >
                  ✉
                </button>
              </div>
            )}
          </div>

          {/* List Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {!selectedAccountId && (
              <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                {t('email.selectAccountPrompt') || 'Select an account to view messages'}
              </div>
            )}

            {/* Outbox View */}
            {selectedAccountId && isOutboxView && (
              <>
                {outboxItems.length === 0 && !loadingMessages && (
                  <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                    {t('email.noOutbox') || 'Outbox is empty'}
                  </div>
                )}
                {outboxItems.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--surface-2)',
                      marginBottom: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontWeight: 600,
                          backgroundColor:
                            item.status === 'sent'
                              ? 'var(--ok-bg, rgba(34, 197, 94, 0.15))'
                              : 'var(--danger-bg, rgba(239, 68, 68, 0.15))',
                          color: item.status === 'sent' ? 'var(--ok, #22c55e)' : 'var(--danger, #ef4444)',
                        }}
                      >
                        {item.status.toUpperCase()}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {new Date(item.createdAt || item.created_at || Date.now()).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{item.subject}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      To: {Array.isArray(item.to) ? item.to.join(', ') : item.to_addrs}
                    </div>
                    {item.error && (
                      <div style={{ fontSize: '11px', color: 'var(--danger)', backgroundColor: 'rgba(239, 68, 68, 0.08)', padding: '4px 6px', borderRadius: '4px', marginTop: '2px' }}>
                        {item.error}
                      </div>
                    )}
                    {item.providerMsgId && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        ID: {item.providerMsgId}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* Drafts View */}
            {selectedAccountId && isDraftsView && (
              <>
                {drafts.length === 0 && !loadingMessages && (
                  <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                    {t('email.noDrafts') || 'No drafts'}
                  </div>
                )}
                {drafts.map((d) => (
                  <div
                    key={d.id}
                    onClick={() => openDraftInComposer(d)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--surface-2)',
                      cursor: 'pointer',
                      marginBottom: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>{d.subject || '(No Subject)'}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteDraft(d.id);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--danger)',
                          cursor: 'pointer',
                          fontSize: '12px',
                        }}
                        title={t('email.delete') || 'Delete Draft'}
                      >
                        ✕
                      </button>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      To: {Array.isArray(d.to) ? d.to.join(', ') : d.to_addrs || '(No recipient)'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {d.bodyText ? d.bodyText.slice(0, 60) : d.body_text ? d.body_text.slice(0, 60) : ''}
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* IMAP Message List View */}
            {selectedAccountId && !isOutboxView && !isDraftsView && (
              <>
                {loadingMessages && messages.length === 0 && (
                  <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                    {t('email.loadingInbox') || 'Loading messages...'}
                  </div>
                )}
                {messages.length === 0 && !loadingMessages && (
                  <div style={{ padding: '16px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '13px' }}>
                    {error ? (t('email.inboxUnavailable') || 'Folder could not be read') : (t('email.noMessages') || 'Folder is empty')}
                  </div>
                )}
                {messages.map((msg) => {
                  const active = selectedMessage?.uid === msg.uid;
                  const isSeen = msg.seen || msg.flags?.some((f) => /\\seen/i.test(f));
                  const isFlagged = msg.flagged || msg.flags?.some((f) => /\\flagged/i.test(f));
                  const isAnswered = msg.answered || msg.flags?.some((f) => /\\answered/i.test(f));

                  return (
                    <div
                      key={msg.uid}
                      onClick={() => selectedAccountId && void loadMessage(selectedAccountId, msg.uid, selectedFolder)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        backgroundColor: active ? 'var(--control-bg-active)' : 'transparent',
                        border: active ? '1px solid var(--accent)' : '1px solid transparent',
                        marginBottom: '6px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                      }}
                    >
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: isSeen ? 400 : 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>
                          {msg.from}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {isAnswered && (
                            <span title={t('email.answered') || 'Replied'} style={{ fontSize: '11px', color: 'var(--accent)' }}>
                              ↩
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleFlag(msg.uid, 'flagged', Boolean(isFlagged));
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              color: isFlagged ? 'var(--warn, #eab308)' : 'var(--text-muted)',
                              fontSize: '13px',
                              padding: 0,
                            }}
                            title={isFlagged ? (t('email.unstar') || 'Unstar') : (t('email.star') || 'Star')}
                          >
                            ★
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleFlag(msg.uid, 'seen', Boolean(isSeen));
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              color: isSeen ? 'var(--text-muted)' : 'var(--accent)',
                              fontSize: '11px',
                              padding: 0,
                            }}
                            title={isSeen ? (t('email.markUnread') || 'Mark unread') : (t('email.markRead') || 'Mark read')}
                          >
                            {isSeen ? '○' : '●'}
                          </button>
                          <span>{msg.date.slice(0, 10)}</span>
                        </div>
                      </div>
                      <div style={{ fontWeight: isSeen ? 500 : 700, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {msg.subject || '(No Subject)'}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Column 4: Message View & Extracted Codes */}
        <div style={{ backgroundColor: 'var(--surface-1)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{t('email.messageView') || 'Message & Extracted Codes'}</span>
            {selectedMessage && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="btn"
                  onClick={() => openReplyComposer(selectedMessage)}
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                >
                  ↩ {t('email.reply') || 'Reply'}
                </button>
                <button
                  className="btn"
                  onClick={() => openForwardComposer(selectedMessage)}
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                >
                  ↪ {t('email.forward') || 'Forward'}
                </button>
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {loadingMessage && (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '24px' }}>
                {t('email.readingMessage') || 'Reading message...'}
              </div>
            )}

            {!selectedMessage && !loadingMessage && (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '24px', fontSize: '13px' }}>
                {t('email.selectMessagePrompt') || 'Select a message to view its body and verification codes'}
              </div>
            )}

            {selectedMessage && !loadingMessage && (
              <>
                {/* Extracted Codes Section (Byte-identical flow preserved) */}
                <div style={{ backgroundColor: 'var(--surface-2)', borderRadius: '6px', padding: '12px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>
                    {t('email.extractedCodes') || 'Extracted Verification Codes / Links'}
                  </div>
                  {extractedCodes.length === 0 ? (
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      {t('email.noCodesFound') || 'No codes or links detected in this message.'}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {extractedCodes.map((code) => {
                        const isLink = code.startsWith('http://') || code.startsWith('https://');
                        const isCopied = copiedCode === code;
                        return (
                          <div
                            key={code}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              padding: '6px 12px',
                              borderRadius: '6px',
                              backgroundColor: 'var(--control-bg-active)',
                              border: '1px solid var(--accent)',
                              fontSize: '13px',
                            }}
                          >
                            {isLink ? (
                              <a
                                href={code}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: 'var(--accent)', textDecoration: 'none', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              >
                                {code}
                              </a>
                            ) : (
                              <span style={{ fontWeight: 700, fontFamily: 'monospace', letterSpacing: '1px', fontSize: '15px', color: 'var(--text)' }}>
                                {code}
                              </span>
                            )}
                            <button
                              onClick={() => handleCopyCode(code)}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: isCopied ? 'var(--ok, #22c55e)' : 'var(--accent)',
                                cursor: 'pointer',
                                padding: '2px 4px',
                                fontSize: '12px',
                                fontWeight: isCopied ? 600 : 500,
                              }}
                            >
                              {isCopied ? (t('email.copied') || 'Copied!') : (t('email.copy') || 'Copy')}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Message Header */}
                <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
                  <h2 style={{ fontSize: '18px', margin: '0 0 8px', fontWeight: 600 }}>
                    {selectedMessage.subject || '(No Subject)'}
                  </h2>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div><strong>From:</strong> {selectedMessage.from}</div>
                    <div><strong>Date:</strong> {selectedMessage.date}</div>
                  </div>
                </div>

                {/* Message Body */}
                <div
                  style={{
                    fontSize: '14px',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                  }}
                >
                  {selectedMessage.body}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Account Settings / Add Modal */}
      {showAccountModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--surface-1)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              width: '520px',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '24px',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600 }}>
              {modalMode === 'create'
                ? t('email.addAccount') || 'Add Email Account'
                : t('email.editAccount') || 'Edit Account Settings'}
            </h2>
            <form onSubmit={handleSaveAccount} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {t('email.label') || 'Label'}
                </label>
                <input
                  type="text"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder="My Gmail / Outlook"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.email') || 'Email'}
                  </label>
                  <input
                    type="email"
                    required
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    placeholder="user@example.com"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.displayName') || 'Display Name'}
                  </label>
                  <input
                    type="text"
                    value={formDisplayName}
                    onChange={(e) => setFormDisplayName(e.target.value)}
                    placeholder="John Doe"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
              </div>

              {/* Profile Binding Picker */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {t('email.boundProfile') || 'Bound Browser Profile'}
                </label>
                <select
                  value={formProfileId}
                  onChange={(e) => setFormProfileId(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  <option value="">{t('email.unbound') || 'None (Unbound)'}</option>
                  {profiles.map((p) => (
                    <option key={p.user_id} value={p.user_id}>
                      {p.name || p.user_id}
                    </option>
                  ))}
                </select>
              </div>

              {/* IMAP Config */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  IMAP Settings
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: '8px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.host') || 'IMAP Host'}
                  </label>
                  <input
                    type="text"
                    required
                    value={formHost}
                    onChange={(e) => setFormHost(e.target.value)}
                    placeholder="imap.example.com"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.port') || 'Port'}
                  </label>
                  <input
                    type="number"
                    required
                    value={formPort}
                    onChange={(e) => setFormPort(e.target.value)}
                    placeholder="993"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.username') || 'Username'}
                  </label>
                  <input
                    type="text"
                    value={formUsername}
                    onChange={(e) => setFormUsername(e.target.value)}
                    placeholder="Leave empty to use Email"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {t('email.password') || 'Password'}
                    </label>
                    {modalMode === 'edit' && selectedAccount?.has_password && !revealedPassword && (
                      <button
                        type="button"
                        onClick={() => void handleRevealPassword()}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '11px', padding: 0 }}
                      >
                        {t('email.revealPassword') || 'Reveal'}
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={revealedPassword ?? formPassword}
                    onChange={(e) => {
                      setFormPassword(e.target.value);
                      setRevealedPassword(null);
                    }}
                    placeholder={modalMode === 'edit' ? '(Leave empty to keep existing)' : '••••••••'}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
              </div>

              {/* SMTP Config */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  SMTP Settings (Send)
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 100px', gap: '8px', alignItems: 'end' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.smtpHost') || 'SMTP Host'}
                  </label>
                  <input
                    type="text"
                    value={formSmtpHost}
                    onChange={(e) => setFormSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('email.smtpPort') || 'Port'}
                  </label>
                  <input
                    type="number"
                    value={formSmtpPort}
                    onChange={(e) => setFormSmtpPort(e.target.value)}
                    placeholder="465"
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                  />
                </div>
                <div style={{ paddingBottom: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={formSmtpSecure}
                      onChange={(e) => setFormSmtpSecure(e.target.checked)}
                    />
                    <span>SSL/TLS</span>
                  </label>
                </div>
              </div>

              {/* Signature */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  {t('email.signature') || 'Signature'}
                </label>
                <textarea
                  rows={2}
                  value={formSignature}
                  onChange={(e) => setFormSignature(e.target.value)}
                  placeholder="Sent from my Browser Profile"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)', resize: 'vertical' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowAccountModal(false)}
                >
                  {t('email.cancel') || 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="btn primary"
                >
                  {t('email.save') || 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Composer Modal */}
      {showComposer && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--surface-1)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              width: '600px',
              maxHeight: '90vh',
              overflowY: 'auto',
              padding: '24px',
              boxShadow: 'var(--shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
                {composerInReplyTo
                  ? t('email.reply') || 'Reply'
                  : composerDraftId
                  ? `${t('email.drafts') || 'Draft'}`
                  : t('email.newEmail') || 'New Message'}
              </h2>
              <button
                onClick={() => setShowComposer(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px' }}
              >
                ✕
              </button>
            </div>

            {composerError && (
              <div style={{ padding: '10px 12px', backgroundColor: 'var(--danger-bg, rgba(239, 68, 68, 0.1))', border: '1px solid var(--danger)', borderRadius: '6px', color: 'var(--danger)', fontSize: '13px' }}>
                {composerError}
              </div>
            )}

            {composerNotice && (
              <div style={{ padding: '8px 12px', backgroundColor: 'var(--ok-bg, rgba(34, 197, 94, 0.15))', border: '1px solid var(--ok, #22c55e)', borderRadius: '6px', color: 'var(--ok, #22c55e)', fontSize: '13px' }}>
                {composerNotice}
              </div>
            )}

            <form onSubmit={handleSendMail} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                  {t('email.to') || 'To'}
                </label>
                <input
                  type="text"
                  required
                  placeholder="recipient@example.com, other@example.com"
                  value={composerTo}
                  onChange={(e) => setComposerTo(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                    {t('email.cc') || 'Cc'}
                  </label>
                  <input
                    type="text"
                    value={composerCc}
                    onChange={(e) => setComposerCc(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)', fontSize: '13px' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                    {t('email.bcc') || 'Bcc'}
                  </label>
                  <input
                    type="text"
                    value={composerBcc}
                    onChange={(e) => setComposerBcc(e.target.value)}
                    style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)', fontSize: '13px' }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                  {t('email.subject') || 'Subject'}
                </label>
                <input
                  type="text"
                  required
                  value={composerSubject}
                  onChange={(e) => setComposerSubject(e.target.value)}
                  placeholder="Subject"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {t('email.body') || 'Body'}
                  </label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      onClick={() => setComposerIsHtml(false)}
                      style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        border: 'none',
                        backgroundColor: !composerIsHtml ? 'var(--control-bg-active)' : 'transparent',
                        color: !composerIsHtml ? 'var(--accent)' : 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: !composerIsHtml ? 600 : 400,
                      }}
                    >
                      {t('email.bodyText') || 'Plain Text'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setComposerIsHtml(true)}
                      style={{
                        padding: '2px 8px',
                        borderRadius: '4px',
                        border: 'none',
                        backgroundColor: composerIsHtml ? 'var(--control-bg-active)' : 'transparent',
                        color: composerIsHtml ? 'var(--accent)' : 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: composerIsHtml ? 600 : 400,
                      }}
                    >
                      {t('email.bodyHtml') || 'HTML'}
                    </button>
                  </div>
                </div>

                {!composerIsHtml ? (
                  <textarea
                    rows={10}
                    value={composerBodyText}
                    onChange={(e) => setComposerBodyText(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px',
                      borderRadius: '4px',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontFamily: 'inherit',
                      fontSize: '13px',
                      lineHeight: '1.5',
                      resize: 'vertical',
                    }}
                  />
                ) : (
                  <textarea
                    rows={10}
                    value={composerBodyHtml}
                    onChange={(e) => setComposerBodyHtml(e.target.value)}
                    placeholder="<p>HTML content...</p>"
                    style={{
                      width: '100%',
                      padding: '10px',
                      borderRadius: '4px',
                      border: '1px solid var(--border)',
                      backgroundColor: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontFamily: 'monospace',
                      fontSize: '12px',
                      lineHeight: '1.5',
                      resize: 'vertical',
                    }}
                  />
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={composerSavingDraft}
                  onClick={() => void handleSaveDraft()}
                  style={{ fontSize: '13px' }}
                >
                  {composerSavingDraft ? (t('email.savingDraft') || 'Saving...') : (t('email.saveDraft') || 'Save Draft')}
                </button>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setShowComposer(false)}
                    style={{ fontSize: '13px' }}
                  >
                    {t('email.cancel') || 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={composerSending}
                    style={{ fontSize: '13px' }}
                  >
                    {composerSending ? (t('email.sending') || 'Sending...') : (t('email.send') || 'Send')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Email;
