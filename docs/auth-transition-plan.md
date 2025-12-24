# User Authentication Transition Plan

Moving from invite-only Cloudflare Access to public-facing user authentication with Google OAuth.

**Last updated**: December 2024

---

## Executive Summary

TLDL currently uses Cloudflare Access with email OTP for authentication, limiting access to invited users. This plan outlines transitioning to Google OAuth, allowing any user with a Google account to sign in and submit episodes—no passwords to store, no invite management overhead.

---

## Current State

### How It Works Now

| Component | Implementation |
|-----------|----------------|
| **Authentication** | Cloudflare Access (email OTP) |
| **Authorization** | JWT in `Cf-Access-Jwt-Assertion` header |
| **User Identity** | Email extracted from JWT via `getUserEmailFromJwt()` |
| **Protected Routes** | `/profile/*`, `/submit*`, `/job/*` |
| **User Storage** | None—episodes store `submittedBy` email inline |
| **Admin Check** | Email in `ADMIN_EMAILS` array (`src/lib/constants.ts`) |

### Key Files

- [auth.ts](file:///Users/rian/Documents/GitHub/tldl/src/lib/auth.ts) — JWT parsing, admin check
- [authenticated.ts](file:///Users/rian/Documents/GitHub/tldl/src/routes/authenticated.ts) — Protected routes, `requireAuth()` middleware
- [constants.ts](file:///Users/rian/Documents/GitHub/tldl/src/lib/constants.ts) — `ADMIN_EMAILS` array
- [kv.ts](file:///Users/rian/Documents/GitHub/tldl/src/lib/kv.ts) — Rate limiting uses `ratelimit:{email}:{hour}` keys

---

## Options Analysis

### Option 1: Add Google as Cloudflare Access Identity Provider (Recommended)

**The easiest path.** Cloudflare Access supports Google as an identity provider. No code changes required for authentication flow—Cloudflare handles OAuth, and you still get the same JWT.

**Pros:**
- Zero code changes to auth logic
- Same JWT structure (email claim continues to work)
- Cloudflare handles OAuth token refresh, session management
- Can keep email OTP as a fallback option
- ~30 minute setup

**Cons:**
- Still requires Cloudflare Access configuration
- Users see Cloudflare login page (customizable)

**Implementation:**
1. Configure Google OAuth in GCP Console
2. Add Google as identity provider in Cloudflare Zero Trust
3. Update Access policy to allow Google-authenticated users
4. Remove email allowlist restriction (or adjust policy)

---

### Option 2: Native OAuth in Cloudflare Workers

Implement OAuth flow directly in your Worker code.

**Pros:**
- Full control over login UI and UX
- No Cloudflare Access dependency
- Can customize the entire auth experience

**Cons:**
- Significant code changes (~400-600 lines)
- Must handle OAuth state, PKCE, token storage
- Need secure session management (cookies + KV)
- More attack surface to secure
- Ongoing maintenance burden

**Implementation:**
- Add routes: `/auth/login`, `/auth/callback`, `/auth/logout`
- Store sessions in KV with secure cookies
- Implement token refresh logic
- Rewrite `requireAuth()` middleware

---

### Option 3: Third-Party Auth Service (Auth0, Clerk, etc.)

Use a dedicated auth service that handles OAuth flows.

**Pros:**
- Rich feature set (MFA, social logins, user management)
- SDKs simplify integration
- Built-in session management

**Cons:**
- Additional dependency and cost
- Latency for auth checks
- May be overkill for this use case
- Vendor lock-in

---

## Recommended Approach: Option 1

Google OAuth via Cloudflare Access is the simplest path forward. Your existing code already extracts email from the Cloudflare Access JWT—this continues to work unchanged.

> [!IMPORTANT]
> **No code changes needed for the auth flow itself.** The transition is entirely configuration.

---

## Implementation Plan

### Phase 1: Google OAuth Setup (Cloudflare Access)

#### Step 1.1: Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Navigate to **APIs & Services** → **Credentials**
4. Configure OAuth consent screen:
   - User Type: **External** (allows any Google account)
   - App name: `TL;DL`
   - User support email: your email
   - Scopes: `email`, `profile` (default)
5. Create OAuth Client ID:
   - Type: **Web application**
   - Name: `TLDL Cloudflare Access`
   - Authorized JavaScript origins: `https://<team-name>.cloudflareaccess.com`
   - Authorized redirect URI: `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
6. Download/save Client ID and Client Secret

#### Step 1.2: Add Google to Cloudflare Access

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Settings** → **Authentication** → **Login methods**
3. Click **Add new** → **Google**
4. Enter Client ID and Client Secret from GCP
5. Save

#### Step 1.3: Update Access Policy

Current policy restricts to specific emails. Change to allow any authenticated user:

1. Go to **Access** → **Applications** → your TLDL app
2. Edit the policy
3. Change from:
   ```
   Include: Emails ending in @yourdomain.com
   ```
   To:
   ```
   Include: Everyone
   Require: Login Methods → Google
   ```

> [!NOTE]
> The "Everyone + Require Google" pattern allows any Google account holder to authenticate. If you want to restrict to specific Gmail accounts or domains later, you can adjust the policy.

---

### Phase 2: Policy Decisions

Before going live, decide on these questions:

#### 2.1: Who Can Submit Episodes?

| Option | Policy Configuration |
|--------|---------------------|
| Anyone with Google account | Include: Everyone + Require: Google |
| Only specific domains | Include: Emails ending in `@yourdomain.com` |
| Specific email allowlist | Include: Individual emails |
| Google + email OTP fallback | Multiple login methods, same policy |

**Recommendation:** Start with "Anyone with Google account" to reduce friction, then add restrictions if abuse occurs.

#### 2.2: Rate Limiting

Your current rate limiting (`10 submissions/hour/email`) continues to work. Consider whether this is sufficient for public access:

- Current: 10/hour per email
- Public access might need: Lower limits for new users, higher for established users

This is a code change if desired (not required for MVP).

#### 2.3: Abuse Prevention

With public access, consider:

| Concern | Mitigation |
|---------|------------|
| Bot signups | Google OAuth inherently prevents this |
| Spam submissions | Rate limiting (already in place) |
| Blocked podcasts | `BLOCKED_PODCASTS` array (already exists) |
| Bad actors | Add ban list by email (optional future feature) |

---

### Phase 3: Optional Code Enhancements

These changes are **not required** but improve the user experience:

#### 3.1: Remove Cloudflare Access Branding

Customize the login page (already documented in [auth-conditional-ui.md](file:///Users/rian/Documents/GitHub/tldl/docs/auth-conditional-ui.md#L187-215)):

- Upload TL;DL logo
- Set dark background color
- Add custom header text

#### 3.2: User Experience Improvements

Consider adding after initial rollout:

1. **Welcome message for new users** — Detect first-time submission, show onboarding
2. **User profile page enhancements** — Show submission history, account info
3. **Email notifications** — Let users know when their episode is ready

#### 3.3: User Ban List (Future)

If needed, add a `BANNED_EMAILS` constant similar to `BLOCKED_PODCASTS`:

```typescript
// In src/lib/constants.ts
export const BANNED_EMAILS: string[] = [
    // Add problematic users here
];
```

---

## Migration Checklist

### Preparation
- [ ] Create Google Cloud project
- [ ] Configure OAuth consent screen (External)
- [ ] Create OAuth credentials
- [ ] Note team domain from Cloudflare Zero Trust settings

### Configuration
- [ ] Add Google identity provider in Cloudflare Zero Trust
- [ ] Test Google login in staging/preview (if available)
- [ ] Update Access policy to include Google authentication
- [ ] Decide on "who can access" policy

### Testing
- [ ] Test login with personal Google account
- [ ] Test login with different Google account (not in current allowlist)
- [ ] Verify episode submission works post-login
- [ ] Verify rate limiting works correctly
- [ ] Verify admin functions still work
- [ ] Test logout flow (`/cdn-cgi/access/logout`)

### Rollout
- [ ] Remove invite-only restriction in Access policy
- [ ] Monitor for unusual activity
- [ ] Customize login page branding (optional)

---

## Rollback Plan

If issues occur after enabling public access:

1. Revert Access policy to email allowlist
2. No code rollback needed

---

## Security Considerations

### What Cloudflare Access Handles

- OAuth flow (authorization code exchange)
- Token validation and refresh
- Session cookie management
- JWT signing and verification

### What Your Code Handles

- Extracting email from trusted JWT (`getUserEmailFromJwt()`)
- Admin authorization (`isAdminUser()`)
- Rate limiting per email
- Episode ownership (`submittedBy` field)

### Trust Model

The JWT from Cloudflare Access is trustworthy because:
1. Cloudflare signs it with a key only they control
2. The JWT arrives via `Cf-Access-Jwt-Assertion` header, injected by Cloudflare's proxy
3. Your Worker can't be accessed without going through Cloudflare

> [!CAUTION]
> Never trust `Cf-Access-Jwt-Assertion` headers from requests that bypass Cloudflare's proxy. Your Worker is only accessible via Cloudflare, so this is already enforced.

---

## Alternative: Password-Based Auth

If you ever need password auth (not recommended for this use case):

**Approach:**
1. Store hashed passwords in KV (`user:{email}` → `{email, passwordHash, createdAt}`)
2. Use `bcryptjs` or similar for hashing
3. Generate session tokens, store in KV with TTL
4. Set secure HTTP-only cookies

**Why Not for TLDL:**
- Adds significant complexity
- Password reset flows, security questions, etc.
- Users prefer OAuth (no new password to remember)
- You'd need to handle credential stuffing attacks

---

## FAQs

### Q: Will existing episodes still work?
**A:** Yes. Episodes store `submittedBy` email. The profile page already filters by email. Nothing changes.

### Q: What if a user signs in with a different Google account?
**A:** They'll see only episodes submitted by that account. This is expected behavior.

### Q: Can I keep email OTP as a fallback?
**A:** Yes. In Cloudflare Access, you can enable multiple login methods. Users choose at login time.

### Q: What about Google Workspace accounts?
**A:** Work exactly the same. Google OAuth doesn't distinguish between gmail.com and workspace accounts.

### Q: Do I need to verify my app with Google?
**A:** For <100 users, you can stay in "Testing" mode. For public access, submit for verification to remove the "unverified app" warning. This is a Google requirement, not Cloudflare.

---

## Summary

| Aspect | Decision |
|--------|----------|
| Auth method | Google OAuth via Cloudflare Access |
| Code changes | None (configuration only) |
| Password storage | Not needed |
| Estimated effort | 1-2 hours |
| Risk | Low (easy rollback) |

The simplest path from invite-only to public access is adding Google as an identity provider in Cloudflare Access. Your existing code continues to work unchanged.
