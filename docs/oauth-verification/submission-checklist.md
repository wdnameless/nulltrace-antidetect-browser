# Google verification: what to do in the console

Scope `drive.file` is non-sensitive, so the review is brand verification only: no demo video, no
scope justification, no security assessment. Everything below happens in Google Cloud Console for
project `609547936669`; nothing here requires a code change.

## 1. Domain (once)

- Own a domain. In Search Console, verify ownership with an account that is owner/editor of the GCP
  project.

## 2. Homepage (on that domain)

Must: identify the app, describe what it does (not a login page), and link the privacy policy.

Paste-ready skeleton:

> **Nulltrace** — an antidetect browser that keeps your browser profiles in sync across your own
> machines through your personal Google Drive.
> [Privacy Policy](<same URL as on the consent screen>)

## 3. Privacy policy (same domain)

Use `docs/oauth-verification/privacy-policy.md` from this repo verbatim. The URL you publish must
be byte-identical to the one you enter on the consent screen.

## 4. Consent screen fields

- App name: matches what users see.
- Homepage URL: from step 2.
- Privacy Policy URL: from step 3.
- Authorized domains: the domain from step 1.
- Developer contact: an email you actually read — Google uses it for every notice.
- Scopes: `.../auth/drive.file` only. Nothing else.

## 5. The connect button

The in-app button already carries the unaltered Google "G" mark, as the branding rules require for
the control that initiates consent. The waiting state and the in-product privacy notice on the Cloud
Sync page cover the "accurate notice" part.

## 6. Submit

OAuth consent screen → Publish / Submit for verification. With non-sensitive scopes only, the
review covers identity and disclosures. After approval, re-run connect once on each machine:
refresh tokens issued to test users do not survive the transition.
