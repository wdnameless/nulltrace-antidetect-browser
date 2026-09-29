# Tasks: Afina Feature Parity Expansion

- [ ] 1. Backend: Implement `clearProfileCache` & `clearBulkProfileCache` in `src/main/profiles/profileManager.ts` and add route `/api/v1/browser-profile/clear-cache`
- [ ] 2. Backend: Implement Proxy XLSX export & import routes in `src/main/api/routes/proxy.ts` using `src/main/io/xlsx.ts`
- [ ] 3. Backend: Implement Token Login helper `src/main/profiles/tokenLogin.ts` and route `/api/v1/browser-profile/login-token`
- [ ] 4. Backend: Implement User Databases engine in `src/main/db/userDatabases.ts` and routes `/api/v1/databases/*`
- [ ] 5. Backend: Implement AI Chat manager `src/main/ai/chatManager.ts` and routes `/api/v1/ai/*`
- [ ] 6. Frontend: Add Clear Cache & Login by Token to `Profiles.tsx` (row menu, bulk action, modals)
- [ ] 7. Frontend: Add Export XLSX & Import XLSX to `Proxies.tsx`
- [ ] 8. Frontend: Create `Databases.tsx` (Tables manager, SQL query terminal, results table)
- [ ] 9. Frontend: Create `AiChat.tsx` (Chat UI, provider/model settings, message history)
- [ ] 10. Frontend: Add Databases & AI Chat links to Sidebar and App router
- [ ] 11. Verification: Unit tests for clearCache, proxy XLSX, token login, user databases, AI chat; verify full test suite & build.
