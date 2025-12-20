# TLDL Implementation Prompts

This document contains a series of implementation prompts for a code-generation LLM, derived from the TLDL product specification. Each prompt builds iteratively on previous work—no orphaned code.

## Implementation Blueprint

The implementation follows this sequence:

1. **Foundation** — Project scaffolding, types, config
2. **Storage Layer** — KV helpers and data models
3. **External Integrations** — Apple/iTunes API, RSS parsing
4. **Core Services** — Transcription, summarization
5. **Routes** — Public, authenticated, API endpoints
6. **Queue Processing** — Background job handling
7. **UI** — Server-rendered templates
8. **Polish** — Error handling, security, PDF generation

---

## Prompt 1: Project Scaffolding and TypeScript Types

**Goal**: Initialize the Cloudflare Workers project with Hono, configure TypeScript, and define all core types from the spec. This establishes the foundation everything else builds on.

```markdown
Create a new Cloudflare Workers project for "tldl" using Hono framework.

## Project Setup

1. Initialize with `npm create cloudflare@latest ./tldl -- --template=hono`
2. Configure TypeScript strictly (strict: true, noImplicitAny: true)
3. Set compatibility_date to 2024-01-01

## File Structure to Create

```
tldl/
├── src/
│   ├── index.ts              # Hono app entry point (minimal)
│   ├── types/
│   │   └── index.ts          # All TypeScript types
│   └── lib/
│       └── constants.ts      # Templates, error codes
├── wrangler.toml
├── package.json
├── tsconfig.json
```

## Types to Define (src/types/index.ts)

### Job Record
```typescript
type JobStatus = "queued" | "fetching_metadata" | "checking_transcript" | 
                 "transcribing" | "summarizing" | "completed" | "failed";

interface Job {
  id: string;                    // UUID
  episodeId: string;             // Derived from Apple Podcasts URL
  appleUrl: string;              // Original submitted URL
  status: JobStatus;
  templateId: string;            // Template used for this job
  error?: string;                // Error message if failed
  estimatedSeconds?: number;     // Rough time estimate
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
}
```

### Episode Record
```typescript
type TranscriptSource = "apple" | "rss" | "openai";

interface Episode {
  id: string;
  appleUrl: string;
  podcastName: string;
  episodeTitle: string;
  episodeDuration: number;       // Seconds
  episodeDate: string;           // Original publish date
  audioUrl: string;
  transcriptSource: TranscriptSource;
  createdAt: string;
  expiresAt: string;             // createdAt + 365 days
}
```

### Transcript Record
```typescript
interface Transcript {
  episodeId: string;
  text: string;
  source: TranscriptSource;
  createdAt: string;
}
```

### Summary Record
```typescript
interface Summary {
  episodeId: string;
  templateId: string;
  text: string;                  // Generated summary (markdown)
  model: string;                 // e.g., "gpt-5.2"
  createdAt: string;
}
```

### App Environment Bindings
```typescript
interface Env {
  TLDL_DATA: KVNamespace;
  TLDL_QUEUE: Queue;
  OPENAI_API_KEY: string;
  MAX_EPISODE_MINUTES: string;
  CACHE_TTL_DAYS: string;
  DEFAULT_TEMPLATE: string;
}
```

## Constants (src/lib/constants.ts)

Define the three summary templates with their prompts:
- `key-takeaways` (default)
- `narrative-summary`  
- `eli5`

And error codes:
- INVALID_URL, EPISODE_NOT_FOUND, EPISODE_TOO_LONG, AUDIO_UNAVAILABLE
- TRANSCRIPTION_FAILED, SUMMARIZATION_FAILED, RATE_LIMITED, UNKNOWN_ERROR

## wrangler.toml Configuration

```toml
name = "tldl"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
MAX_EPISODE_MINUTES = "80"
CACHE_TTL_DAYS = "365"
DEFAULT_TEMPLATE = "key-takeaways"

[[kv_namespaces]]
binding = "TLDL_DATA"
id = "<placeholder>"

[[queues.producers]]
binding = "TLDL_QUEUE"
queue = "tldl-jobs"

[[queues.consumers]]
queue = "tldl-jobs"
max_batch_size = 1
max_batch_timeout = 30
max_retries = 2
```

## Entry Point (src/index.ts)

Create minimal Hono app that:
1. Exports the default fetch handler
2. Exports the queue consumer handler (placeholder)
3. Has a single GET / route that returns "TLDL - Coming Soon"

## Tests

Add a basic test file (test/types.test.ts) that validates the type definitions compile correctly by creating sample objects of each type.

Run `npm run dev` to verify the worker starts.
```

---

## Prompt 2: KV Storage Layer

**Goal**: Build the data access layer with helpers for all KV operations. This abstracts storage so routes and services never touch KV directly.

