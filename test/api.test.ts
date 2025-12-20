import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { saveEpisode, saveTranscript, saveSummary } from "../src/lib/kv";
import type { Episode, Transcript, Summary } from "../src/types";

// Response types for type-safe assertions
interface EpisodeListItem {
    id: string;
    podcastName: string;
    episodeTitle: string;
    episodeDate: string;
    episodeDuration: number;
    summaryTemplates: string[];
    createdAt: string;
    expiresAt: string;
}

interface SummaryDetail {
    templateId: string;
    templateName: string;
    text: string;
    createdAt: string;
}

interface TranscriptDetail {
    text: string;
    source: string;
    createdAt: string;
}

interface TemplateListItem {
    id: string;
    name: string;
    description: string;
}

// Helper to create a sample episode
function createSampleEpisode(overrides: Partial<Episode> = {}): Episode {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    return {
        id: "123_456",
        appleUrl: "https://podcasts.apple.com/us/podcast/test/id123?i=456",
        podcastName: "Test Podcast",
        episodeTitle: "Test Episode",
        episodeDuration: 2700,
        episodeDate: "2024-01-15",
        audioUrl: "https://example.com/audio.mp3",
        transcriptSource: "rss",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...overrides,
    };
}

// Helper to create a sample transcript
function createSampleTranscript(
    overrides: Partial<Transcript> = {}
): Transcript {
    return {
        episodeId: "123_456",
        text: "This is a sample transcript text for the episode.",
        source: "rss",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// Helper to create a sample summary
function createSampleSummary(overrides: Partial<Summary> = {}): Summary {
    return {
        episodeId: "123_456",
        templateId: "key-takeaways",
        text: "# Key Takeaways\n\nThis is a sample summary.",
        model: "gpt-5.2",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// Helper to clear all test data
async function clearTestData() {
    const prefixes = ["episode:", "transcript:", "summary:"];
    for (const prefix of prefixes) {
        const keys = await env.TLDL_DATA.list({ prefix });
        await Promise.all(keys.keys.map((k) => env.TLDL_DATA.delete(k.name)));
    }
}

describe("GET /api/episodes", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("returns empty array when no episodes exist", async () => {
        const response = await SELF.fetch("http://localhost/api/episodes");
        expect(response.status).toBe(200);

        const data = (await response.json()) as { episodes: EpisodeListItem[] };
        expect(data.episodes).toEqual([]);
    });

    it("returns list of episodes with summary templates", async () => {
        // Create episode with summaries
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const summary1 = createSampleSummary({
            episodeId: episode.id,
            templateId: "key-takeaways",
        });
        const summary2 = createSampleSummary({
            episodeId: episode.id,
            templateId: "eli5",
        });
        await saveSummary(env.TLDL_DATA, summary1);
        await saveSummary(env.TLDL_DATA, summary2);

        const response = await SELF.fetch("http://localhost/api/episodes");
        expect(response.status).toBe(200);

        const data = (await response.json()) as { episodes: EpisodeListItem[] };
        expect(data.episodes).toHaveLength(1);
        expect(data.episodes[0].id).toBe(episode.id);
        expect(data.episodes[0].podcastName).toBe("Test Podcast");
        expect(data.episodes[0].episodeTitle).toBe("Test Episode");
        expect(data.episodes[0].summaryTemplates).toContain("key-takeaways");
        expect(data.episodes[0].summaryTemplates).toContain("eli5");
    });

    it("returns episodes sorted by most recent first", async () => {
        const olderEpisode = createSampleEpisode({
            id: "older-episode",
            episodeTitle: "Older Episode",
            createdAt: "2024-01-01T00:00:00Z",
        });
        const newerEpisode = createSampleEpisode({
            id: "newer-episode",
            episodeTitle: "Newer Episode",
            createdAt: "2024-06-01T00:00:00Z",
        });

        await saveEpisode(env.TLDL_DATA, olderEpisode);
        await saveEpisode(env.TLDL_DATA, newerEpisode);

        const response = await SELF.fetch("http://localhost/api/episodes");
        const data = (await response.json()) as { episodes: EpisodeListItem[] };

        expect(data.episodes).toHaveLength(2);
        expect(data.episodes[0].id).toBe("newer-episode");
        expect(data.episodes[1].id).toBe("older-episode");
    });

    it("includes all required fields in episode list items", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch("http://localhost/api/episodes");
        const data = (await response.json()) as { episodes: EpisodeListItem[] };

        const item = data.episodes[0];
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("podcastName");
        expect(item).toHaveProperty("episodeTitle");
        expect(item).toHaveProperty("episodeDate");
        expect(item).toHaveProperty("episodeDuration");
        expect(item).toHaveProperty("summaryTemplates");
        expect(item).toHaveProperty("createdAt");
        expect(item).toHaveProperty("expiresAt");
    });
});

describe("GET /api/episode/:episodeId", () => {
    beforeEach(async () => {
        await clearTestData();
    });

    it("returns 404 for non-existent episode", async () => {
        const response = await SELF.fetch(
            "http://localhost/api/episode/non-existent"
        );
        expect(response.status).toBe(404);

        const data = (await response.json()) as { error: string };
        expect(data.error).toBe("Episode not found");
    });

    it("returns episode with full details", async () => {
        const episode = createSampleEpisode();
        const transcript = createSampleTranscript({ episodeId: episode.id });
        const summary = createSampleSummary({ episodeId: episode.id });

        await saveEpisode(env.TLDL_DATA, episode);
        await saveTranscript(env.TLDL_DATA, transcript);
        await saveSummary(env.TLDL_DATA, summary);

        const response = await SELF.fetch(
            `http://localhost/api/episode/${episode.id}`
        );
        expect(response.status).toBe(200);

        const data = (await response.json()) as {
            episode: Episode;
            summaries: SummaryDetail[];
            transcript: TranscriptDetail | null;
        };

        // Check episode data
        expect(data.episode.id).toBe(episode.id);
        expect(data.episode.podcastName).toBe("Test Podcast");
        expect(data.episode.episodeTitle).toBe("Test Episode");

        // Check transcript data
        expect(data.transcript).not.toBeNull();
        expect(data.transcript!.text).toBe(transcript.text);
        expect(data.transcript!.source).toBe("rss");

        // Check summaries data
        expect(data.summaries).toHaveLength(1);
        expect(data.summaries[0].templateId).toBe("key-takeaways");
        expect(data.summaries[0].templateName).toBe(
            "Key Takeaways & Practical Steps"
        );
        expect(data.summaries[0].text).toBe(summary.text);
    });

    it("returns episode without transcript if none exists", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const response = await SELF.fetch(
            `http://localhost/api/episode/${episode.id}`
        );
        const data = (await response.json()) as {
            episode: Episode;
            summaries: SummaryDetail[];
            transcript: TranscriptDetail | null;
        };

        expect(data.episode).toBeDefined();
        expect(data.transcript).toBeNull();
        expect(data.summaries).toEqual([]);
    });

    it("returns multiple summaries for episode with different templates", async () => {
        const episode = createSampleEpisode();
        await saveEpisode(env.TLDL_DATA, episode);

        const summaries = [
            createSampleSummary({
                episodeId: episode.id,
                templateId: "key-takeaways",
                text: "Key takeaways summary",
                createdAt: "2024-01-01T00:00:00Z",
            }),
            createSampleSummary({
                episodeId: episode.id,
                templateId: "eli5",
                text: "ELI5 summary",
                createdAt: "2024-06-01T00:00:00Z",
            }),
            createSampleSummary({
                episodeId: episode.id,
                templateId: "narrative-summary",
                text: "Narrative summary",
                createdAt: "2024-03-01T00:00:00Z",
            }),
        ];

        for (const summary of summaries) {
            await saveSummary(env.TLDL_DATA, summary);
        }

        const response = await SELF.fetch(
            `http://localhost/api/episode/${episode.id}`
        );
        const data = (await response.json()) as {
            episode: Episode;
            summaries: SummaryDetail[];
            transcript: TranscriptDetail | null;
        };

        expect(data.summaries).toHaveLength(3);
        // Should be sorted by createdAt descending
        expect(data.summaries[0].templateId).toBe("eli5");
        expect(data.summaries[1].templateId).toBe("narrative-summary");
        expect(data.summaries[2].templateId).toBe("key-takeaways");
    });
});

describe("GET /api/templates", () => {
    it("returns all available templates", async () => {
        const response = await SELF.fetch("http://localhost/api/templates");
        expect(response.status).toBe(200);

        const data = (await response.json()) as { templates: TemplateListItem[] };

        expect(data.templates).toHaveLength(3);

        const templateIds = data.templates.map((t) => t.id);
        expect(templateIds).toContain("key-takeaways");
        expect(templateIds).toContain("narrative-summary");
        expect(templateIds).toContain("eli5");
    });

    it("includes id, name, and description for each template", async () => {
        const response = await SELF.fetch("http://localhost/api/templates");
        const data = (await response.json()) as { templates: TemplateListItem[] };

        for (const template of data.templates) {
            expect(template).toHaveProperty("id");
            expect(template).toHaveProperty("name");
            expect(template).toHaveProperty("description");
            expect(typeof template.id).toBe("string");
            expect(typeof template.name).toBe("string");
            expect(typeof template.description).toBe("string");
        }
    });

    it("does not expose the prompt in template list", async () => {
        const response = await SELF.fetch("http://localhost/api/templates");
        const data = (await response.json()) as { templates: TemplateListItem[] };

        for (const template of data.templates) {
            expect(template).not.toHaveProperty("prompt");
        }
    });

    it("returns correct template details", async () => {
        const response = await SELF.fetch("http://localhost/api/templates");
        const data = (await response.json()) as { templates: TemplateListItem[] };

        const keyTakeaways = data.templates.find((t) => t.id === "key-takeaways");
        expect(keyTakeaways!.name).toBe("Key Takeaways & Practical Steps");
        expect(keyTakeaways!.description).toBe(
            "For craft and professional development podcasts"
        );

        const eli5 = data.templates.find((t) => t.id === "eli5");
        expect(eli5!.name).toBe("ELI5 (Explain Like I'm 5)");
        expect(eli5!.description).toBe("For technical and complex topics");
    });
});
