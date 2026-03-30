# Audio URL Override — Admin Submit Form

## Problem

Podcast CDNs (notably Substack) rate-limit the Worker's egress IP after repeated fetch attempts. Once rate-limited, the Worker can't fetch the audio OR resolve the redirect to the final CDN URL. The audio is available on the final CDN (e.g. CloudFront), but the Worker has no way to obtain the signed URL.

## Solution

Add an optional "Audio URL" field to the admin submit form. When provided, the queue consumer uses this URL directly for transcription, bypassing the origin entirely.

## Data Flow

1. Admin pastes a direct CDN URL into the optional field on the submit form
2. The URL is included in the `QueueMessage` as `audioUrlOverride`
3. The consumer passes `audioUrlOverride` (if present) instead of `metadata.audioUrl` to `transcribeAudio`
4. `transcribeAudio` skips HEAD validation and redirect resolution for override URLs — goes straight to fetching

## Changes

### `src/types/index.ts` — QueueMessage

Add `audioUrlOverride?: string` to the interface.

### `src/lib/queue.ts` — createProcessEpisodeMessage

Pass through `audioUrlOverride` if provided.

### `src/routes/admin.ts` — Submit handler

Read the `audioUrl` field from the form body. Pass to `createProcessEpisodeMessage`.

### `src/routes/admin.ts` — Submit form HTML

Add an optional text input for "Audio URL (override)" below the existing form fields. Collapsed or subtle — not prominent since it's rarely needed.

### `src/queue/consumer.ts` — processEpisode

When `message.body.audioUrlOverride` is present, pass it to `transcribeAudio` instead of `metadata.audioUrl`. Log that an override is being used.

### `src/services/transcription.ts` — transcribeAudio

Accept a `skipValidation: true` option (passed by the consumer when an override URL is used). When set:
- Skip `validateAudioUrl` HEAD request
- Skip `resolveAudioUrl` redirect resolution
- Go directly to fetch (content-length unknown, so fetch first and determine chunking from actual size)

This is the same path that the existing `validation_rate_limited_fallback` takes, so no new logic needed — just enter that path intentionally.

## What Stays the Same

- All existing retry logic, backoff, and fallback paths
- Non-admin submissions (public submit has no override field)
- The redirect resolution and validation fallback added earlier today
- Episode metadata fetching (podcast name, title, duration — still from iTunes/Podcast Index/RSS)

## Usage

When a job fails with persistent CDN rate limiting:

1. Get the CDN URL: `curl -sI -o /dev/null -w "%{redirect_url}" "<audio-url>"`
2. Re-submit the episode on the admin form, pasting the CDN URL into the override field
3. The job processes using the CDN URL directly, bypassing the rate-limited origin

## Scope

This is a targeted escape hatch — ~30 lines of code across 5 files. No new endpoints, no new pages, no database changes.