```markdown
Build the KV storage layer for TLDL. All code should use the types defined in Prompt 1.

## Create src/lib/kv.ts

### Key Generation Functions
```typescript
export const KV_KEYS = {
  job: (jobId: string) => `job:${jobId}`,
  episode: (episodeId: string) => `episode:${episodeId}`,
  transcript: (episodeId: string) => `transcript:${episodeId}`,
  summary: (episodeId: string, templateId: string) => `summary:${episodeId}:${templateId}`,
};
```

### TTL Constants
```typescript
export const TTL = {
  JOB: 7 * 24 * 60 * 60,        // 7 days
  CONTENT: 365 * 24 * 60 * 60,  // 365 days
};
```

### Storage Functions

Implement these async functions:

**Jobs:**
- `createJob(kv: KVNamespace, job: Job): Promise<void>`
- `getJob(kv: KVNamespace, jobId: string): Promise<Job | null>`
- `updateJobStatus(kv: KVNamespace, jobId: string, status: JobStatus, error?: string): Promise<void>`

**Episodes:**
- `saveEpisode(kv: KVNamespace, episode: Episode): Promise<void>`
- `getEpisode(kv: KVNamespace, episodeId: string): Promise<Episode | null>`
- `deleteEpisode(kv: KVNamespace, episodeId: string): Promise<void>` — deletes episode AND all related transcripts/summaries
- `listEpisodes(kv: KVNamespace): Promise<Episode[]>` — use KV list with prefix, sorted by createdAt desc

**Transcripts:**
- `saveTranscript(kv: KVNamespace, transcript: Transcript): Promise<void>`
- `getTranscript(kv: KVNamespace, episodeId: string): Promise<Transcript | null>`

**Summaries:**
- `saveSummary(kv: KVNamespace, summary: Summary): Promise<void>`
- `getSummary(kv: KVNamespace, episodeId: string, templateId: string): Promise<Summary | null>`
- `listSummariesForEpisode(kv: KVNamespace, episodeId: string): Promise<Summary[]>`

### Helper Considerations

1. All functions should handle JSON serialization/deserialization
2. Set appropriate TTL on put operations
3. `listEpisodes` should use KV list with `episode:` prefix, then batch-get the values
4. Add `updatedAt` timestamp when updating job status

## Tests (test/kv.test.ts)

Use Vitest with miniflare for KV mocking. Test:
1. Create and retrieve a job
2. Update job status
3. Full episode lifecycle (save, get, delete)
4. Listing episodes returns sorted results
5. Deleting episode cleans up related data

Run tests with `npm test`.
```

---

## Prompt 3: Apple Podcasts URL Parser and iTunes API Client

**Goal**: Parse Apple Podcasts URLs and fetch podcast/episode metadata via the iTunes API. This is the first external integration.

```markdown
Implement Apple Podcasts URL parsing and iTunes API integration.

## Create src/lib/url-parser.ts

### URL Pattern
Valid episode URLs match:
```
https://podcasts.apple.com/{country}/podcast/{podcast-slug}/id{podcast_id}?i={episode_id}
```

### Functions

```typescript
interface ParsedAppleUrl {
  podcastId: string;
  episodeId: string;
  country: string;
}

export function parseApplePodcastsUrl(url: string): ParsedAppleUrl | null
```

- Use regex to extract podcast_id from `/id{podcast_id}` 
- Extract episode_id from `?i={episode_id}` query param
- Return null for invalid URLs (don't throw)
- Handle edge cases: trailing slashes, extra query params, different countries

### Derive Episode ID for Storage
```typescript
export function deriveEpisodeId(podcastId: string, episodeId: string): string
```
Return a stable identifier: `${podcastId}_${episodeId}`

## Create src/services/apple-podcasts.ts

### Types
```typescript
interface ItunesLookupResult {
  feedUrl: string;
  collectionName: string;
  artistName: string;
}

interface EpisodeMetadata {
  podcastName: string;
  episodeTitle: string;
  episodeDuration: number;  // seconds
  episodeDate: string;      // ISO date
  audioUrl: string;
  feedUrl: string;
}
```

### Functions

```typescript
export async function lookupPodcast(podcastId: string): Promise<ItunesLookupResult | null>
```
- Call `https://itunes.apple.com/lookup?id={podcastId}&entity=podcast`
- Parse JSON response, extract first result
- Return null if no results
- Handle rate limiting (retry with backoff)

```typescript
export async function getEpisodeMetadata(
  parsedUrl: ParsedAppleUrl
): Promise<EpisodeMetadata>
```
- Call lookupPodcast to get feedUrl
- Throw AppError with `EPISODE_NOT_FOUND` if podcast not found
- (RSS parsing will be added in next prompt—for now just return the feedUrl)

## Create src/lib/errors.ts

```typescript
export class AppError extends Error {
  constructor(
    public code: string,
    public userMessage: string,
    public cause?: Error
  ) {
    super(userMessage);
    this.name = 'AppError';
  }
}
```

## Tests (test/url-parser.test.ts)

Test cases:
1. Valid US episode URL
2. Valid UK episode URL  
3. URL without episode ID (show URL) — should return null
4. Invalid URLs (Spotify, generic, malformed)
5. Edge cases: unicode, special chars in slug
6. iTunes API mock: successful lookup
7. iTunes API mock: podcast not found

## Integration

Update `src/index.ts` to add a debug route:
```typescript
app.get('/debug/parse', async (c) => {
  const url = c.req.query('url');
  const parsed = parseApplePodcastsUrl(url);
  return c.json({ parsed });
});
```
```

---

## Prompt 4: RSS Feed Parser

**Goal**: Fetch and parse RSS feeds to find episode metadata and check for existing transcripts. This completes the metadata flow.

```markdown
Implement RSS feed parsing to extract episode details and check for transcripts.

## Create src/services/rss.ts

### Dependencies
Add `fast-xml-parser` to package.json for XML parsing.

### Types
```typescript
interface RssEpisode {
  guid: string;
  title: string;
  pubDate: string;
  duration: number;          // seconds
  audioUrl: string;
  transcriptUrl?: string;    // From <podcast:transcript>
  transcriptType?: string;   // srt, vtt, json, etc.
}

interface ParsedFeed {
  title: string;
  episodes: RssEpisode[];
}
```

### Functions

```typescript
export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed>
```
- Fetch with 10-second timeout using AbortController
- Parse XML with fast-xml-parser
- Extract podcast title from `<channel><title>`
- Extract episodes from `<item>` elements:
  - `guid` from `<guid>`
  - `title` from `<title>`
  - `pubDate` from `<pubDate>` (parse to ISO)
  - `duration` from `<itunes:duration>` (handle HH:MM:SS and seconds formats)
  - `audioUrl` from `<enclosure url="...">`
  - `transcriptUrl` from `<podcast:transcript url="...">` if present
- Limit to first 100 episodes (no pagination needed)
- Throw AppError with `RSS_TIMEOUT` if fetch times out

```typescript
export function findEpisodeInFeed(
  feed: ParsedFeed, 
  appleEpisodeId: string
): RssEpisode | null
```
Match episode by:
1. `guid` contains appleEpisodeId
2. `guid` URL-decoded contains appleEpisodeId  
3. Return null if no match (caller handles fallback)

