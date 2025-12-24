# Auth-Conditional UI with Cloudflare Access

This document explains how to configure Cloudflare Access so the app can detect logged-in users on public pages (e.g., to show/hide the "Submit Episode" button on the home page).

## The Problem

By default, Cloudflare Access only processes requests to paths explicitly protected by an Access Application. Public pages don't receive the `Cf-Access-Jwt-Assertion` header, so the app can't detect if a user is logged in.

## Solution: Protect Entire Domain with Bypass Policies

Configure Access to cover the entire site but use **Bypass** policies for public paths. This sends identity headers to all pages while still allowing public access.

## Configuration Steps

### Step 1: Create New Access Application for Public Paths

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** → **Applications**
3. Click **Add an application** → **Self-hosted**

Configure:
- **Application name**: `TLDL Public (with identity)`
- **Session Duration**: 24 hours (or match existing)
- **Application domain**: `tldl-pod.com`
- **Path**: Leave empty (covers entire domain)

### Step 2: Configure Policies (Order Matters!)

Cloudflare evaluates policies in order. Create these policies in this exact order:

#### Policy 1: Allow Authenticated Users (for protected paths)
- **Policy name**: `Allow Authenticated`
- **Action**: Allow
- **Include**: Emails ending in your allowed domains OR specific emails
- **Add a rule for path**: `/profile/*`

#### Policy 2: Bypass for Public Paths
- **Policy name**: `Public Access`
- **Action**: Bypass  
- **Include**: Everyone
- **Add rules for paths**:
  - `/` (home page)
  - `/episode/*`
  - `/about`
  - `/feed`
  - `/feed/*`
  - `/api/*`
  - `/styles.css`
  - `/favicon.svg`
  - `/apple-podcasts-badge.svg`

> **Note**: The Bypass action still allows the request through Access, which means if the user has a valid session cookie, the JWT header will be included.

### Step 3: Update Existing Application (Optional)

If you have an existing Access Application for `/profile/*`, you can either:
- **Keep it**: The more specific path will take precedence
- **Delete it**: The new application handles everything

### Step 4: Verify the Configuration

1. **Logged out**: Visit `tldl-pod.com/` — page should load, no `Cf-Access-Jwt-Assertion` header
2. **Log in**: Visit `tldl-pod.com/profile` — authenticate via Access
3. **Return to home**: Visit `tldl-pod.com/` — check if `Cf-Access-Jwt-Assertion` header is now present

## Latency Impact

**Expected overhead: ~5-15ms per request**

- Cloudflare Access adds minimal latency because it runs on Cloudflare's edge network (same data centers as Workers)
- Bypass policies are evaluated at the edge with no round-trip to an identity provider
- For users with valid sessions, Access simply validates the existing cookie—no IdP call needed
- Your Workers are already on Cloudflare's edge, so there's no additional network hop

In practice, this is imperceptible for page loads. Cloudflare claims Access is 38% faster than competing Zero Trust solutions.

## Important Considerations

1. **Caching**: Bypass pages with identity may have different cache behavior. Test that static assets still cache correctly.

2. **Cookie Scope**: The `CF_Authorization` cookie must be scoped to the entire domain, not just `/profile`. This should be automatic with the new configuration.

3. **Rollback**: If issues occur, delete the new application. The site will work as before (no identity on public pages).

## Code Changes Required

Once Access is configured, you'll need these code changes to conditionally show UI elements.

### 1. Update the Layout Component

Modify `src/routes/public.ts` to accept an `isLoggedIn` prop:

```typescript
// Updated Layout function signature
export function Layout(props: { 
    title: string; 
    children: string; 
    headExtra?: string; 
    description?: string;
    isLoggedIn?: boolean;  // NEW
}) {
```

Then update the nav section (around line 185-192):

```typescript
<nav class="nav">
    <a href="/" class="nav-brand">TL;D<span class="text-accent">L</span></a>
    <span class="nav-tagline">Too Long Didn't Listen</span>
    <a href="/about" class="nav-link">About</a>
    ${props.isLoggedIn 
        ? '<a href="/profile" class="nav-link">Profile</a>'
        : '<a href="/profile" class="nav-link">Log in</a>'}
</nav>
```

### 2. Update Each Route to Pass Auth State

Every route that uses `Layout` needs to detect auth and pass it:

```typescript
// Example: Home page route (GET /)
publicRoutes.get("/", async (c) => {
    const userEmail = getUserEmail(c);  // Already exists in public.ts
    const isLoggedIn = !!userEmail;
    
    // ... existing code ...
    
    // Update the Submit button in the content
    const submitButton = isLoggedIn 
        ? `<a href="/submit" class="button button-primary">
               <svg>...</svg>
               Submit Episode
           </a>`
        : '';  // Hidden when logged out
    
    // In the HTML, use ${submitButton} instead of hardcoded button
    
    // Pass to Layout
    return c.html(Layout({
        title: "Home",
        children: content,
        headExtra: refreshMeta,
        isLoggedIn,  // NEW
    }));
});
```

### 3. Files to Update

| File | Changes |
|------|---------|
| `src/routes/public.ts` | Update `Layout()` signature, update nav, update all `Layout()` calls |
| All routes using Layout | Pass `isLoggedIn` prop (home, episode, submit, about, job status) |

### 4. Specific Changes Summary

**In `Layout` function:**
```diff
- <a href="/profile" class="nav-link">Profile</a>
+ ${props.isLoggedIn 
+     ? '<a href="/profile" class="nav-link">Profile</a>'
+     : '<a href="/profile" class="nav-link">Log in</a>'}
```

**In home page (`GET /`):**
```diff
+ const userEmail = getUserEmail(c);
+ const isLoggedIn = !!userEmail;

  // In the content template, wrap the submit button:
- <a href="/submit" class="button button-primary">Submit Episode</a>
+ ${isLoggedIn ? `<a href="/submit" class="button button-primary">Submit Episode</a>` : ''}
```

**In every `Layout()` call:**
```diff
  return c.html(Layout({
      title: "...",
      children: content,
+     isLoggedIn,
  }));
```

---

## Customizing the Access Login Page

Yes! You can brand the Cloudflare Access login page with your logo and colors.

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

Changes appear in real-time in the preview panel.
