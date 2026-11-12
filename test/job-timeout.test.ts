/**
 * Stale-job sweep tests
 *
 * listActiveJobsWithDO() fails any active job older than TIMEOUTS.JOB_MS,
 * measured from createdAt. A killed 15-minute attempt plus a resumed attempt
 * and the summary must fit inside that window.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createJob, getJob } from "../src/lib/kv";
import { listActiveJobsWithDO } from "../src/lib/job-status-do";
import type { Env, Job } from "../src/types";

function jobCreatedMinutesAgo(id: string, minutes: number): Job {
    const createdAt = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    return {
        id,
        episodeId: `123_${id}`,
        appleUrl: "https://podcasts.apple.com/us/podcast/test-podcast/id123?i=456",
        status: "transcribing",
        templateId: "key-takeaways",
        createdAt,
        updatedAt: createdAt,
    };
}

describe("stale-job sweep", () => {
    beforeEach(async () => {
        const keys = await env.TLDL_DATA.list({ prefix: "job:" });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    });

    it("does not fail a 25-minute-old job and fails a 36-minute-old one", async () => {
        // Jobs exist only in KV: the DO returns 404 for them, so
        // listActiveJobsWithDO reads them through its KV fallback.
        await createJob(env.TLDL_DATA, jobCreatedMinutesAgo("timeout-25", 25));
        await createJob(env.TLDL_DATA, jobCreatedMinutesAgo("timeout-36", 36));

        await listActiveJobsWithDO(env as unknown as Env, env.TLDL_DATA);

        expect((await getJob(env.TLDL_DATA, "timeout-25"))?.status).toBe("transcribing");
        const stale = await getJob(env.TLDL_DATA, "timeout-36");
        expect(stale?.status).toBe("failed");
        expect(stale?.error).toMatch(/^Job timed out after 36 minutes/);
    });
});