```typescript
export async function fetchTranscript(
  transcriptUrl: string, 
  transcriptType: string
): Promise<string | null>
```
- Fetch transcript file
- Parse based on type:
  - `srt` or `vtt`: Strip timecodes, return plain text
  - `json`: Extract text from JSON structure
  - `text/plain`: Return as-is
- Return null on any error (transcript is optional)

### Duration Parsing Helper
```typescript
function parseDuration(durationStr: string): number
```
Handle formats:
- `3600` → 3600
- `60:00` → 3600
- `1:00:00` → 3600

## Update src/services/apple-podcasts.ts

Complete `getEpisodeMetadata` to:
1. Look up podcast via iTunes API
2. Fetch and parse RSS feed
3. Find episode in feed
4. Return full EpisodeMetadata

Add duration validation:
```typescript
export function validateDuration(
  durationSeconds: number, 
  maxMinutes: number
): void
```
Throw AppError with `EPISODE_TOO_LONG` if exceeded.

## Tests (test/rss.test.ts)

1. Parse standard RSS feed with iTunes extensions
2. Parse feed with Podcasting 2.0 transcript tag
3. Handle missing duration gracefully
4. Duration parsing: all format variants
5. Episode matching: exact guid, partial match
6. Timeout handling
7. Malformed XML handling

Use fixture files in test/fixtures/ with sample RSS feeds.
```

---

## Prompt 5: OpenAI Whisper Transcription Service

**Goal**: Implement audio transcription using OpenAI's Whisper API, with support for chunking large files.

```markdown
Implement the transcription service using OpenAI Whisper API.

## Create src/services/transcription.ts

### Types
```typescript
interface TranscriptionResult {
  text: string;
  source: "openai";
}
```

### Main Function
```typescript
export async function transcribeAudio(
  audioUrl: string,
  openaiApiKey: string
): Promise<TranscriptionResult>
```

Implementation:
1. HEAD request to get Content-Length
2. If under 25MB, transcribe directly
3. If over 25MB, throw AppError with `AUDIO_TOO_LARGE` for now
   (Chunking will be a future enhancement—keep v1 simple)
4. Fetch audio as ArrayBuffer
5. Send to Whisper API
6. Return transcription result

### Whisper API Call
```typescript
async function callWhisperApi(
  audioBuffer: ArrayBuffer,
  apiKey: string
): Promise<string>
```
- POST to `https://api.openai.com/v1/audio/transcriptions`
- Content-Type: multipart/form-data
- Include: `file` (audio blob), `model: whisper-1`, `response_format: text`
- Handle rate limiting: retry with exponential backoff (max 3 retries)
- Throw AppError with `TRANSCRIPTION_FAILED` on errors

### Audio Validation
```typescript
export async function validateAudioUrl(audioUrl: string): Promise<{
  contentLength: number;
  contentType: string;
}>
```
- HEAD request to audio URL
- Validate Content-Type is audio/* 
- Return size info for decisions
- Throw AppError with `AUDIO_UNAVAILABLE` if 403/404/timeout

## Create src/lib/retry.ts

Generic retry utility:
```typescript
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    baseDelayMs: number;
    shouldRetry?: (error: Error) => boolean;
  }
): Promise<T>
```

Use exponential backoff: delay = baseDelay * 2^attempt

## Tests (test/transcription.test.ts)

Mock the OpenAI API with msw or vitest mocks.

1. Successful transcription of small file
2. File size validation (under/over 25MB)
3. Audio URL validation (accessible, 403, 404)
4. Whisper API error handling
5. Rate limit retry logic
6. Content-Type validation

## Integration Note

This service will be called from the queue consumer. For now, it's a standalone module. The queue integration comes in Prompt 9.
```

---

## Prompt 6: GPT Summarization Service

**Goal**: Implement summary generation using OpenAI's GPT-5.2 Responses API with the defined templates.

```markdown
Implement the summarization service using OpenAI GPT-5.2 Responses API.

## Create src/services/summarization.ts

### Types
```typescript
interface SummarizationResult {
  text: string;
  model: string;
}
```

### Main Function
```typescript
export async function generateSummary(
  transcript: string,
  templateId: string,
  openaiApiKey: string
): Promise<SummarizationResult>
```

Implementation:
1. Look up template from TEMPLATES constant
2. Validate templateId exists (throw if not)
3. Call GPT-5.2 Responses API
4. Return summary text and model used

### GPT-5.2 Responses API Call

Use the Responses API format (NOT chat completions):
```typescript
const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-5.2',
    input: [
      { role: 'system', content: template.prompt },
      { role: 'user', content: transcript }
    ]
  })
});
```

Response parsing:
```typescript
const data = await response.json();
// Extract text from: data.output[0].content[0].text
// Or use output_text helper if available
```

### Error Handling

- 429 (rate limited): Throw AppError with `RATE_LIMITED`
- 5xx: Retry with backoff using withRetry utility
- 4xx: Throw AppError with `SUMMARIZATION_FAILED`
- Parse errors: Throw AppError with `SUMMARIZATION_FAILED`

### Template Validation
```typescript
export function isValidTemplate(templateId: string): boolean
export function getTemplate(templateId: string): Template | undefined
```

## Tests (test/summarization.test.ts)

1. Successful summary generation with each template
2. Invalid template ID handling
3. Rate limit detection and error
4. API error handling
5. Response parsing (including malformed responses)
6. Verify correct API format is used (Responses API, not chat)

## Integration Note

Wire into the debug route for manual testing:
```typescript
app.get('/debug/summarize', async (c) => {
  const text = c.req.query('text') || 'This is a test transcript.';
  const template = c.req.query('template') || 'key-takeaways';
  const result = await generateSummary(text, template, c.env.OPENAI_API_KEY);
  return c.json(result);
});
```
```

---

## Prompt 7: Public API Routes (Read-Only)

**Goal**: Implement the public JSON API endpoints for listing and viewing episodes. No authentication required.

```markdown
Implement public API routes for reading episode data.

## Create src/routes/api.ts

Use Hono's router pattern:
```typescript
import { Hono } from 'hono';
import type { Env } from '../types';

const api = new Hono<{ Bindings: Env }>();
export default api;
```

### GET /api/episodes

List all completed episodes.

Response:
```json
{
  "episodes": [
    {
      "id": "123_456",
      "podcastName": "Podcast Name",
      "episodeTitle": "Episode Title",
      "episodeDate": "2024-01-15",
      "episodeDuration": 2700,
      "summaryTemplates": ["key-takeaways", "eli5"],
      "createdAt": "2024-12-15T10:00:00Z",
      "expiresAt": "2025-12-15T10:00:00Z"
    }
  ]
}
```

Implementation:
1. Use `listEpisodes` from kv.ts
2. For each episode, list available summaries
3. Sort by createdAt descending
4. Return JSON array

### GET /api/episode/:episodeId

Get single episode with summary and transcript.

Response:
```json
{
  "episode": { /* Episode data */ },
  "summaries": [
    {
      "templateId": "key-takeaways",
      "templateName": "Key Takeaways & Practical Steps",
      "text": "...",
      "createdAt": "..."
    }
  ],
  "transcript": {
    "text": "...",
    "source": "rss",
    "createdAt": "..."
  }
}
```

Handle 404 if episode not found.

### GET /api/templates

List available summary templates.

Response:
```json
{
  "templates": [
    {
      "id": "key-takeaways",
      "name": "Key Takeaways & Practical Steps",
      "description": "For craft and professional development podcasts"
    }
  ]
}
```

## Update src/index.ts

Mount the API routes:
```typescript
import api from './routes/api';

