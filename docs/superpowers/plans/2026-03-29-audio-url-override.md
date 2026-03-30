# Audio URL Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional audio URL override field to the admin submit form so episodes can be processed even when the origin CDN is rate-limiting the Worker.

**Architecture:** Thread an `audioUrlOverride` string from the admin form → queue message → consumer → `transcribeAudio`. When present, skip HEAD validation and redirect resolution, fetch the audio directly.

**Tech Stack:** Hono (routes), Cloudflare Workers (queue), TypeScript

---

### Task 1: Add `audioUrlOverride` to queue message creation

**Files:**
- Modify: `src/lib/queue.ts:21-42`

The `QueueMessage` type already has `audioUrlOverride?: string` (added during this session). We just need `createProcessEpisodeMessage` to pass it through.

- [ ] **Step 1: Update `createProcessEpisodeMessage` to accept and pass through `audioUrlOverride`**

In `src/lib/queue.ts`, update the function params and return object:

```typescript
export function createProcessEpisodeMessage(params: {
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    submittedBy?: string;
    audioUrlOverride?: string;
}): QueueMessage {
    return {
        type: "process_episode",
        jobId: params.jobId,
        episodeId: params.episodeId,
        appleUrl: params.appleUrl,
        templateId: params.templateId,
        ...(params.episodeGuid && { episodeGuid: params.episodeGuid }),
        ...(params.expectedTitle && { expectedTitle: params.expectedTitle }),
        ...(params.expectedDate && { expectedDate: params.expectedDate }),
        ...(params.submittedBy && { submittedBy: params.submittedBy }),
        ...(params.audioUrlOverride && { audioUrlOverride: params.audioUrlOverride }),
    };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers pass it yet, so no breakage)

- [ ] **Step 3: Commit**

```bash
git add src/lib/queue.ts
git commit -m "feat: thread audioUrlOverride through queue message creation"
```

---

### Task 2: Add override field to admin submit form and handler

**Files:**
- Modify: `src/routes/admin.ts:928-944` (form HTML)
- Modify: `src/routes/admin.ts:957-974` (POST handler body parsing)
- Modify: `src/routes/admin.ts:1050-1058` (message creation)

- [ ] **Step 1: Add the form field**

In `src/routes/admin.ts`, after the radio-group div (line ~941) and before the submit button (line ~943), add:

```html
            <details class="form-group" style="margin-top: 1rem;">
                <summary style="cursor: pointer; font-size: 0.9rem; color: #666;">Advanced options</summary>
                <div style="margin-top: 0.5rem;">
                    <label class="form-label" for="audioUrl">Audio URL (override)</label>
                    <input type="url" id="audioUrl" name="audioUrl" class="form-input"
                        placeholder="https://substackcdn.com/..." />
                    <p class="form-help">Optional. Direct CDN URL to bypass rate-limited origins. Get it with: curl -sI -o /dev/null -w "%{redirect_url}" "AUDIO_URL"</p>
                </div>
            </details>
```

- [ ] **Step 2: Parse the field in the POST handler**

In the POST handler, update both the JSON and form body parsing to read `audioUrl`. After the existing parsing block (lines ~962-974), the variables section should become:

```typescript
    let appleUrl: string;
    let templateId: string;
    let audioUrlOverride: string | undefined;

    if (contentType.includes("application/json")) {
        const body = await c.req.json<{ appleUrl: string; templateId: string; audioUrl?: string }>();
        appleUrl = body.appleUrl;
        templateId = body.templateId;
        audioUrlOverride = body.audioUrl || undefined;
    } else {
        const formData = await c.req.parseBody();
        appleUrl = formData.appleUrl as string;
        templateId = formData.templateId as string;
        audioUrlOverride = (formData.audioUrl as string) || undefined;
    }
```

- [ ] **Step 3: Pass it to the queue message**

In the `createProcessEpisodeMessage` call (line ~1050), add `audioUrlOverride`:

```typescript
    const message = createProcessEpisodeMessage({
        jobId,
        episodeId,
        appleUrl,
        templateId: effectiveTemplateId,
        episodeGuid: episodeInfo?.episodeGuid,
        expectedTitle: episodeInfo?.trackName,
        expectedDate: episodeInfo?.releaseDate,
        audioUrlOverride,
    });
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: add audio URL override field to admin submit form"
```

---

### Task 3: Thread override through consumer to transcribeAudio

**Files:**
- Modify: `src/queue/consumer.ts:73-84` (ProcessingContext interface)
- Modify: `src/queue/consumer.ts:220-229` (context creation)
- Modify: `src/queue/consumer.ts:381-384` (transcribeAudio call)
- Modify: `src/services/transcription.ts:600-607` (TranscribeOptions)
- Modify: `src/services/transcription.ts:650-688` (transcribeAudio validation/resolve logic)

- [ ] **Step 1: Add `audioUrlOverride` to `ProcessingContext`**

In `src/queue/consumer.ts`, add to the `ProcessingContext` interface (after line ~84):

```typescript
    // Override audio URL (bypasses origin rate limiting)
    audioUrlOverride?: string;
