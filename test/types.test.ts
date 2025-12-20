import { describe, it, expect } from "vitest";
import type {
    Job,
    Episode,
    Transcript,
    Summary,
    JobStatus,
    TranscriptSource,
    QueueMessage,
} from "../src/types";
import {
    TEMPLATES,
    ERROR_CODES,
    TTL,
    getTemplateIds,
    isValidTemplateId,
    getTemplate,
} from "../src/lib/constants";

describe("Type Definitions", () => {
    describe("Job", () => {
        it("creates a valid job object", () => {
            const job: Job = {
                id: "550e8400-e29b-41d4-a716-446655440000",
                episodeId: "123456_789012",
                appleUrl: "https://podcasts.apple.com/us/podcast/example/id123456?i=789012",
                status: "queued",
                templateId: "key-takeaways",
                createdAt: "2024-12-20T10:00:00Z",
                updatedAt: "2024-12-20T10:00:00Z",
            };

            expect(job.id).toBeDefined();
            expect(job.status).toBe("queued");
        });

        it("supports all job statuses", () => {
            const statuses: JobStatus[] = [
                "queued",
                "fetching_metadata",
                "checking_transcript",
                "transcribing",
                "summarizing",
                "completed",
                "failed",
            ];

            statuses.forEach((status) => {
                const job: Job = {
                    id: "test-id",
                    episodeId: "ep-id",
                    appleUrl: "https://example.com",
                    status,
                    templateId: "key-takeaways",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                expect(job.status).toBe(status);
            });
        });

        it("supports optional error field", () => {
            const failedJob: Job = {
                id: "test-id",
                episodeId: "ep-id",
                appleUrl: "https://example.com",
                status: "failed",
                templateId: "key-takeaways",
                error: "Something went wrong",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };

            expect(failedJob.error).toBe("Something went wrong");
        });
    });

    describe("Episode", () => {
        it("creates a valid episode object", () => {
            const episode: Episode = {
                id: "123456_789012",
                appleUrl: "https://podcasts.apple.com/us/podcast/example/id123456?i=789012",
                podcastName: "Example Podcast",
                episodeTitle: "Episode 1: Getting Started",
                episodeDuration: 2700,
                episodeDate: "2024-12-15",
                audioUrl: "https://example.com/audio.mp3",
                transcriptSource: "rss",
                createdAt: "2024-12-20T10:00:00Z",
                expiresAt: "2025-12-20T10:00:00Z",
            };

            expect(episode.podcastName).toBe("Example Podcast");
            expect(episode.episodeDuration).toBe(2700);
        });

        it("supports all transcript sources", () => {
            const sources: TranscriptSource[] = ["apple", "rss", "openai"];

            sources.forEach((source) => {
                const episode: Episode = {
                    id: "test-id",
                    appleUrl: "https://example.com",
                    podcastName: "Test",
                    episodeTitle: "Test Episode",
                    episodeDuration: 1800,
                    episodeDate: "2024-12-20",
                    audioUrl: "https://example.com/audio.mp3",
                    transcriptSource: source,
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date().toISOString(),
                };
                expect(episode.transcriptSource).toBe(source);
            });
        });
    });

    describe("Transcript", () => {
        it("creates a valid transcript object", () => {
            const transcript: Transcript = {
                episodeId: "123456_789012",
                text: "This is the full transcript of the episode...",
                source: "openai",
                createdAt: "2024-12-20T10:30:00Z",
            };

            expect(transcript.text.length).toBeGreaterThan(0);
            expect(transcript.source).toBe("openai");
        });
    });

    describe("Summary", () => {
        it("creates a valid summary object", () => {
            const summary: Summary = {
                episodeId: "123456_789012",
                templateId: "key-takeaways",
                text: "## Key Takeaways\n\nThis episode covers...",
                model: "gpt-5.2",
                createdAt: "2024-12-20T10:35:00Z",
            };

            expect(summary.templateId).toBe("key-takeaways");
            expect(summary.model).toBe("gpt-5.2");
        });
    });

    describe("QueueMessage", () => {
        it("creates a valid queue message for new episode", () => {
            const message: QueueMessage = {
                type: "process_episode",
                jobId: "job-123",
                episodeId: "ep-456",
                appleUrl: "https://podcasts.apple.com/...",
                templateId: "key-takeaways",
            };

            expect(message.type).toBe("process_episode");
        });

        it("creates a valid queue message for regeneration", () => {
            const message: QueueMessage = {
                type: "regenerate_summary",
                jobId: "job-789",
                episodeId: "ep-456",
                appleUrl: "https://podcasts.apple.com/...",
                templateId: "eli5",
            };

            expect(message.type).toBe("regenerate_summary");
        });
    });
});

describe("Constants", () => {
    describe("Templates", () => {
        it("has three templates defined", () => {
            expect(Object.keys(TEMPLATES)).toHaveLength(3);
        });

        it("has key-takeaways template", () => {
            const template = TEMPLATES["key-takeaways"];
            expect(template).toBeDefined();
            expect(template.name).toBe("Key Takeaways & Practical Steps");
            expect(template.prompt.length).toBeGreaterThan(100);
        });

        it("has narrative-summary template", () => {
            const template = TEMPLATES["narrative-summary"];
            expect(template).toBeDefined();
            expect(template.name).toBe("Narrative Summary");
        });

        it("has eli5 template", () => {
            const template = TEMPLATES["eli5"];
            expect(template).toBeDefined();
            expect(template.name).toBe("ELI5 (Explain Like I'm 5)");
        });

        it("getTemplateIds returns all template IDs", () => {
            const ids = getTemplateIds();
            expect(ids).toContain("key-takeaways");
            expect(ids).toContain("narrative-summary");
            expect(ids).toContain("eli5");
        });

        it("isValidTemplateId validates correctly", () => {
            expect(isValidTemplateId("key-takeaways")).toBe(true);
            expect(isValidTemplateId("eli5")).toBe(true);
            expect(isValidTemplateId("invalid-template")).toBe(false);
            expect(isValidTemplateId("")).toBe(false);
        });

        it("getTemplate returns template or undefined", () => {
            expect(getTemplate("key-takeaways")).toBeDefined();
            expect(getTemplate("invalid")).toBeUndefined();
        });
    });

    describe("Error Codes", () => {
        it("has all required error codes", () => {
            expect(ERROR_CODES.INVALID_URL).toBe("INVALID_URL");
            expect(ERROR_CODES.EPISODE_NOT_FOUND).toBe("EPISODE_NOT_FOUND");
            expect(ERROR_CODES.EPISODE_TOO_LONG).toBe("EPISODE_TOO_LONG");
            expect(ERROR_CODES.AUDIO_UNAVAILABLE).toBe("AUDIO_UNAVAILABLE");
            expect(ERROR_CODES.TRANSCRIPTION_FAILED).toBe("TRANSCRIPTION_FAILED");
            expect(ERROR_CODES.SUMMARIZATION_FAILED).toBe("SUMMARIZATION_FAILED");
            expect(ERROR_CODES.RATE_LIMITED).toBe("RATE_LIMITED");
            expect(ERROR_CODES.UNKNOWN_ERROR).toBe("UNKNOWN_ERROR");
        });
    });

    describe("TTL", () => {
        it("has correct job TTL (7 days)", () => {
            expect(TTL.JOB).toBe(7 * 24 * 60 * 60);
        });

        it("has correct content TTL (365 days)", () => {
            expect(TTL.CONTENT).toBe(365 * 24 * 60 * 60);
        });
    });
});
