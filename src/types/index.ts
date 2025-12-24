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
export type TranscriptSource = "apple" | "rss" | "openai";

/**
 * Job record - tracks the processing state of a submitted episode
 * Stored in KV with key: job:{job_id}
 * TTL: 7 days
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
export type QueueMessageType = "process_episode" | "regenerate_summary";

export interface QueueMessage {
    type: QueueMessageType;
    jobId: string;
    episodeId: string;
    appleUrl: string;
    templateId: string;
    // Pre-fetched iTunes metadata (to avoid 403 errors in queue consumer)
    episodeGuid?: string;
    expectedTitle?: string;
    expectedDate?: string;
    // User who submitted the episode
    submittedBy?: string;
}

/**
 * Cloudflare Workers environment bindings
 */
export interface Env {
    // KV Namespace
    TLDL_DATA: KVNamespace;

    // Queue
    TLDL_QUEUE: Queue<QueueMessage>;

    // Durable Object for job status (strong consistency)
    JOB_STATUS: DurableObjectNamespace;

    // Secrets (set via wrangler secret put)
    OPENAI_API_KEY: string;
    PODCAST_INDEX_KEY: string;
    PODCAST_INDEX_SECRET: string;
    TURNSTILE_SECRET: string;

    // Environment variables (from wrangler.toml [vars])
    TURNSTILE_SITE_KEY: string;
    MAX_EPISODE_MINUTES: string;
    CACHE_TTL_DAYS: string;
    DEFAULT_TEMPLATE: string;
    ENVIRONMENT: string;  // "production" or "development"
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
