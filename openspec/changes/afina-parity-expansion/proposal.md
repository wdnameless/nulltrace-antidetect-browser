# Proposal: Afina Feature Parity Expansion

## Problem Statement
While NullTrace covers 85-90% of Afina's feature surface, several critical capabilities documented in `.afina-features-map.md` are absent:
1. Clearing cache without destroying session cookies.
2. Excel (.xlsx) roundtrip for Proxies.
3. Rapid token-based authentication (Discord, Telegram, Twitter, custom tokens).
4. Custom user SQLite database tables and SQL terminal.
5. In-app AI chat interface.

## Solution Architecture
1. **Profile Cache Erasure**:
   Safely remove only cache directories (`Cache`, `Code Cache`, `GPUCache`, `DawnWebGPUCache`, `Service Worker/CacheStorage`) from profile directory. Keep `Cookies`, `Local Storage`, `IndexedDB`, and state intact.
2. **Proxy XLSX Importer/Exporter**:
   Leverage existing `src/main/io/xlsx.ts` to export all proxies with headers `[type, host, port, username, password, name, status]` and import them back.
3. **Token Login**:
   Provide helper to inject tokens directly into profile storage (localStorage / CDP Storage / Cookies) so profiles open directly authenticated.
4. **User Databases & SQL Terminal**:
   Provide an isolated SQLite database file `user_data.db` (or user table namespace in existing db) with an interactive SQL terminal and schema constructor.
5. **AI Chat**:
   Integrate an OpenAI-compatible / Anthropic / custom endpoint proxy with streaming or async response, plus a sleek chat UI with conversation history.
