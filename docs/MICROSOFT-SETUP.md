# Connecting Microsoft 365 to Jarvis

You need to register Jarvis once with Microsoft. It takes about five minutes,
costs nothing, and you only do it once.

Jarvis is a **public client** — a desktop app with no server behind it — so
there is no secret to create and nothing sensitive to copy around. The only
thing you will paste into Jarvis is an application ID, which is not a secret.

## 1. Register the app

1. Go to [portal.azure.com](https://portal.azure.com) and sign in with the
   Microsoft account you want to connect.
2. Search for **App registrations** and choose **New registration**.
3. Name it `Jarvis` (only you will see this).
4. Under **Supported account types**, choose:
   - *Accounts in any organizational directory and personal Microsoft accounts*
     if you want to connect both work and personal accounts, or
   - *Accounts in this organizational directory only* to restrict it to one
     business.
5. Under **Redirect URI**, choose **Public client/native (mobile & desktop)**
   from the dropdown and enter:

   ```
   http://localhost
   ```

6. Select **Register**.

## 2. Confirm it is a public client

1. Open your new app → **Authentication**.
2. Scroll to **Advanced settings** → **Allow public client flows** and set it to
   **Yes**. Save.

This is what lets Jarvis sign you in without a client secret.

## 3. Copy the application ID

On the app's **Overview** page, copy **Application (client) ID**. It looks like
`0a1b2c3d-4e5f-6789-abcd-ef0123456789`.

## 4. Paste it into Jarvis

Open Jarvis → **Settings → Connected Accounts**, paste the ID, and press
**Save**. Then press **Connect Microsoft Account**.

Your browser opens, Microsoft asks you to sign in and to approve the
permissions, and Jarvis picks up from there. Repeat **Connect Microsoft
Account** for each additional account — GTA, Titan, ICC, personal, whichever
you need. Each is independent and separately labelled.

## Permissions Jarvis asks for, and why

Every one is a **delegated** permission: Jarvis acts as you, and can only reach
what you could already reach yourself. Jarvis requests no application
permissions, so it has no organisation-wide access and cannot read anyone
else's mailbox.

| Permission | Why Jarvis needs it |
|---|---|
| `openid`, `profile` | Sign-in itself, and your name on the account card. |
| `offline_access` | Staying connected after a restart, so you don't sign in every time. |
| `User.Read` | Your own name, email and tenant — so Jarvis can label the account and show which mailbox a result came from. |
| `Mail.Read` | Listing, searching and reading your mail. Read-only on its own. |
| `Mail.Send` | Sending a reply **you have explicitly approved**. Jarvis has no automatic send path. |
| `Calendars.ReadWrite` | Reading your calendar, and making a change **you have explicitly approved**. Microsoft has no separate "read plus approved writes" scope, so this one covers both. |

None of these normally need an administrator. They are all user-consentable by
default.

**If your workplace has switched off user consent** — some organisations do —
Microsoft will say an administrator must approve the app. That is a tenant
policy, and the approval is for this app, for your account. Jarvis will not ask
for anything broader to work around it. If that happens, show your IT
administrator this page.

## What Jarvis stores, and where

- **Your tokens** live in an encrypted cache, locked by your macOS keychain.
  They are never written to a settings file, never logged, never shown in the
  Jarvis window, and never sent to an AI provider. If the keychain is
  unavailable, Jarvis refuses to save them rather than writing them in the
  clear.
- **The application ID** is stored in `settings.json`. It is not a secret.
- **Account identity** — your name, email address, tenant and label — is stored
  so the account list survives a restart.

## Disconnecting

**Settings → Connected Accounts → Disconnect** removes the account and its
tokens from this Mac. To revoke Jarvis's access from Microsoft's side as well,
go to [myapps.microsoft.com](https://myapps.microsoft.com) or your Microsoft
account's security settings and remove the app there.
