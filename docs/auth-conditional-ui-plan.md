# Auth-Conditional UI Implementation Plan

## Problem

Cloudflare Access doesn't send the `Cf-Access-Jwt-Assertion` header on public pages, and the `CF_Authorization` cookie persists after logout (14+ days). There's no reliable server-side way to detect auth state on public pages.

This means on the home page and other public pages, we can't tell if a user is logged in or not using server-side code alone.

## Solution: Client-Side Auth Probe

Use JavaScript to probe a protected endpoint on page load. This is the cleanest approach that reliably detects actual session validity.

### How It Works

1. **Default to logged-out UI** - Show "Log in" in nav and disabled Submit button
2. **Probe `/profile/auth-check`** - Small fetch request on page load
3. **Upgrade UI if authenticated** - Switch to "Profile" and enable Submit button
4. **Graceful degradation** - Works without JS (shows logged-out state)

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default state | Logged-out | Avoids showing "Profile" to logged-out users; no false positives |
| Flash minimization | Early fetch + localStorage cache | Returning users get instant UI; first-time users have minimal delay |
| After logout | Skip auth check + clear cache | Prevents unnecessary request; shows correct state immediately |
| No JavaScript | Show logged-out state | Safe fallback; protected routes still work via Cloudflare Access redirects |

### Flash Minimization Strategy

Two techniques combined for best UX:

1. **Early fetch (in `<head>`)**: Start the auth check request immediately, in parallel with HTML parsing. By the time the body renders, the fetch is likely complete or nearly complete.

2. **localStorage cache**: Cache auth state locally. Returning logged-in users see "Profile" instantly on page load. The fetch still runs in the background to validate, but the UI shows immediately from cache.

```
First visit (logged in):
[HTML + fetch in parallel] → [Body renders with "Log in"] → [Fetch completes ~50ms] → [Update to "Profile"]
                                                            ^^^^^^^^^^^^^^^^^^^^^^^^
                                                            Minimal flash

Returning visit (logged in):
[HTML loads] → [Cache hit: show "Profile" instantly] → [Fetch validates in background]
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
               Zero flash
```

---

## Implementation Details

### Step 1: Add Auth Check Endpoint

**File**: `src/routes/authenticated.ts`

Add a lightweight endpoint that returns auth state:

```typescript
// GET /profile/auth-check - Quick auth probe for client-side detection
authenticated.get("/profile/auth-check", async (c) => {
    const authError = await requireAuth(c);
    if (authError) return authError;

    return c.json({
        authenticated: true,
        email: c.get("userEmail") || null
    });
});
```

This endpoint is automatically protected by Cloudflare Access (under `/profile/*`). When:
- **Logged in**: Returns `{ authenticated: true, email: "user@example.com" }`
- **Logged out**: Cloudflare Access redirects to login (fetch sees non-200 response)

### Step 2: Add CSS Utility Classes

**File**: `src/lib/styles.ts`

```css
/* Auth-conditional UI utilities */
.hidden {
    display: none !important;
}

.auth-disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
}
```

### Step 3: Update Navigation in Layout

**File**: `src/routes/public.ts` (Layout component, ~line 191)

Change the Profile link to default to "Log in":

```html
<!-- Before -->
<a href="/profile" class="nav-link">Profile</a>

<!-- After -->
<a href="/profile" class="nav-link" id="nav-auth-link">Log in</a>
```

### Step 4: Update Submit Button on Home Page

**File**: `src/routes/public.ts` (~lines 413-418)

Replace the single Submit button with two versions:

```html
<!-- Logged-out state (default) - disabled button with tooltip -->
<span class="auth-logged-out" title="Submissions are invite-only for now">
    <span class="button button-primary auth-disabled">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
        </svg>
        Submit Episode
    </span>
</span>
<!-- Logged-in state (hidden by default) -->
<a href="/submit" class="button button-primary auth-logged-in hidden">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>
    </svg>
    Submit Episode
</a>
```

### Step 5: Add Auth Check Scripts to Layout

**File**: `src/routes/public.ts` (Layout component)

Two scripts: one in `<head>` to start early, one before `</body>` to update DOM.

#### Part A: Early fetch in `<head>`

