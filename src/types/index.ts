// ============================================================================
// TLDL Type Definitions
// ============================================================================

/**
 * Job status represents the current phase of episode processing
 */
export type JobStatus =
    | "queued"
    | "fetching_metadata"
    | "checking_transcript"
    | "transcribing"
    | "summarizing"
    | "completed"
    | "failed";

/**
 * Source of the transcript - determines how we obtained it
 */
export type TranscriptSource = "apple" | "rss" | "openai" | "manual";

/**
 * Job record - tracks the processing state of a submitted episode
 * Stored in KV with key: job:{job_id}
 * TTL: 1 day
 */
export interface Job {
    id: string;                    // UUID
    episodeId: string;             // Derived from Apple Podcasts URL
    appleUrl: string;              // Original submitted URL
    status: JobStatus;
    templateId: string;            // Template used for this job
    error?: string;                // Error message if failed
    estimatedSeconds?: number;     // Rough time estimate remaining
    podcastName?: string;          // Podcast name (populated after metadata fetch)
    episodeTitle?: string;         // Episode title (populated after metadata fetch)
    createdAt: string;             // ISO timestamp
    updatedAt: string;             // ISO timestamp
}

/**
 * Episode record - metadata about a processed podcast episode
 * Stored in KV with key: episode:{episode_id}
 * TTL: 365 days
 */
export interface Episode {
    id: string;                    // Derived from Apple episode ID
    appleUrl: string;              // Original Apple Podcasts URL
    podcastName: string;
    episodeTitle: string;
    episodeDuration: number;       // Duration in seconds
    episodeDate: string;           // Original publish date (ISO)
    audioUrl: string;              // Source audio URL
    transcriptSource: TranscriptSource;
    createdAt: string;             // ISO timestamp
    expiresAt: string;             // ISO timestamp (createdAt + 365 days)
    submittedBy?: string;          // Email of user who submitted (optional for backwards compat)
    tags?: string[];               // AI-generated episode tags (1-4 tags)
    podcastAuthor?: string;        // Podcast author/host name
    podcastWebsiteUrl?: string;    // Podcast website URL
    /** 1-2 sentence deck for Index + Detail hero. Populated going forward; undefined for pre-redesign episodes. */
    deck?: string;
    /** One-sentence aphoristic pull quote from the transcript. Populated going forward; undefined for pre-redesign episodes. */
    pullQuote?: string;
}

/**
 * Episode index entry - lightweight data for home page listing
 * Stored as array in KV with key: episodes:index
 * TTL: 365 days (refreshed when index is updated)
 */
export interface EpisodeIndexEntry {
    id: string;
    podcastName: string;
    episodeTitle: string;
    episodeDate: string;
    episodeDuration: number;
    createdAt: string;
    expiresAt: string;
    tags?: string[];               // AI-generated episode tags (included for filtering)
    podcastAuthor?: string;        // Podcast author/host name
    audioUrl?: string;             // Source audio URL — used for dedup when publishers retitle/regenerate GUIDs
    templateIds?: string[];        // Summary template IDs that exist for this episode — denormalized for /admin Episodes tab
}

/**
 * Transcript record - the full text transcript of an episode
 * Stored in KV with key: transcript:{episode_id}
 * TTL: 365 days
 */
export interface Transcript {
    episodeId: string;
    text: string;                  // Full transcript text
    source: TranscriptSource;
    model?: string;                // e.g., "gpt-4o-mini-transcribe", "whisper-large-v3-turbo"
    createdAt: string;             // ISO timestamp
}

/**
 * Summary record - AI-generated summary using a specific template
 * Stored in KV with key: summary:{episode_id}:{template_id}
 * TTL: 365 days
 */
export interface Summary {
    episodeId: string;
    templateId: string;
    text: string;                  // Generated summary (markdown)
    model: string;                 // e.g., "gpt-5.2"
    createdAt: string;             // ISO timestamp
}

/**
 * Summary template definition
 */
export interface Template {
    id: string;
    name: string;
    description: string;
    prompt: string;
}

/**
 * Queue message types for background processing
 */
export type QueueMessageType = "process_episode" | "regenerate_summary" | "process_manual";

export interface QueueMessage {
    type: QueueMessageType;
    jobId: string;
    episodeId: string;
    // URL-based fields (required for process_episode, unused for process_manual/regenerate_summary)
    appleUrl?: string;
    templateId: string;
    // Pre-fetched iTunes metadata (to avoid 403 errors in queue consumer)
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    // Override audio URL (bypasses origin rate limiting on redirecting hosts)
    audioUrlOverride?: string;
    // Pre-resolved audio URL (redirect followed in request handler context to bypass CDN WAF blocking)
    preResolvedAudioUrl?: string;
    // User who submitted the episode
    submittedBy?: string;