app.route('/api', api);
```

## Tests (test/routes/api.test.ts)

Use Hono's test helper or direct fetch against the worker.

1. GET /api/episodes returns empty array when no data
2. GET /api/episodes returns sorted episodes
3. GET /api/episode/:id returns full data
4. GET /api/episode/:id returns 404 for missing episode
5. GET /api/templates returns all templates

## Integration

Run `wrangler dev` and test manually:
- `curl http://localhost:8787/api/episodes`
- `curl http://localhost:8787/api/templates`
```

---

## Prompt 8: Authenticated API Routes (Submit, Regenerate, Delete)

**Goal**: Implement protected API routes for mutating operations. These will be behind Cloudflare Access in production.

```markdown
Implement authenticated API routes for episode management.

## Create src/routes/authenticated.ts

### Middleware

For local dev, skip auth. In production, Cloudflare Access adds CF-Access-JWT headers.

```typescript
const authenticated = new Hono<{ Bindings: Env }>();

// Middleware to validate we're either in dev or have Access headers
authenticated.use('*', async (c, next) => {
  const cfAccessJwt = c.req.header('Cf-Access-Jwt-Assertion');
  const isDev = c.env.CF_ENV !== 'production'; // Add this to wrangler.toml
  
  if (!isDev && !cfAccessJwt) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

export default authenticated;
```

### POST /submit

Submit new episode for processing.

Request body:
```json
{
  "appleUrl": "https://podcasts.apple.com/...",
  "templateId": "key-takeaways"
}
```

Response:
```json
{
  "jobId": "uuid",
  "status": "queued",
  "episodeId": "123_456",
  "cached": false
}
```

Implementation:
1. Parse and validate Apple URL
2. Validate template ID
3. Derive episode ID
4. Check if episode + template already exists in KV
   - If yes, return immediately with `cached: true`
5. Create job record in KV
6. Queue job to TLDL_QUEUE
7. Return job info

### GET /job/:jobId

Get job status (for polling).

Response:
```json
{
  "id": "uuid",
  "status": "transcribing",
  "episodeId": "123_456",
  "estimatedSeconds": 120,
  "error": null,
  "updatedAt": "..."
}
```

Handle 404 if job not found.

### POST /episode/:episodeId/regenerate

Request body:
```json
{
  "templateId": "eli5"
}
```

Implementation:
1. Validate episode exists
2. Validate template ID
3. Check if summary already exists for this template
   - If yes, return cached
4. Create regeneration job (skip transcription step)
5. Queue job
6. Return job info

### DELETE /episode/:episodeId

Delete episode and all related data.

Implementation:
1. Verify episode exists
2. Delete from KV (episode, transcript, all summaries)
3. Return `{ deleted: true }`

### POST /job/:jobId/retry

Retry a failed job.

Implementation:
1. Get job from KV
2. Verify status is "failed"
3. Reset status to "queued"
4. Re-queue job
5. Return updated job info

## Create src/lib/queue.ts

Helper to send jobs to the queue:
```typescript
interface QueueMessage {
  type: 'process_episode' | 'regenerate_summary';
  jobId: string;
  episodeId: string;
  appleUrl: string;
  templateId: string;
}

export async function enqueueJob(
  queue: Queue,
  message: QueueMessage
): Promise<void>
```

## Update src/index.ts

```typescript
import authenticated from './routes/authenticated';

app.route('/', authenticated);  // Mounts at /submit, /job/:id, etc.
```

## Tests (test/routes/authenticated.test.ts)

1. POST /submit with valid URL creates job and returns ID
2. POST /submit with invalid URL returns 400
3. POST /submit with cached episode returns immediately
4. GET /job/:id returns job status
5. GET /job/:id returns 404 for missing job
6. POST /episode/:id/regenerate creates new job
7. DELETE /episode/:id removes all data
8. POST /job/:id/retry resets failed job
9. All routes reject without auth header (in prod mode)
```

---

## Prompt 9: Queue Consumer — Core Processing Pipeline

**Goal**: Implement the Cloudflare Queue consumer that processes jobs through the full pipeline: metadata → transcript → summary.

```markdown
Implement the queue consumer for background job processing.