```javascript
<script>
(function() {
    var CACHE_KEY = 'tldl-auth';
    var loggedOut = new URLSearchParams(location.search).get('loggedOut') === '1';

    // Clear cache and skip fetch if just logged out
    if (loggedOut) {
        localStorage.removeItem(CACHE_KEY);
        window.__authCheck = Promise.resolve(false);
        return;
    }

    // Start fetch early (runs in parallel with HTML parsing)
    window.__authCheck = fetch('/profile/auth-check', { credentials: 'include' })
        .then(function(r) {
            if (r.ok) {
                localStorage.setItem(CACHE_KEY, '1');
                return true;
            }
            localStorage.removeItem(CACHE_KEY);
            return false;
        })
        .catch(function() {
            localStorage.removeItem(CACHE_KEY);
            return false;
        });

    // Check cache for instant UI (will be applied in body script)
    window.__authCached = localStorage.getItem(CACHE_KEY) === '1';
})();
</script>
```

#### Part B: DOM update before `</body>`

```javascript
<script>
(function() {
    function showLoggedIn() {
        var nav = document.getElementById('nav-auth-link');
        if (nav) nav.textContent = 'Profile';
        document.querySelectorAll('.auth-logged-out').forEach(function(el) {
            el.classList.add('hidden');
        });
        document.querySelectorAll('.auth-logged-in').forEach(function(el) {
            el.classList.remove('hidden');
        });
    }

    // If cached as logged in, show immediately (zero flash for returning users)
    if (window.__authCached) {
        showLoggedIn();
    }

    // Then validate with actual fetch result (updates if cache was wrong)
    if (window.__authCheck) {
        window.__authCheck.then(function(isLoggedIn) {
            if (isLoggedIn && !window.__authCached) {
                // Fetch confirmed login, but wasn't cached - update now
                showLoggedIn();
            } else if (!isLoggedIn && window.__authCached) {
                // Cache was wrong (session expired) - reload to show logged-out state
                location.reload();
            }
        });
    }
})();
</script>
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/routes/authenticated.ts` | Add `/profile/auth-check` endpoint |
| `src/lib/styles.ts` | Add `.hidden` and `.auth-disabled` CSS classes |
| `src/routes/public.ts` | Update Layout nav, Submit button, add auth script |
| `docs/auth-conditional-ui.md` | Update status and document implementation |

---

## User Experience

### Logged-Out User
1. Page loads with "Log in" in nav and disabled Submit button
2. Auth check runs in background, fails (as expected)
3. UI stays the same - no flash, correct state shown immediately

### Logged-In User (First Visit)
1. Page loads, fetch starts in `<head>` (parallel with HTML)
2. Body renders with "Log in" (default state)
3. Fetch completes quickly (~50ms since it started early)
4. UI updates to "Profile" - minimal flash
5. localStorage cache is set for future visits

### Logged-In User (Returning)
1. Page loads, localStorage cache is checked in `<head>`
2. Body renders, cache hit detected → "Profile" shown instantly
3. Fetch validates in background (no UI change needed)
4. **Zero flash** for returning users

### After Logout
1. User clicks logout, redirected to `/?loggedOut=1`
2. localStorage cache is cleared
3. Auth check is skipped
4. UI shows logged-out state immediately - no flash

### Session Expired (Edge Case)
1. User returns with stale localStorage cache
2. "Profile" shown instantly (from cache)
3. Fetch runs, returns not-authenticated
4. Page reloads to show correct logged-out state

### JavaScript Disabled
1. Page shows logged-out state (default)
2. Clicking "Log in" or disabled Submit still works - Cloudflare Access handles redirect to login
3. After login, protected pages work normally

---

## Testing Checklist

- [ ] Logged-out user sees "Log in" and disabled Submit button
- [ ] Logged-in user (first visit) sees "Profile" after minimal delay
- [ ] Logged-in user (returning) sees "Profile" instantly (from cache)
- [ ] After logout (with `?loggedOut=1`), user sees logged-out state immediately
- [ ] After logout, localStorage cache is cleared
- [ ] Session expired: page reloads to show logged-out state
- [ ] JavaScript disabled: user sees logged-out state (graceful degradation)
- [ ] Network timeout/error: user sees logged-out state
- [ ] Mobile: responsive behavior works correctly

---

## Why This Approach?

### Alternatives Considered

| Approach | Why Not |
|----------|---------|
| Cookie-based detection | `CF_Authorization` cookie persists after logout - unreliable |
| Server-side detection on public pages | JWT header not sent on bypassed paths |
| Service worker | Overkill, complex cache invalidation |
| Default to logged-in | Would show "Profile" to logged-out users until check completes |

### Benefits of This Approach

1. **Reliable** - Actually validates session via protected endpoint
2. **Clean** - No weird hacks or workarounds
3. **Maintainable** - Simple code, easy to understand
4. **Graceful degradation** - Works without JavaScript
5. **No false positives** - Never shows "Profile" to logged-out users
6. **Works with Cloudflare Access** - No configuration changes needed
7. **Minimal flash** - Early fetch + localStorage cache means returning users see instant correct UI
