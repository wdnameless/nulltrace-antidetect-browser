# Requirements Manifest: Afina Feature Parity Expansion

## Verbatim User Input
> "По этом функционалу мы все реализовали ? Workspace file: .afina-features-map.md, .afina-digest.md"
> "ПРиступай"

## Verbatim Reference Inputs (.afina-features-map.md / .afina-digest.md)
> "Очистка кэша (одиночная/массовая/авто), удаление данных расширений" (.afina-features-map.md §1)
> "Импорт/экспорт Excel" (.afina-features-map.md §2)
> "Вход по токену (login by token), массовая очистка токенов" (.afina-features-map.md §1)
> "Базы данных: локальные SQL-таблицы, конструктор, SQL-терминал, импорт/экспорт" (.afina-features-map.md §6)
> "Afina AI (ChatGPT API, прокси для AI, чат)" (.afina-features-map.md §5)

## Requirements Traceability

| Req ID | Source Quote | Description | Target Component | Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- |
| R01 | "Очистка кэша (одиночная/массовая/авто)" | Очистка кэша профилей (Cache, Code Cache, GPUCache) без удаления куки | `src/main/profiles/profileManager.ts`, `Profiles.tsx` | Кнопка «Clear Cache» очищает кэш-каталоги, куки и сессии остаются нетронутыми |
| R02 | "Импорт/экспорт Excel" (Прокси) | Экспорт и импорт списка прокси в формате XLSX | `src/main/api/routes/proxy.ts`, `Proxies.tsx` | Скачивание `.xlsx` файла со всеми прокси и загрузка `.xlsx` с созданием прокси |
| R03 | "Вход по токену (login by token)" | Вход в профиль по токену авторизации сервиса | `src/main/profiles/tokenLogin.ts`, `Profiles.tsx` | Модальное окно ввода токена, инъекция в LocalStorage / Cookies профиля |
| R04 | "Базы данных: локальные SQL-таблицы, конструктор, SQL-терминал" | Пользовательские базы данных, создание таблиц, SQL терминал | `src/main/db/userDatabases.ts`, `Databases.tsx` | Страница «Базы данных», создание таблиц, выполнение SQL запросов |
| R05 | "Afina AI (ChatGPT API, прокси для AI, чат)" | Встроенное окно AI-чата с поддержкой OpenAI/Claude/Local API | `src/main/ai/chatManager.ts`, `AiChat.tsx` | Страница «AI Чат», отправка запросов к LLM API и получение ответов |