    // RSS-sourced monitoring: full metadata pre-fetched from the feed
    rssSourced?: boolean;
    audioUrl?: string;
    durationSeconds?: number;
    transcriptUrl?: string;
    transcriptType?: string;
    podcastTitle?: string;
}

/**
 * Payload submitted via POST /admin/submit-manual
 */
export interface ManualSubmission {
    title: string;
    transcript: string;
    podcastId?: string;
    podcastName?: string;
    pubDate?: string;      // ISO date
    episodeUrl?: string;
    durationMinutes?: number;
    description?: string;
    imageUrl?: string;
}

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
    // KV Namespace
    TLDL_DATA: KVNamespace;

    // Queue
    TLDL_QUEUE: Queue<QueueMessage>;

    // Durable Object for job status (strong consistency).
    // The auto-generated worker-configuration.d.ts has the precise generic
    // (`<JobStatusDO>`); we keep this loose because JobStatusDO uses the old
    // `implements DurableObject` interface and doesn't satisfy the newer
    // `Rpc.DurableObjectBranded` constraint.
    JOB_STATUS: DurableObjectNamespace;

    // Secrets (set via wrangler secret put)
    OPENAI_API_KEY: string;
    ANTHROPIC_API_KEY: string;
    PODCAST_INDEX_KEY: string;
    PODCAST_INDEX_SECRET: string;
    TURNSTILE_SECRET: string;
    DISCORD_WEBHOOK_URL?: string;  // Optional — notifications disabled if not set
    POSTMARK_API_KEY?: string;     // Optional — request form disabled if not set
    MANAGE_LINK_HMAC_SECRET: string;
    POSTMARK_WEBHOOK_AUTH: string;
    EMAIL_DISPATCH_ENABLED?: string;  // optional; "false" disables dispatch

    // D1 database for email subscriptions
    DB: D1Database;

    // Environment variables (from wrangler.toml [vars])
    TURNSTILE_SITE_KEY: string;
    POSTMARK_FROM_EMAIL: string;           // e.g., rian@elezea.com
    ADMIN_NOTIFICATION_EMAIL: string;      // e.g., rianvdm@gmail.com
    POSTMARK_MESSAGE_STREAM: string;       // e.g., "tldl"
    MAX_EPISODE_MINUTES: string;
    CACHE_TTL_DAYS: string;
    DEFAULT_TEMPLATE: string;
    ENVIRONMENT: string;           // "production" or "development"
}

/**
 * Hono app type with environment bindings and context variables
 */
export type HonoEnv = {
    Bindings: Env;
    Variables: {
        userEmail?: string;
    };
};

// ============================================================================
// Podcast Monitoring Types
// ============================================================================

/**
 * Monitored podcast record - tracks a podcast being monitored for new episodes
 * Stored in KV with key: monitored:{podcastId}
 */
export interface MonitoredPodcast {
    id: string;                    // Apple podcast ID
    name: string;                  // Podcast name
    rssUrl: string;                // RSS feed URL (from Podcast Index API)
    templateId: string;            // Template to use for new episodes
    addedAt: string;               // ISO timestamp when added
    lastChecked?: string;          // ISO timestamp of last check
    episodesProcessed: number;     // Count of episodes processed
    status: "active" | "paused" | "error";
    lastError?: string;            // Error message if status is "error"

    // Display metadata (used in email notifications and UI)
    coverUrl?: string;             // Podcast cover image URL
    websiteUrl?: string;           // Podcast website URL
    author?: string;               // Podcast author/host name (e.g., "Lenny Rachitsky")

    // Conditional GET cache headers for RSS polling
    etag?: string;
    lastModified?: string;
}

/**
 * Global settings for podcast monitoring
 * Stored in KV with key: monitor:settings
 */
export interface MonitorSettings {
    checkIntervalHours: number;    // Default: 8
    maxEpisodesPerCheck: number;   // Default: 5
    enabled: boolean;              // Global enable/disable
}

/**
 * Activity event type for the admin dashboard activity log
 */
export type ActivityEventType =
    | "episode_completed"
    | "episode_failed"
    | "monitor_check"
    | "monitor_error";

/**
 * A single entry in the admin activity log
 * Stored as part of a JSON array in KV with key: activity:log
 * TTL: 30 days, capped at 50 entries
 */
export interface ActivityEvent {
    type: ActivityEventType;
    timestamp: string;             // ISO 8601
    title: string;                 // Human-readable summary
    details?: string;              // Error message or extra context
    episodeId?: string;            // For episode events
    podcastId?: string;            // For monitoring events
}
