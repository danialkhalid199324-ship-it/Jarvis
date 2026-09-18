/**
 * Microsoft Graph delegated permissions Jarvis requests, and why.
 *
 * Every scope here is *delegated* — Jarvis acts as the signed-in user and can
 * only ever reach what that person can already reach themselves. Jarvis
 * requests no application permissions, so it has no organisation-wide mailbox
 * or calendar access, and no ability to read anyone else's mail.
 *
 * None of these normally require a tenant administrator's consent: each is
 * user-consentable by default. A tenant that has disabled user consent
 * entirely will need an administrator to approve them once, for this app, for
 * this user — that is a tenant policy choice, not a wider grant, and Jarvis
 * reports it plainly rather than asking for something broader.
 */

export interface ScopeRationale {
  scope: string
  /** What breaks without it. */
  neededFor: string
  /** True when Microsoft requires an administrator to consent. */
  requiresAdminConsent: boolean
}

/**
 * Read-only scopes, requested when an account is first connected.
 *
 * Jarvis asks for the write scopes at the same time because a consent prompt
 * mid-conversation is worse for the user than one up front — but note that
 * holding a scope is not permission to act. Every send and every calendar
 * change still passes through the approval engine.
 */
export const GRAPH_SCOPES: ScopeRationale[] = [
  {
    scope: 'openid',
    neededFor: 'Sign-in itself. Required by the Microsoft identity platform.',
    requiresAdminConsent: false
  },
  {
    scope: 'profile',
    neededFor: "Showing your name on the connected-account card.",
    requiresAdminConsent: false
  },
  {
    scope: 'offline_access',
    neededFor:
      'Staying connected after a restart, so you do not sign in again every time Jarvis opens.',
    requiresAdminConsent: false
  },
  {
    scope: 'User.Read',
    neededFor:
      'Reading your own name, email address and tenant, so Jarvis can label the account and show which mailbox a result came from.',
    requiresAdminConsent: false
  },
  {
    scope: 'Mail.Read',
    neededFor:
      'Listing, searching and reading your mail so Jarvis can answer questions about it. Read-only on its own.',
    requiresAdminConsent: false
  },
  {
    scope: 'Mail.Send',
    neededFor:
      'Sending a reply you have explicitly approved. Jarvis never sends without an approval step.',
    requiresAdminConsent: false
  },
  {
    scope: 'Calendars.ReadWrite',
    neededFor:
      'Reading your calendar, and creating, changing or cancelling an event you have explicitly approved. Microsoft has no separate scope for "read plus approved writes", so this single scope covers both.',
    requiresAdminConsent: false
  }
]

/** The scope strings passed to MSAL. */
export const REQUESTED_SCOPES: string[] = GRAPH_SCOPES.map((s) => s.scope)

/**
 * Scopes sent on a token request. `openid`, `profile` and `offline_access` are
 * reserved OIDC scopes that MSAL adds itself and rejects if passed explicitly.
 */
export const TOKEN_SCOPES: string[] = REQUESTED_SCOPES.filter(
  (s) => !['openid', 'profile', 'offline_access'].includes(s)
)