## Create src/queue/consumer.ts

### Queue Handler Export

```typescript
export default {
  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, env);
        message.ack();
      } catch (error) {
        console.error(`Job ${message.body.jobId} failed:`, error);
        message.retry();
      }
    }
  }
};
```

### Message Processing

```typescript
async function processMessage(
  msg: QueueMessage,
  env: Env
): Promise<void>
```

For `process_episode` type:

1. **Update status: fetching_metadata**
   - Update job in KV
   
2. **Fetch episode metadata**
   - Parse Apple URL
   - Call iTunes API
   - Fetch and parse RSS feed
   - Find episode
   - Validate duration (< MAX_EPISODE_MINUTES)
   
3. **Update status: checking_transcript**
   - Check if transcript already in KV (from previous attempt)
   - Check RSS feed for transcript URL
   
4. **If no transcript: Update status: transcribing**
   - Validate audio URL is accessible
   - Call Whisper API
   - Store transcript in KV
   
5. **Update status: summarizing**
   - Get transcript from KV
   - Call GPT-5.2 with template
   - Store summary in KV
   
6. **Update status: completed**
   - Save episode metadata to KV
   - Set TTL on all records

For `regenerate_summary` type:
- Skip steps 2-4
- Start at step 5 (summarizing)
- Assume transcript exists

### Error Handling

Wrap each step in try/catch. On error:
1. Update job status to "failed" with error message
2. Throw to trigger message.retry()
3. After max retries, job stays failed

Map error codes to user-friendly messages:
```typescript
function mapErrorToUserMessage(error: Error): string
```

### Estimate Time

Rough estimates based on episode duration:
- Transcription: ~1-2 min per 15 min of audio
- Summary: ~30 seconds

Update `estimatedSeconds` as job progresses.

## Update src/index.ts

Export the queue handler:
```typescript
import queueHandler from './queue/consumer';

export default {
  fetch: app.fetch,
  queue: queueHandler.queue,
};
```

## Tests (test/queue/consumer.test.ts)

Use vitest with mocked services.

1. Full happy path: valid URL → completed
2. Cached transcript: skips transcription
3. RSS transcript available: uses it, skips Whisper
4. Episode too long: fails with correct error
5. Whisper API failure: fails gracefully
6. GPT API failure: fails gracefully  
7. Regenerate: only runs summarization step
8. Job status updates at each step

## Manual Testing

1. Deploy with `wrangler deploy`
2. Create KV namespace and queue
3. Submit a short test episode via /submit
4. Watch logs with `wrangler tail`
5. Verify episode appears in /api/episodes
```

---

## Prompt 10: Server-Rendered HTML — Episode List and Detail Pages

**Goal**: Implement the public HTML pages for viewing episodes. Use Hono's JSX/HTML rendering with dark mode styling.

```markdown
Implement server-rendered HTML pages for public episode viewing.

## Create src/routes/public.ts

### Base Layout Component

```typescript
import { html } from 'hono/html';

function Layout(props: { title: string; children: any }) {
  return html`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${props.title} - TLDL</title>
      <link rel="stylesheet" href="/styles.css">
    </head>
    <body class="dark">
      <nav>
        <a href="/">TLDL</a>
      </nav>
      <main>
        ${props.children}
      </main>
    </body>
    </html>
  `;
}
```

### GET / — Episode List

Display all completed episodes as cards.

Components:
- Episode card (podcast name, title, date, duration, template badges)
- Empty state when no episodes
- "Submit Episode" button (shown via Access header detection)

Implementation:
1. Fetch episodes from KV
2. For each, get available summary templates
3. Render card grid
4. Sort by most recent

### GET /episode/:episodeId — Episode Detail

Display full episode with summary and transcript.

Components:
- Header: podcast name, title, date, duration
- Expiration badge ("Expires in X days")
- Summary section with template name
- Template selector tabs (if multiple summaries exist)
- Transcript section (collapsible)
- Action buttons: Download PDF, Regenerate (if authenticated)

Implementation:
1. Fetch episode, transcript, all summaries
2. Default to most recent summary or specified template query param
3. Render markdown summary (use a simple md-to-html function)
4. Show transcript in collapsible section

### Markdown Rendering

Create simple markdown parser or use a lightweight library:
```typescript
function renderMarkdown(md: string): string
```

Handle: headers, bold, italic, lists, code blocks, paragraphs.

## Create public/styles.css

Reference the Figma export's design tokens. Include:

- Dark mode by default (bg-gray-900, text-gray-100)
- Card styles with subtle borders
- Responsive grid (1 col mobile, 2-3 cols desktop)
- Template badge pills
- Collapsible sections
- Button styles
- Typography: system fonts or Inter

### CSS Variables
```css
:root {
  --color-bg: #111827;
  --color-surface: #1f2937;
  --color-text: #f9fafb;
  --color-text-muted: #9ca3af;
  --color-accent: #3b82f6;
  --color-border: #374151;
}
```

## Update src/index.ts

Mount public routes and serve static files:
```typescript
import public from './routes/public';
import { serveStatic } from 'hono/cloudflare-workers';

app.get('/styles.css', serveStatic({ path: './public/styles.css' }));
app.route('/', public);
```

## Tests

1. GET / returns HTML with episode list
2. GET /episode/:id returns episode detail
3. 404 page for missing episode
4. Verify mobile responsiveness in browser
5. Dark mode appearance

## Manual Testing

Deploy and visit in browser:
- http://localhost:8787/
- http://localhost:8787/episode/{test-id}
```

---

## Prompt 11: Server-Rendered HTML — Submit Form and Job Status

**Goal**: Implement the authenticated HTML pages for submitting episodes and viewing job progress.

```markdown
Implement server-rendered pages for episode submission and job status.

## Update src/routes/public.ts (or create authenticated HTML routes)

### GET /submit — Submission Form

