/**
 * JobStatusDO - Durable Object for Real-Time Job Status
 * 
 * Provides strong consistency for job status tracking, solving the
 * eventual consistency problem with KV where status updates could
 * take up to 60 seconds to propagate across edge locations.
 * 
 * Each job gets its own Durable Object instance, identified by job ID.
 * All reads and writes for that job go to the same instance.
 */

import type { Job, JobStatus } from "../types";

interface JobStatusUpdate {
    status: JobStatus;
    error?: string;
    estimatedSeconds?: number;
}

export class JobStatusDO implements DurableObject {
    private state: DurableObjectState;
    private job: Job | null = null;

    constructor(state: DurableObjectState, _env: unknown) {
        this.state = state;
    }

    async fetch(request: Request): Promise<Response> {
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

    /**
     * GET - Returns current job status
     */
    private async getStatus(): Promise<Response> {
        // Load from storage if not in memory
        if (!this.job) {
            this.job = await this.state.storage.get<Job>("job") ?? null;
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

    /**
     * POST - Create new job record
     */
    private async createJob(request: Request): Promise<Response> {
        const job = await request.json<Job>();

        this.job = job;
        await this.state.storage.put("job", job);

        return new Response(JSON.stringify(job), {
            status: 201,
            headers: { "Content-Type": "application/json" },
        });
    }

    /**
     * PUT - Update job status
     */
    private async updateStatus(request: Request): Promise<Response> {
        // Load from storage if not in memory
        if (!this.job) {
            this.job = await this.state.storage.get<Job>("job") ?? null;
        }

        if (!this.job) {
            return new Response(JSON.stringify({ error: "Job not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
        }

        const update = await request.json<JobStatusUpdate>();

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

    /**
     * DELETE - Clean up job data
     */
    private async deleteJob(): Promise<Response> {
        await this.state.storage.deleteAll();
        this.job = null;

        return new Response(null, { status: 204 });
    }
}
