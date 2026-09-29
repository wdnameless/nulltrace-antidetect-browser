# Recon: Afina Parity Expansion

## Scope
1. **Clear Profile Cache** (Single & Bulk):
   - Backend: endpoint `/api/v1/browser-profile/clear-cache` to wipe `Cache`, `Code Cache`, `GPUCache`, `DawnWebGPUCache`, `Service Worker/CacheStorage` from profile userDataDir without touching `Cookies`, `Local Storage`, `IndexedDB`, or preferences.
   - Frontend: "Clear Cache" in Profile row more-menu and bulk action bar.
2. **Proxy XLSX Import/Export**:
   - Backend: endpoints `/api/v1/proxies/import-xlsx` and `/api/v1/proxies/export-xlsx` using `src/main/io/xlsx.ts`.
   - Frontend: Import XLSX / Export XLSX buttons on Proxies page.
3. **Login by Token**:
   - Backend: endpoint `/api/v1/browser-profile/login-token` injecting session tokens (Discord, Telegram, generic Web Storage/Cookie token).
   - Frontend: "Login by Token" action in Profile menu.
4. **User Databases & SQL Terminal**:
   - Backend: routes `/api/v1/databases/*` for creating custom SQLite tables, running queries in SQL terminal, importing/exporting.
   - Frontend: Page `Databases.tsx` with table list, query editor/terminal, results grid, import/export. Added to Sidebar.
5. **In-App AI Chat (Afina AI / ChatGPT)**:
   - Backend: `/api/v1/ai/chat` proxying user requests to OpenAI / Anthropic / Local LLM using API keys configured in settings.
   - Frontend: Page or drawer `AiChat.tsx` in UI sidebar.

## Files Touched
- `src/main/profiles/profileManager.ts` (clearCache, token injection)
- `src/main/api/routes/profiles.ts` / `browser.ts` (clear cache, login token)
- `src/main/api/routes/proxy.ts` (import/export XLSX)
- `src/main/db/userDatabases.ts` (new: custom user tables manager)
- `src/main/api/routes/databases.ts` (new: database routes)
- `src/main/ai/chatManager.ts` (new: AI chat streaming/proxy)
- `src/main/api/routes/ai.ts` (new: AI chat routes)
- `src/renderer/src/pages/Profiles.tsx` (Clear Cache, Login by Token buttons & modals)
- `src/renderer/src/pages/Proxies.tsx` (Export/Import XLSX buttons)
- `src/renderer/src/pages/Databases.tsx` (new: Databases page with SQL terminal)
- `src/renderer/src/pages/AiChat.tsx` (new: AI Assistant chat page)
- `src/renderer/src/App.tsx` (navigation routes for Databases and AI Chat)
- `src/renderer/src/components/Sidebar.tsx` (links for Databases and AI Chat)

## Acceptance Check
- Clear cache removes cache dirs, leaves cookies intact.
- Proxy XLSX exports valid `.xlsx` and imports rows cleanly.
- User Databases creates custom tables and executes SELECT/INSERT in terminal.
- AI Chat sends messages and receives responses.
- Full test suite passes, `npm run build` passes cleanly.