```html
<form method="POST" action="/submit">
  <label>
    Apple Podcasts URL
    <input 
      type="url" 
      name="appleUrl" 
      placeholder="https://podcasts.apple.com/..."
      required
    >
  </label>
  
  <fieldset>
    <legend>Summary Template</legend>
    <label>
      <input type="radio" name="templateId" value="key-takeaways" checked>
      Key Takeaways & Practical Steps
      <span class="description">For craft and professional development podcasts</span>
    </label>
    <label>
      <input type="radio" name="templateId" value="narrative-summary">
      Narrative Summary
      <span class="description">For story-driven and interview podcasts</span>
    </label>
    <label>
      <input type="radio" name="templateId" value="eli5">
      ELI5 (Explain Like I'm 5)
      <span class="description">For technical and complex topics</span>
    </label>
  </fieldset>
  
  <button type="submit">Process Episode</button>
</form>
```

Form validation:
- Client-side: required URL, valid format
- Server-side: full validation with error display

### POST /submit — Form Handler (HTML response)

1. Parse form data
2. Validate URL and template
3. On error: re-render form with error message
4. On success: redirect to /job/:jobId

### GET /job/:jobId — Job Status Page

Display current job progress with auto-refresh.

Components:
- Episode info (if metadata fetched): podcast name, title
- Progress stepper:
  - ○ Queued
  - ○ Fetching metadata  
  - ○ Checking for transcript
  - ○ Transcribing (if needed)
  - ○ Summarizing
  - ● Completed
- Current step highlighted
- Estimated time remaining
- Error display with Retry button (if failed)

Auto-refresh:
```html
<meta http-equiv="refresh" content="5">
```
Or: use a small inline script with fetch polling.

On completed: redirect to /episode/:episodeId

### Error States

Show user-friendly error messages styled as alerts:
```html
<div class="error-card">
  <h3>⚠ Processing Failed</h3>
  <p>Unable to fetch episode audio. The episode may be geo-restricted.</p>
  <form method="POST" action="/job/{jobId}/retry">
    <button type="submit">Retry</button>
  </form>
</div>
```

## Update public/styles.css

Add styles for:
- Form inputs and labels
- Radio button group
- Submit button (primary action style)
- Progress stepper (vertical list with connecting line)
- Error card styling
- Loading spinner (CSS animation)

## Accessibility

- Form labels properly associated
- Focus states visible
- Error messages linked to inputs
- Progress updates announced (aria-live)

## Tests

1. GET /submit renders form
2. POST /submit with valid data creates job and redirects
3. POST /submit with invalid URL shows error inline
4. GET /job/:id shows correct status
5. Auto-refresh works
6. Completed job redirects to episode
7. Failed job shows error and retry button
```

---

## Prompt 12: PDF Generation

**Goal**: Implement PDF download for episodes using jsPDF in the Worker.

```markdown
Implement PDF generation for episode summaries.

## Install jsPDF

```bash
npm install jspdf
```

## Create src/services/pdf.ts

```typescript
import { jsPDF } from 'jspdf';

interface PdfContent {
  podcastName: string;
  episodeTitle: string;
  episodeDate: string;
  summary: string;
  summaryTemplate: string;
  transcript: string;
  expiresAt: string;
}

export function generateEpisodePdf(content: PdfContent): ArrayBuffer
```

### PDF Structure

1. **Header**
   - TLDL logo/text
   - Podcast name (large)
   - Episode title (medium)
   - Date and duration

2. **Summary Section**
   - Template name badge
   - Summary text (markdown stripped to plain text)

3. **Transcript Section**
   - Section header
   - Full transcript text (may span multiple pages)

4. **Footer (each page)**
   - "Generated by TLDL"
   - Expiration date

### Implementation Notes

- Use built-in fonts (helvetica) for reliability
- Set reasonable margins (20mm)
- Handle long text with automatic pagination
- Strip markdown formatting or convert to plain text

### Text Handling

```typescript
function stripMarkdown(md: string): string
```

Remove: `#`, `**`, `*`, `` ` ``, links, etc.

### Pagination

jsPDF `splitTextToSize` for text wrapping:
```typescript
const pageWidth = doc.getPageWidth();
const margin = 20;
const maxWidth = pageWidth - margin * 2;
const lines = doc.splitTextToSize(text, maxWidth);
```

Add new pages as needed when content overflows.

## Add Route: GET /episode/:episodeId/pdf

```typescript
app.get('/episode/:episodeId/pdf', async (c) => {
  const episodeId = c.req.param('episodeId');
  
  // Fetch data
  const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
  if (!episode) return c.notFound();
  
  const transcript = await getTranscript(c.env.TLDL_DATA, episodeId);
  const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);
  
  // Use most recent summary or specified template
  const templateId = c.req.query('template') || summaries[0]?.templateId;
  const summary = await getSummary(c.env.TLDL_DATA, episodeId, templateId);
  
  // Generate PDF
  const pdfBuffer = generateEpisodePdf({
    podcastName: episode.podcastName,
    episodeTitle: episode.episodeTitle,
    episodeDate: episode.episodeDate,
    summary: summary?.text || '',
    summaryTemplate: templateId,
    transcript: transcript?.text || '',
    expiresAt: episode.expiresAt,
  });
  
  // Return as download
  return new Response(pdfBuffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${episode.episodeTitle}.pdf"`,
    },
  });
});
```

## Tests

1. Generate PDF with all content
2. Handle long transcripts (pagination)
3. Handle missing summary gracefully
4. Verify PDF is valid (can be opened)
5. Content-Disposition header is correct

## Manual Testing

Download a PDF and verify:
- Opens in PDF reader
- All sections present
- Text readable
- Multiple pages work
```

---

## Prompt 13: Error Handling and Input Validation Hardening

**Goal**: Add comprehensive error handling, input validation, and user-friendly error pages.

