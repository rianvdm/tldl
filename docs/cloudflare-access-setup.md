# Cloudflare Access Setup Guide

This guide walks you through setting up Cloudflare Access to protect TLDL's authenticated routes.

**Last updated**: December 2024

---

## Overview

Cloudflare Access provides authentication for your Worker without requiring you to build a login system. It uses **Email One-Time PIN (OTP)** — users enter their email, receive a code, and are authenticated.

### What Gets Protected

| Route | Protected | Description |
|-------|-----------|-------------|
| `GET /` | ❌ No | Public home page |
| `GET /episode/:id` | ❌ No | Public episode view |
| `GET /episode/:id/pdf` | ❌ No | Public PDF download |
| `GET /submit` | ✅ Yes | Submit form |
| `POST /submit` | ✅ Yes | Submit episode |
| `GET /job/:id` | ✅ Yes | Job status page |
| `POST /job/:id/retry` | ✅ Yes | Retry failed job |
| `POST /episode/:id/regenerate` | ✅ Yes | Regenerate summary |
| `DELETE /episode/:id` | ✅ Yes | Delete episode |

---

## Prerequisites

- Cloudflare account with your Worker deployed
- Your Worker URL (e.g., `tldl.<your-subdomain>.workers.dev`)

---

## Step 1: Enable Cloudflare Access on Your Worker

The simplest way to enable Access (as of December 2024):

1. Go to **Cloudflare Dashboard** → **Workers & Pages**
2. Select your **tldl** Worker
3. Go to **Settings** → **Domains & Routes**
4. Find your `workers.dev` URL
5. Click **Enable Cloudflare Access**

This creates a default Access policy that protects your entire Worker.

---

## Step 2: Configure the Access Application

Now you need to configure which paths require authentication:

1. After enabling Access, click **Manage Cloudflare Access**
   - Or go to **Cloudflare One** → **Access** → **Applications**
2. Find your TLDL application and click **Configure**

### Application Settings

| Setting | Value |
|---------|-------|
| **Application name** | TLDL |
| **Session Duration** | 24 hours (or your preference) |
| **Application domain** | `tldl.<your-subdomain>.workers.dev` |

### Path Configuration

You need to protect only specific paths. In the application settings:

1. Click **Add public hostname** or edit the existing one
2. Set the **Path** to protect specific routes

**You MUST protect only specific paths:**

Create Access applications for these paths:
- Path: `/submit` — Protected
- Path: `/submit*` — Protected (catches POST too)
- Path: `/job/*` — Protected  
- Path: `/episode/*/regenerate` — Protected
- Path: `/episode/*/delete` — Protected

> ⚠️ **Important**: Do NOT protect the entire Worker! Cloudflare Access intercepts requests *before* they reach your code, so protecting everything would show the login page even for public routes like the home page.

---

## Step 3: Configure the Access Policy

The policy determines **who can log in**.

1. In your Access Application, go to the **Policies** tab
2. Click **Add a policy** or edit the default policy

### Policy Settings

| Setting | Value |
|---------|-------|
| **Policy name** | TLDL Users |
| **Action** | Allow |

### Include Rules

Add rules for who can access:

**Option A: Specific email addresses**
| Rule type | Selector | Value |
|-----------|----------|-------|
| Include | Emails | `you@example.com` |
| Include | Emails | `friend@example.com` |

**Option B: Email domain (for teams)**
| Rule type | Selector | Value |
|-----------|----------|-------|
| Include | Emails ending in | `@yourcompany.com` |

**Option C: Everyone (not recommended for production)**
| Rule type | Selector | Value |
|-----------|----------|-------|
| Include | Everyone | — |

3. Click **Save policy**

---

## Step 4: Configure Login Methods

1. In **Cloudflare One** → **Settings** → **Authentication**
2. Under **Login methods**, ensure **One-time PIN** is enabled

This allows users to log in with just their email address — they'll receive a 6-digit code.

If you want to add other identity providers (Google, GitHub, etc.), you can add them here.

---

## Step 5: Test the Setup

1. Open an **incognito/private browser window**
2. Visit your Worker URL: `https://tldl.<your-subdomain>.workers.dev/submit`
3. You should see the Cloudflare Access login page
4. Enter an allowed email address
5. Check your email for the one-time PIN
6. Enter the PIN
7. You should be redirected to the submit form

### Verify Public Routes Still Work

1. In the same incognito window, visit: `https://tldl.<your-subdomain>.workers.dev/`
2. The home page should load without requiring login

---

## Step 6: Logout

Users can log out by visiting:
```
https://tldl.<your-subdomain>.workers.dev/cdn-cgi/access/logout
```

You may want to add a logout link to your UI (optional enhancement).

---

## Troubleshooting

### "Unauthorized" error on all routes

- **Cause**: Access is protecting routes but no valid JWT is present
- **Fix**: Make sure you've logged in through the Access login page

### Can't receive OTP email

- Check spam folder
- Verify the email is in the allowed list in your Access policy
- Try a different email provider

### Public routes require login

- This shouldn't happen with the current code — public routes don't check for JWT
- If it does, verify your Access application path configuration

### "Debug routes are disabled in production"

- This is expected! Debug routes that call OpenAI are blocked in production
- Use `wrangler dev` locally for debugging

---

## Advanced: Custom Domain

If you want to use a custom domain (e.g., `tldl.yourdomain.com`):

1. In **Workers & Pages** → your Worker → **Settings** → **Domains & Routes**
2. Click **Add** → **Custom domain**
3. Enter your domain (must be on Cloudflare DNS)
4. Update your Access application to include the new domain

---

## Security Checklist

- [ ] Access enabled on Worker
- [ ] Policy configured with allowed emails
- [ ] One-time PIN login method enabled
- [ ] Tested login flow in incognito window
- [ ] Verified public routes work without login
- [ ] Verified protected routes require login

---

## Reference Links

- [Cloudflare Access Documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/)
- [One-time PIN Login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Workers Access Documentation](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#cloudflare-access)
- [Access Policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