```

- [ ] **Step 2: Pass it when creating the context**

In `processMessage` (line ~220), add `audioUrlOverride` to the context:

```typescript
    const context: ProcessingContext = {
        env,
        jobId: msg.jobId,
        episodeId: msg.episodeId,
        appleUrl: msg.appleUrl,
        templateId: msg.templateId,
        episodeGuid: msg.episodeGuid,
        expectedTitle: msg.expectedTitle,
        expectedDate: msg.expectedDate,
        submittedBy: msg.submittedBy,
        audioUrlOverride: msg.audioUrlOverride,
    };
```

- [ ] **Step 3: Use the override in `processEpisode`**

In `processEpisode`, update the `transcribeAudio` call (line ~381) to use the override and pass `skipValidation`:

```typescript
        const audioUrl = ctx.audioUrlOverride || metadata.audioUrl;
        if (ctx.audioUrlOverride) {
            console.log(JSON.stringify({
                event: "using_audio_url_override",
                override: ctx.audioUrlOverride,
            }));
        }

        const transcriptionResult = await transcribeAudio(
            audioUrl,
            { apiKey: env.OPENAI_API_KEY, skipValidation: !!ctx.audioUrlOverride },
        );
```

- [ ] **Step 4: Add `skipValidation` to `TranscribeOptions`**

In `src/services/transcription.ts`, add to the `TranscribeOptions` interface:

```typescript
export interface TranscribeOptions {
    /** OpenAI API key */
    apiKey: string;
    /** Ignored — kept for backwards compatibility with old call sites */
    provider?: string;
    /** Optional callback for progress updates (chunk number, total chunks) */
    onProgress?: (currentChunk: number, totalChunks: number) => void;
    /** Skip HEAD validation and redirect resolution (for pre-resolved override URLs) */
    skipValidation?: boolean;
}
```

- [ ] **Step 5: Implement the skip logic in `transcribeAudio`**

In `transcribeAudio`, after `providerConfig` and `progressCallback` are set up and the `transcription_start` log, replace the existing Step 1 validation block and Step 1.5 redirect resolution with:

```typescript
    let validation: AudioValidation;

    if (opts.skipValidation) {
        // Override URL — skip HEAD validation and redirect resolution
        validation = { contentLength: 0, contentType: "audio/mpeg" };
    } else {
        // Step 1: Validate audio URL and check size (with retry for rate limits)
        // [keep existing validation + fallback logic unchanged]

        // Step 1.5: Resolve redirects to get final CDN URL
        audioUrl = await resolveAudioUrl(audioUrl);
    }
```

This means the full block becomes:

```typescript
    let validation: AudioValidation;

    if (opts.skipValidation) {
        // Override URL — skip HEAD validation and redirect resolution
        validation = { contentLength: 0, contentType: "audio/mpeg" };
    } else {
        // Step 1: Validate audio URL and check size (with retry for rate limits)
        try {
            validation = await withRetry(
                () => validateAudioUrl(audioUrl),
                { maxRetries: 3, baseDelayMs: 5000, shouldRetry: isRateLimitError },
            );
        } catch (error) {
            if (error instanceof AppError && isRateLimitError(error)) {
                const resolvedUrl = await resolveAudioUrl(audioUrl);
                if (resolvedUrl !== audioUrl) {
                    audioUrl = resolvedUrl;
                    try {
                        validation = await validateAudioUrl(audioUrl);
                    } catch {
                        console.log(
                            JSON.stringify({
                                event: "validation_rate_limited_fallback",
                                message: "Both origin and resolved URL rate-limited, falling back to direct fetch",
                            })
                        );
                        validation = { contentLength: 0, contentType: "audio/mpeg" };
                    }
                } else {
                    console.log(
                        JSON.stringify({
                            event: "validation_rate_limited_fallback",
                            message: "HEAD request rate-limited, falling back to direct fetch",
                        })
                    );
                    validation = { contentLength: 0, contentType: "audio/mpeg" };
                }
            } else {
                throw error;
            }
        }

        // Step 1.5: Resolve redirects to get final CDN URL
        audioUrl = await resolveAudioUrl(audioUrl);
    }
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: 318 passed (same as before — `skipValidation` defaults to `undefined`/falsy so existing tests are unaffected)

- [ ] **Step 8: Commit**

```bash
git add src/queue/consumer.ts src/services/transcription.ts
git commit -m "feat: skip validation and redirect resolution when audio URL override is provided"
```

---

### Task 4: Deploy and test

**Files:** None (deploy only)

- [ ] **Step 1: Deploy**

Run: `npx wrangler deploy --env=""`
Expected: Successful deploy with new version ID

- [ ] **Step 2: Test with the Lenny's Podcast episode**

1. Get the CDN URL from local machine:
```bash
curl -sI -o /dev/null -w "%{redirect_url}" "https://api.substack.com/feed/podcast/192012054/5a00347ccd52fb300cac2ea6e28874e8.mp3"
```

2. Go to the admin submit form
3. Paste the Apple Podcasts URL as usual
4. Expand "Advanced options" and paste the CloudFront CDN URL
5. Submit and verify in logs that `using_audio_url_override` event appears and the job proceeds to transcription without 429 errors

- [ ] **Step 3: Commit spec and plan docs**

```bash
git add docs/superpowers/
git commit -m "docs: add audio URL override design spec and implementation plan"
```