```markdown
Harden error handling and input validation across the app.

## Update src/lib/errors.ts

### Error Code Mapping

```typescript
export const ERROR_MESSAGES: Record<string, string> = {
  INVALID_URL: "Please enter a valid Apple Podcasts episode URL. It should look like: podcasts.apple.com/...?i=...",
  EPISODE_NOT_FOUND: "Couldn't find this episode. Please check the URL and try again.",
  EPISODE_TOO_LONG: "This episode is too long (over 80 minutes). Try a shorter episode.",
  AUDIO_UNAVAILABLE: "Unable to access the episode audio. It may be geo-restricted or no longer available.",
  TRANSCRIPTION_FAILED: "Transcription failed. Please try again in a few minutes.",
  SUMMARIZATION_FAILED: "Summary generation failed. Please try again in a few minutes.",
  RATE_LIMITED: "We're processing too many requests. Please try again in a few minutes.",
  UNKNOWN_ERROR: "Something went wrong. Please try again or contact support.",
};
```

### Error Response Helper

```typescript
export function errorResponse(
  c: Context,
  error: AppError | Error,
  isHtml: boolean = false
): Response
```

Returns JSON error for API routes, HTML error page for browser routes.

## Create Error Pages

### 404 Page
```html
<div class="error-page">
  <h1>404</h1>
  <p>This page doesn't exist.</p>
  <a href="/">Back to home</a>
</div>
```

### 500 Page
```html
<div class="error-page">
  <h1>Something went wrong</h1>
  <p>We're looking into it. Please try again later.</p>
  <a href="/">Back to home</a>
</div>
```

### Error Page Component
```typescript
function ErrorPage(props: { title: string; message: string }) { ... }
```

## Add Global Error Handler

```typescript
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  
  if (err instanceof AppError) {
    const status = getHttpStatus(err.code);
    return errorResponse(c, err, isHtmlRequest(c));
  }
  
  return errorResponse(c, new AppError('UNKNOWN_ERROR', ERROR_MESSAGES.UNKNOWN_ERROR), isHtmlRequest(c));
});

app.notFound((c) => {
  return c.html(ErrorPage({ title: '404', message: 'Page not found' }), 404);
});
```

## Input Validation Library

Create src/lib/validation.ts:

```typescript
export function validateAppleUrl(url: string): { valid: true; parsed: ParsedAppleUrl } | { valid: false; error: string }

export function validateTemplateId(templateId: string): boolean

export function validateUuid(id: string): boolean
```

Use these in all route handlers before processing.

## Sanitization

Ensure all user input is sanitized before:
- Storing in KV
- Rendering in HTML (prevent XSS)
- Using in URLs

```typescript
export function sanitizeForHtml(text: string): string
export function sanitizeForUrl(text: string): string
```

## Logging Improvements

```typescript
function logError(context: {
  jobId?: string;
  episodeId?: string;
  error: Error;
  requestId?: string;
}) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    ...context,
    errorCode: (context.error as AppError).code,
    errorMessage: context.error.message,
    stack: context.error.stack,
  }));
}
```

## Tests

1. Invalid URL returns proper error message
2. Unknown episode returns 404
3. API errors return JSON with error code
4. HTML errors render error page
5. XSS payloads are sanitized
6. Global error handler catches uncaught exceptions
```

---

## Prompt 14: Security Hardening and Rate Limiting

**Goal**: Protect OpenAI API from abuse, add security headers, CORS configuration, and per-user rate limiting.

```markdown
Implement security hardening and rate limiting.

## CRITICAL: Protect OpenAI API Endpoints

### Remove or Protect Debug Routes

The following debug routes directly call OpenAI APIs and MUST be protected before production:

1. **Remove these routes entirely** (or gate behind a secret):
   - `GET /debug/transcribe` - calls Whisper API
   - `GET /debug/summarize` - calls GPT API

2. **Safe to keep** (no OpenAI calls):
   - `GET /debug/parse` - just URL parsing
   - `GET /debug/validate-audio` - just HEAD request
   - `GET /debug/episode` - just iTunes/RSS fetch

Implementation:
```typescript
// Option A: Remove entirely in production
if (c.env.ENVIRONMENT !== 'development') {
  // Don't register debug routes
}

// Option B: Gate behind secret header
app.use('/debug/transcribe', async (c, next) => {
  if (c.req.header('X-Debug-Secret') !== c.env.DEBUG_SECRET) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});
```

### Make Auth Middleware Fail-Closed

Update `src/routes/authenticated.ts` to REJECT requests without valid Cloudflare Access JWT in production:

```typescript
authenticated.use('*', async (c, next) => {
  const cfAccessJwt = c.req.header('Cf-Access-Jwt-Assertion');
  
  // In development, allow requests without JWT for testing
  const isDevelopment = c.env.ENVIRONMENT === 'development';
  
  if (!isDevelopment && !cfAccessJwt) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  await next();
});
```

Add `ENVIRONMENT` to wrangler.toml:
```toml
[vars]
ENVIRONMENT = "production"

[env.dev.vars]
ENVIRONMENT = "development"
```

## Security Headers Middleware

```typescript
app.use('*', async (c, next) => {
  await next();
  
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // CSP for HTML responses
  if (c.res.headers.get('Content-Type')?.includes('text/html')) {
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'"
    );
  }
});
```

## CORS Configuration

For API routes only:
```typescript
import { cors } from 'hono/cors';

