# Durable Objects for Real-Time Job Status

## Problem

Cloudflare KV is eventually consistent. Writes from one edge location (e.g., SJC where the queue consumer runs) take up to 60 seconds to propagate to other edge locations (e.g., SEA where the user's browser requests hit).

This causes the job status page to show stale data:
- Queue consumer writes `status: "fetching_metadata"` at 2:03:40
- User's browser reads `status: "queued"` until 2:04:31
- ~50 second delay

## Solution: Durable Objects

Durable Objects provide **strong consistency** - reads always see the latest write, regardless of which edge location handles the request.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   POST /submit  │────▶│   JobStatus DO       │◀────│  GET /job/:id   │
│   (creates job) │     │   (single instance)  │     │  (reads status) │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
                               ▲
                               │
                        ┌──────┴──────┐
                        │ Queue       │
                        │ Consumer    │
                        │ (updates)   │
                        └─────────────┘
```

Each job gets its own Durable Object instance, identified by the job ID. All reads and writes for that job go to the same instance, ensuring consistency.

## Implementation

### 1. Define the Durable Object Class

```typescript
// src/durable-objects/job-status.ts

import type { Job, JobStatus } from "../types";

export class JobStatusDO implements DurableObject {
    private state: DurableObjectState;
    private job: Job | null = null;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        
        switch (request.method) {
            case "GET":
                return this.getStatus();
            case "PUT":
                return this.updateStatus(request);
            case "POST":
                return this.createJob(request);
            case "DELETE":
                return this.deleteJob();
            default:
                return new Response("Method not allowed", { status: 405 });
        }
    }

    private async getStatus(): Promise<Response> {
        // Load from storage if not in memory
        if (!this.job) {
            this.job = await this.state.storage.get<Job>("job");
        }

        if (!this.job) {
            return new Response(JSON.stringify({ error: "Job not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify(this.job), {
            headers: { "Content-Type": "application/json" },
        });
    }

    private async createJob(request: Request): Promise<Response> {
        const job = await request.json<Job>();
        
        this.job = job;
        await this.state.storage.put("job", job);

        return new Response(JSON.stringify(job), {
            status: 201,
            headers: { "Content-Type": "application/json" },
        });
    }

    private async updateStatus(request: Request): Promise<Response> {
        if (!this.job) {
            this.job = await this.state.storage.get<Job>("job");
        }

        if (!this.job) {
            return new Response(JSON.stringify({ error: "Job not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
        }

        const update = await request.json<{
            status: JobStatus;
            error?: string;
            estimatedSeconds?: number;
        }>();

        this.job = {
            ...this.job,
            status: update.status,
            updatedAt: new Date().toISOString(),
            ...(update.error !== undefined && { error: update.error }),
            ...(update.estimatedSeconds !== undefined && { estimatedSeconds: update.estimatedSeconds }),
        };

        await this.state.storage.put("job", this.job);

        return new Response(JSON.stringify(this.job), {
            headers: { "Content-Type": "application/json" },
        });
    }

    private async deleteJob(): Promise<Response> {
        await this.state.storage.deleteAll();
        this.job = null;

        return new Response(null, { status: 204 });
    }
}
```

### 2. Update wrangler.toml

```toml
# Add Durable Object binding
[[durable_objects.bindings]]
name = "JOB_STATUS"
class_name = "JobStatusDO"

# Specify the Durable Object class migration
[[migrations]]
tag = "v1"
new_classes = ["JobStatusDO"]
```

### 3. Update Types

```typescript
// src/types.ts

export interface Env {
    TLDL_DATA: KVNamespace;
    TLDL_QUEUE: Queue<QueueMessage>;
    JOB_STATUS: DurableObjectNamespace;  // Add this
    OPENAI_API_KEY: string;
    MAX_EPISODE_MINUTES: string;
    CACHE_TTL_DAYS: string;
    DEFAULT_TEMPLATE: string;
}
```

### 4. Create Helper Functions

```typescript
// src/lib/job-status-do.ts

import type { Env, Job, JobStatus } from "../types";

/**
 * Get the Durable Object stub for a job
 */
function getJobStub(env: Env, jobId: string): DurableObjectStub {
    const id = env.JOB_STATUS.idFromName(jobId);
    return env.JOB_STATUS.get(id);
}

/**
 * Create a new job in the Durable Object
 */
export async function createJobDO(env: Env, job: Job): Promise<void> {
    const stub = getJobStub(env, job.id);
    await stub.fetch("https://do/job", {
        method: "POST",
        body: JSON.stringify(job),
    });
}

/**
 * Get job status from Durable Object
 */
export async function getJobDO(env: Env, jobId: string): Promise<Job | null> {
    const stub = getJobStub(env, jobId);
    const response = await stub.fetch("https://do/job");
    
    if (response.status === 404) {
        return null;
    }
    
    return response.json<Job>();
}

/**
 * Update job status in Durable Object
 */
export async function updateJobStatusDO(
    env: Env,
    jobId: string,
    status: JobStatus,
    error?: string,
    estimatedSeconds?: number
): Promise<void> {
    const stub = getJobStub(env, jobId);
    await stub.fetch("https://do/job", {
        method: "PUT",
        body: JSON.stringify({ status, error, estimatedSeconds }),
    });
}
```

### 5. Export the Durable Object

```typescript
// src/index.ts

// Add export for the Durable Object class
export { JobStatusDO } from "./durable-objects/job-status";
```

### 6. Update Routes and Consumer

Replace KV job operations with DO operations:

```typescript
// In routes/public.ts - GET /job/:jobId
const job = await getJobDO(c.env, jobId);  // Instead of getJob(kv, jobId)

// In routes/authenticated.ts - POST /submit
await createJobDO(c.env, job);  // Instead of createJob(kv, job)

// In queue/consumer.ts
await updateJobStatusDO(env, jobId, "fetching_metadata");  // Instead of updateJobStatus()
```

## Hybrid Approach

For cost optimization, use a hybrid approach:

1. **Durable Objects** for jobs (short-lived, real-time status needed)
2. **KV** for episodes, transcripts, summaries (long-lived, eventual consistency OK)

```typescript
// Job lifecycle:
// 1. Create job in DO (immediate consistency for status polling)
// 2. Process job (update status in DO)
// 3. On completion: save episode/transcript/summary to KV
// 4. Delete job from DO (or let it expire)

// Optional: Also write job to KV for persistence/analytics
await Promise.all([
    updateJobStatusDO(env, jobId, "completed"),
    updateJobStatus(kv, jobId, "completed"),  // Backup in KV
]);
```

## Cost Considerations

Durable Objects pricing (as of 2024):
- **Requests**: $0.15 per million requests
- **Duration**: $12.50 per million GB-seconds
- **Storage**: $0.20 per GB-month

For a low-traffic app (< 10,000 jobs/month):
- Requests: ~50,000 (create + 10 status polls + updates) = $0.01
- Duration: Minimal (each request < 10ms)
- Storage: Negligible (jobs are small and short-lived)

**Estimated cost: < $1/month for typical usage**

## Migration Path

1. Deploy both systems in parallel (DO for status, KV as backup)
2. Read from DO, fallback to KV if DO returns 404
3. Once stable, remove KV for job status reads

```typescript
async function getJobWithFallback(env: Env, kv: KVNamespace, jobId: string): Promise<Job | null> {
    // Try DO first (strongly consistent)
    const doJob = await getJobDO(env, jobId);
    if (doJob) return doJob;
    
    // Fallback to KV (for jobs created before migration)
    return getJob(kv, jobId);
}
```

## WebSocket Alternative

For truly real-time updates, combine DO with WebSockets:

```typescript
// In JobStatusDO
private sessions: Set<WebSocket> = new Set();

async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        
        server.accept();
        this.sessions.add(server);
        
        server.addEventListener("close", () => {
            this.sessions.delete(server);
        });
        
        return new Response(null, { status: 101, webSocket: client });
    }
    // ... existing logic
}

private broadcast(data: object): void {
    const message = JSON.stringify(data);
    for (const session of this.sessions) {
        try {
            session.send(message);
        } catch {
            this.sessions.delete(session);
        }
    }
}

// When status updates, broadcast to all connected clients
private async updateStatus(request: Request): Promise<Response> {
    // ... update logic ...
    
    // Push to all connected clients
    this.broadcast({ type: "status_update", job: this.job });
    
    return new Response(JSON.stringify(this.job), {
        headers: { "Content-Type": "application/json" },
    });
}
```

This would give sub-100ms status updates to the browser.

## Conclusion

Durable Objects solve the eventual consistency problem at minimal cost for low-traffic apps. The implementation is straightforward and can be done incrementally. For the highest-performance real-time experience, combine with WebSockets for push-based updates.
