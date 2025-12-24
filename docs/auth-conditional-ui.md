# Auth-Conditional UI with Cloudflare Access

This document explains the goal of detecting logged-in users on public pages (e.g., to show/hide the "Submit Episode" button), what we tried, what we learned, and recommendations for the future.

## Status: Not Implemented

After testing, we discovered fundamental limitations with Cloudflare Access that make reliable client-facing auth detection difficult. The implementation was reverted.

## The Goal

- Show "Log in" instead of "Profile" in the nav for logged-out users
- Show a disabled/greyed-out Submit button with tooltip "Submissions are invite-only for now" for logged-out users
- Show an active Submit button for logged-in users

## What We Tried

### Approach 1: Bypass Policies with JWT Header Detection

**Theory**: Configure a Cloudflare Access Application with Bypass policies for public pages. The idea was that even on bypassed pages, if the user has a valid session cookie, Access would send the `Cf-Access-Jwt-Assertion` header.

**Result**: ❌ **Did not work**. Testing confirmed that Cloudflare does NOT send the `Cf-Access-Jwt-Assertion` header on bypassed pages.

### Approach 2: Cookie-Based Auth Detection

**Theory**: Since the `CF_Authorization` cookie is always sent (and contains a full JWT), decode the JWT directly from the cookie to detect logged-in users.

**Implementation**:
```typescript
function getUserEmail(c: Context): string | undefined {
    // First try the header (set by Access on protected paths)
    const cfAccessJwt = c.req.header("Cf-Access-Jwt-Assertion");
    if (cfAccessJwt) {
        const email = getUserEmailFromJwt(cfAccessJwt);
        if (email) return email;
    }
    
    // Fall back to cookie (available on all pages if user has logged in)
    const cookie = c.req.header("Cookie") ?? "";
    const cfAuthMatch = cookie.match(/CF_Authorization=([^;]+)/);
    if (cfAuthMatch) {
        const email = getUserEmailFromJwt(cfAuthMatch[1]);
        if (email) return email;
    }
    
    return undefined;
}
```

**Result**: ⚠️ **Partially worked**, but with critical limitations:

1. **Cookie persists after logout**: When a user logs out via Cloudflare's logout URL, the session is invalidated on Cloudflare's backend, but the browser cookie remains. The JWT inside the cookie has a long expiration (14+ days), so our code thinks the user is still logged in.

2. **Workaround for logout redirect**: We added logic to force `isLoggedIn = false` when `?loggedOut=1` is in the URL. This worked for the immediate redirect, but...

3. **Subsequent page loads show wrong state**: If the user reloads the page or navigates to a different page, the cookie is still present and they appear logged in, even though clicking "Profile" correctly redirects them to the login page.

4. **Submit page worked after logout**: The `/submit` route (which is protected by Access) was still accessible after logout, suggesting the cookie-based session was still valid even though the Cloudflare logout had been performed.

## Key Findings

### Cloudflare Access Cookie Behavior

| Scenario | `Cf-Access-Jwt-Assertion` Header | `CF_Authorization` Cookie |
|----------|----------------------------------|---------------------------|
| Protected path, logged in | ✅ Present | ✅ Present |
| Protected path, logged out | ❌ Absent (redirects to login) | ❌ Usually absent |
| Bypassed path, logged in | ❌ Absent | ✅ Present |
| Bypassed path, logged out | ❌ Absent | ⚠️ May persist after logout |

### The Core Problem

There's no reliable way to detect logout on public pages because:
1. The JWT header is only sent on protected paths
2. The cookie can persist after Cloudflare invalidates the session
3. We can't validate the session without calling a protected endpoint

## Recommendations for Future Implementation

### Option A: Client-Side Session Validation (Recommended)

Add JavaScript that pings a protected endpoint on page load to verify the session:

```javascript
// On every page load
fetch('/api/auth-check', { credentials: 'include' })
    .then(res => {
        if (res.ok) {
            // Session is valid - show logged-in UI
            document.querySelector('.nav-profile-link').textContent = 'Profile';
            document.querySelector('.submit-btn').classList.remove('disabled');
        } else {
            // Session invalid or expired - show logged-out UI
            document.querySelector('.nav-profile-link').textContent = 'Log in';
            document.querySelector('.submit-btn').classList.add('disabled');
        }
    });
```

**Pros**: Reliable, always reflects true auth state
**Cons**: Requires JavaScript, brief flash of incorrect state before fetch completes

### Option B: Accept the Limitation

Keep the current behavior where the nav always shows "Profile" and the Submit button is always visible. Protected routes correctly redirect to login when needed.

**Pros**: No additional complexity
**Cons**: UI doesn't reflect auth state

### Option C: Shorter Session Duration

Configure Cloudflare Access with a shorter session duration (e.g., 1 hour instead of 24 hours). This reduces the window where the cookie outlasts the session.

**Pros**: Reduces inconsistency window
**Cons**: Users have to log in more frequently

## Current Protected Paths

These paths are protected by Cloudflare Access:
- `/profile`
- `/job/*/retry`
- `/episode/*/regenerate`
- `/submit*`
- `/episode/*/delete`

## Customizing the Access Login Page

You can brand the Cloudflare Access login page with your logo and colors.

### Steps to Customize

1. Go to [Cloudflare One Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Settings** → **Custom Pages** (under "Reusable components")
3. Find **Access login page** and click **Manage**

### Available Customizations

| Element | Description |
|---------|-------------|
| **Organization name** | Displayed at the top of the login page |
| **Logo** | Upload your logo (PNG/SVG recommended) |
| **Background color** | Set a custom background color |
| **Header text** | Custom message above the login form |
| **Footer text** | Custom message below the login form |

### Example Configuration for TLDL

- **Organization name**: `TL;DL`
- **Logo**: Upload `tldl-hero.png` or similar
- **Background color**: `#0a0a0a` (matches your dark theme)
- **Header**: `Sign in to submit podcast episodes`
- **Footer**: `Only approved users can submit episodes`