api.use('*', cors({
  origin: ['https://tldl.yourdomain.com'],
  allowMethods: ['GET', 'POST', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));
```

## Rate Limiting

### Per-User Rate Limit

Store in KV with short TTL:
```
Key: ratelimit:{user_email}:{hour}
Value: { count: number }
TTL: 3600 seconds
```

### Middleware

```typescript
async function rateLimit(c: Context, next: Next) {
  const email = getUserEmail(c); // From CF Access JWT
  if (!email) {
    await next();
    return;
  }
  
  const hour = Math.floor(Date.now() / 3600000);
  const key = `ratelimit:${email}:${hour}`;
  
  const current = await c.env.TLDL_DATA.get(key, 'json') as { count: number } | null;
  const count = (current?.count || 0) + 1;
  
  if (count > 10) { // 10 submissions per hour
    throw new AppError('RATE_LIMITED', ERROR_MESSAGES.RATE_LIMITED);
  }
  
  await c.env.TLDL_DATA.put(key, JSON.stringify({ count }), { expirationTtl: 3600 });
  await next();
}
```

Apply to /submit route only.

### Rate Limit Headers

Add to responses:
```typescript
c.res.headers.set('X-RateLimit-Limit', '10');
c.res.headers.set('X-RateLimit-Remaining', String(10 - count));
c.res.headers.set('X-RateLimit-Reset', String((hour + 1) * 3600));
```

## JWT Validation Helper

```typescript
function getUserEmail(c: Context): string | null {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;
  
  // Decode JWT payload (CF Access validates signature)
  const payload = JSON.parse(atob(jwt.split('.')[1]));
  return payload.email || null;
}
```

## Input Size Limits

Add middleware to reject oversized payloads:
```typescript
app.use('*', async (c, next) => {
  const contentLength = c.req.header('Content-Length');
  if (contentLength && parseInt(contentLength) > 10000) { // 10KB max
    return c.json({ error: 'Request too large' }, 413);
  }
  await next();
});
```

## Tests

### OpenAI Protection Tests (CRITICAL)
1. Debug transcribe/summarize routes return 403 in production without secret
2. POST /submit returns 401 in production without CF Access JWT
3. POST /episode/:id/regenerate returns 401 in production without CF Access JWT
4. POST /job/:id/retry returns 401 in production without CF Access JWT

### Security Headers Tests
5. Security headers present on all responses
6. CSP header on HTML responses
7. CORS rejects unauthorized origins

### Rate Limiting Tests
8. Rate limit blocks after 10 requests per hour
9. Rate limit resets after hour
10. Rate limit headers present in responses

### Other Security Tests
11. JWT email extraction works
12. Oversized requests rejected
```

---

## Prompt 15: Integration Testing and Polish

**Goal**: Add comprehensive integration tests, polish the UI, and prepare for deployment.

```markdown
Add integration tests and final polish.

## Integration Test Suite

Create test/integration/ directory.

### Full Flow Test (test/integration/full-flow.test.ts)

```typescript
describe('Episode Processing Flow', () => {
  it('submits episode, processes, and displays summary', async () => {
    // 1. Submit episode via POST /submit
    // 2. Poll /api/job/:id until completed
    // 3. Verify episode in /api/episodes
    // 4. Verify episode detail at /api/episode/:id
    // 5. Verify PDF download works
  });
  
  it('handles cached episode correctly', async () => {
    // Submit same episode twice
    // Second should return cached: true immediately
  });
  
  it('regenerates with different template', async () => {
    // 1. Process with key-takeaways
    // 2. Regenerate with eli5
    // 3. Both summaries available
  });
  
  it('cleans up on delete', async () => {
    // 1. Process episode
    // 2. Delete it
    // 3. Verify 404 on all endpoints
  });
});
```

### Error Flow Tests (test/integration/errors.test.ts)

```typescript
describe('Error Handling', () => {
  it('rejects invalid URLs with helpful message', async () => });
  it('handles iTunes API failures gracefully', async () => });
  it('handles Whisper API failures gracefully', async () => });
  it('allows retry of failed jobs', async () => });
});
```

## UI Polish

### Loading States
- Add skeleton loaders for episode list
- Spinner on form submit
- Progress bar on job status page

### Transitions
```css
.episode-card {
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.episode-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
```

### Mobile Improvements
- Larger tap targets (48px min)
- Collapsible transcript on mobile
- Sticky header on scroll

### Empty States
- Friendly illustration or icon
- Clear call-to-action

## Favicon and Meta

Add to Layout:
```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="description" content="AI-powered podcast summaries">
<meta property="og:title" content="TLDL - Too Long Didn't Listen">
<meta property="og:description" content="Get AI summaries of podcast episodes">
```

Create simple SVG favicon.

## README Updates

Update README.md with:
- Project overview
- Local development setup
- Deployment instructions
- Environment variables
- Cloudflare Access setup

## Pre-Deployment Checklist

- [ ] All tests pass
- [ ] Environment variables documented
- [ ] KV namespace created
- [ ] Queue created
- [ ] Cloudflare Access configured
- [ ] Custom domain (optional)
- [ ] wrangler.toml has production IDs
- [ ] secrets set via wrangler secret put

## Deploy

```bash
# Set secrets
wrangler secret put OPENAI_API_KEY

# Deploy
wrangler deploy

# Tail logs
wrangler tail
```

## Tests

Run full test suite:
```bash
npm test
npm run test:integration
```

Verify coverage:
```bash
npm run test:coverage
```
```

---

## Summary: Implementation Order

| # | Prompt | Core Deliverable | Dependencies |
|---|--------|------------------|--------------|
| 1 | Project Scaffolding | Types, config, skeleton | None |
| 2 | KV Storage Layer | Data access functions | 1 |
| 3 | URL Parser + iTunes API | Apple podcasts integration | 1, 2 |
| 4 | RSS Parser | Feed parsing, transcript detection | 1, 3 |
| 5 | Whisper Transcription | Audio processing | 1, 2 |
| 6 | GPT Summarization | AI summaries | 1, 2 |
| 7 | Public API Routes | JSON endpoints | 1, 2 |
| 8 | Authenticated Routes | Mutations, job queue | 1, 2, 3 |
| 9 | Queue Consumer | Background processing | All services |
| 10 | Public HTML Pages | Episode list/detail UI | 7 |
| 11 | Auth HTML Pages | Submit/status UI | 8, 10 |
| 12 | PDF Generation | Download feature | 2, 10 |
| 13 | Error Handling | User-friendly errors | All |
| 14 | Security | Headers, rate limits | All |
| 15 | Integration Tests | Full coverage | All |

Each prompt produces working, tested code that integrates with previous work. No orphan code, no large complexity jumps.
