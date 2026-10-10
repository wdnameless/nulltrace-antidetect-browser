# Privacy Policy — Nulltrace (Google Drive sync)

> Paste-ready policy for the homepage. Keep this exact text at the URL linked from the OAuth
> consent screen: Google requires the document on the homepage and the document linked from the
> consent screen to be the same.

## What Nulltrace accesses on Google Drive

Nulltrace uses the `drive.file` scope. With this scope the app can only read and write files **it
created itself** — a folder named `nulltrace data` in your Google Drive. It cannot see, read, list,
or modify any of your other Drive files, and it never touches them.

## What is stored in that folder

Your encrypted browser-profile data: profile settings, cookies and site sessions, proxies, tags,
notes, vault credentials, scripts, and app settings. The payload is encrypted on your device with
AES-256-GCM under a passphrase only you know, before anything is uploaded. Google stores the bytes;
it cannot decrypt them.

## What we do not do

- No human ever reads your data. Support cannot open your Drive folder, and the developers have no
  access mechanism to it.
- Nothing is sold, shared with advertisers or data brokers, or used for ads, credit, or lending.
- Nothing is used to train models.
- Nothing leaves your account except to your own other machines running Nulltrace with the same
  passphrase. There is no company server that sees the data in transit or at rest.

## Revoking access

You can revoke Nulltrace's access at any time from your Google account
(myaccount.google.com → Security → Third-party access). Revoking stops syncing
immediately. Everything already on your machines stays untouched; the `nulltrace data` folder on
Drive stays encrypted and unreadable without your passphrase.

## Deleting your cloud data

Delete the `nulltrace data` folder in Google Drive, or disconnect from the app's Cloud settings
page. Disconnecting clears the app's credentials on that machine; it does not delete local data.

## Contact

Questions about this policy: the project contact email listed in the Google Cloud Console for this
app's OAuth client.
