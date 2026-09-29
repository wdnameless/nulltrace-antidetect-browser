# Операторский Runbook: Управление лицензиями NullTrace

Документ описывает полный жизненный цикл лицензионных ключей и токенов приложения NullTrace: генерацию новой пары ключей, ротацию, выпуск лицензий пользователям и отзыв.

---

## 1. Архитектура и безопасность ключей

- **Алгоритм**: Ed25519 (RFC 8032).
- **Публичный ключ**:
  - Расположение в репозитории: `resources/license-public-key.pem`.
  - Синхронизируется в код TypeScript (`src/main/licensing/publicKey.ts`) и встраивается в бинарник Rust (`src-tauri/src/license.rs`).
- **Приватный ключ**:
  - Текущее хранение: `D:/nulltrace-keys/license-private.pem` (**ВНЕ репозитория**).
  - **КРИТИЧЕСКИЙ ЗАПРЕТ**: Приватный ключ **НИКОГДА** не коммитится, не пушится в git, не выкладывается на CI и не вставляется в промпты нейросетей.
  - При любой компрометации приватного ключа требуется немедленная ротация пары ключей и пересборка клиентских релизов.

---

## 2. Генерация и ротация ключевой пары

Если приватный ключ скомпрометирован или требуется плановая смена ключа:

### Шаг 1: Создание новой пары ключей Ed25519
Сгенерируйте новую пару ключей с помощью стандартного `openssl` (или встроенного Node.js):

```bash
# Создание папки вне репозитория
mkdir -p "D:/nulltrace-keys"

# Генерация приватного ключа PKCS#8 Ed25519
openssl genpkey -algorithm ed25519 -out "D:/nulltrace-keys/license-private.pem"

# Извлечение публичного ключа в формате SPKI PEM
openssl pkey -in "D:/nulltrace-keys/license-private.pem" -pubout -out "resources/license-public-key.pem"
```

Альтернативно через Node.js:
```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync('D:/nulltrace-keys/license-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync('resources/license-public-key.pem', publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Generated new keypair.');
"
```

### Шаг 2: Синхронизация публичного ключа в код приложения
После обновления `resources/license-public-key.pem` запустите скрипт синхронизации:

```bash
node scripts/sync-license-key.mjs
```

Скрипт проверяет fingerprint ключа и обновляет `src/main/licensing/publicKey.ts` (а также используется сборщиком Rust `src-tauri`).

### Шаг 3: Пересборка релизов
Поскольку публичный ключ вшит в бинарные файлы и исходный код:
1. Запустите тесты: точечные тесты модуля лицензирования должны проходить с новым публичным ключом.
2. Соберите новые установщики (Windows, macOS, Linux).
3. Все лицензии, выпущенные старым ключом, перестанут приниматься новыми версиями NullTrace.

---

## 3. Выпуск пользовательских лицензий (Issuance)

Лицензия представляет собой подписанный токен формата:
`<base64url(payload)>.<base64url(signature)>`

Payload содержит:
```json
{
  "plan": "pro",
  "exp": 1770000000,
  "email": "user@example.com"
}
```

### Команда выпуска лицензии
Скрипт `scripts/make-license.mjs` принимает приватный ключ тремя способами (приоритет): `--key <path|pem>` → env `LICENSE_PRIVATE_KEY` (содержимое PEM) → env `LICENSE_PRIVATE_KEY_PATH` (путь к файлу):
```bash
# Бессрочная Pro-лицензия
node scripts/make-license.mjs --key "D:/nulltrace-keys/license-private.pem" --plan pro --perpetual --email user@example.com

# Лицензия с ограниченным сроком (например, на 30 дней)
node scripts/make-license.mjs --key "D:/nulltrace-keys/license-private.pem" --plan pro --days 30 --email client@corp.com

# Выпуск через переменную окружения (содержимое PEM — приоритетнее пути)
export LICENSE_PRIVATE_KEY="$(cat D:/nulltrace-keys/license-private.pem)"
node scripts/make-license.mjs --plan pro --days 30 --email enterprise@domain.com
# ...или путём к файлу:
export LICENSE_PRIVATE_KEY_PATH="D:/nulltrace-keys/license-private.pem"
node scripts/make-license.mjs --plan pro --days 30 --email enterprise@domain.com
```
Флаги: `--plan` только `pro` (другое — ошибка); `--days N` несовместим с `--exp/--perpetual`; `--key` принимает путь к файлу или сам PEM. Старые `--email/--exp/--perpetual` без `--plan` работают как раньше.

Вывод команды содержит токен лицензии, который передаётся покупателю для ввода в настройках NullTrace (**Настройки -> Лицензия**).

---

## 4. Отзыв лицензий (Revocation)

Поскольку валидация лицензий в NullTrace является автономной (офлайн) на базе Ed25519-подписи:
- **Индивидуальный отзыв скомпрометированного токена**: ⚠️ НЕ РЕАЛИЗОВАН — статический revocation list отсутствует в `src/main/licensing/licenseManager.ts` и `src-tauri/src/license.rs`. Действенный отзыв сегодня — только ротация ключей (п.2) + перевыпуск.
- **Массовый отзыв / утечка приватного вендор-ключа**:
  1. Выполнить **Шаг 2 (Ротация)**: сгенерировать новую пару ключей.
  2. Выпустить новые валидные лицензии добросовестным клиентам с помощью нового приватного ключа.
  3. Опубликовать релиз приложения со смененным публичным ключом. Все нелегитимные лицензии, сгенерированные злоумышленниками старым ключом, автоматически перестанут работать в обновленных клиентах.
