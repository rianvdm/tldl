import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/types";

vi.mock("../src/lib/monitor", () => ({ checkAllPodcasts: vi.fn() }));
vi.mock("../src/lib/apple-link-enrichment", () => ({ enrichAppleEpisodeLinks: vi.fn() }));
vi.mock("../src/lib/job-status-do", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/job-status-do")>()),
    listActiveJobsWithDO: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/lib/db", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/db")>()),
    sweepExpiredPending: vi.fn().mockResolvedValue(0),
}));

import worker from "../src/index";
import { checkAllPodcasts } from "../src/lib/monitor";
import { enrichAppleEpisodeLinks } from "../src/lib/apple-link-enrichment";

function runCron(): Promise<void> {
    const controller = { cron: "0 */2 * * *", scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController;
    return worker.scheduled(controller, env as unknown as Env, {} as ExecutionContext);
}

describe("scheduled handler: Apple link enrichment", () => {
    beforeEach(() => {
        vi.mocked(checkAllPodcasts).mockReset();
        vi.mocked(enrichAppleEpisodeLinks).mockReset().mockResolvedValue({ pending: 0, updated: 0 });
    });

    it("upgrades Apple links after checking podcasts", async () => {
        vi.mocked(checkAllPodcasts).mockResolvedValue({ checked: 0, totalNewEpisodes: 0, results: [], errors: [] });

        await runCron();

        expect(enrichAppleEpisodeLinks).toHaveBeenCalledTimes(1);
        expect(vi.mocked(checkAllPodcasts).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(enrichAppleEpisodeLinks).mock.invocationCallOrder[0]);
    });

    it("still upgrades Apple links when the podcast check throws", async () => {
        vi.mocked(checkAllPodcasts).mockRejectedValue(new Error("monitor down"));

        await runCron();

        expect(enrichAppleEpisodeLinks).toHaveBeenCalledTimes(1);
    });

    it("does not let an enrichment failure escape the cron", async () => {
        vi.mocked(checkAllPodcasts).mockResolvedValue({ checked: 0, totalNewEpisodes: 0, results: [], errors: [] });
        vi.mocked(enrichAppleEpisodeLinks).mockRejectedValue(new Error("apple down"));

        await expect(runCron()).resolves.toBeUndefined();
    });
});
