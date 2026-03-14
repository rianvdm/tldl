/**
 * Public API Routes
 * Read-only endpoints accessible without authentication
 */

import { Hono } from "hono";
import type { HonoEnv, Episode } from "../types";
import {
    listEpisodes,
    getEpisode,
    getTranscript,
    listSummariesForEpisode,
} from "../lib/kv";
import { TEMPLATES, getTemplate } from "../lib/constants";

const api = new Hono<HonoEnv>();

// ============================================================================
// Response Types
// ============================================================================

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

interface EpisodeListResponse {
    episodes: EpisodeListItem[];
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

interface EpisodeDetailResponse {
    episode: Episode;
    summaries: SummaryDetail[];
    transcript: TranscriptDetail | null;
}

interface TemplateListItem {
    id: string;
    name: string;
    description: string;
}

interface TemplateListResponse {
    templates: TemplateListItem[];
}

// ============================================================================
// GET /api/episodes - List all completed episodes
// ============================================================================

api.get("/episodes", async (c) => {
    const { episodes } = await listEpisodes(c.env.TLDL_DATA);

    // For each episode, get the list of available summary templates
    const episodeListItems: EpisodeListItem[] = await Promise.all(
        episodes.map(async (episode) => {
            const summaries = await listSummariesForEpisode(
                c.env.TLDL_DATA,
                episode.id
            );
            const summaryTemplates = summaries.map((s) => s.templateId);

            return {
                id: episode.id,
                podcastName: episode.podcastName,
                episodeTitle: episode.episodeTitle,
                episodeDate: episode.episodeDate,
                episodeDuration: episode.episodeDuration,
                summaryTemplates,
                createdAt: episode.createdAt,
                expiresAt: episode.expiresAt,
            };
        })
    );

    const response: EpisodeListResponse = {
        episodes: episodeListItems,
    };

    return c.json(response);
});

// ============================================================================
// GET /api/episode/:episodeId - Get single episode with summary and transcript
// ============================================================================

api.get("/episode/:episodeId", async (c) => {
    const episodeId = c.req.param("episodeId");

    // Fetch episode
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Fetch transcript
    const transcript = await getTranscript(c.env.TLDL_DATA, episodeId);

    // Fetch all summaries for this episode
    const summaries = await listSummariesForEpisode(c.env.TLDL_DATA, episodeId);

    // Transform summaries to include template name
    const summaryDetails: SummaryDetail[] = summaries.map((summary) => {
        const template = getTemplate(summary.templateId);
        return {
            templateId: summary.templateId,
            templateName: template?.name || summary.templateId,
            text: summary.text,
            createdAt: summary.createdAt,
        };
    });

    // Transform transcript
    const transcriptDetail: TranscriptDetail | null = transcript
        ? {
              text: transcript.text,
              source: transcript.source,
              createdAt: transcript.createdAt,
          }
        : null;

    const response: EpisodeDetailResponse = {
        episode,
        summaries: summaryDetails,
        transcript: transcriptDetail,
    };

    return c.json(response);
});

// ============================================================================
// GET /api/templates - List available summary templates
// ============================================================================

api.get("/templates", (c) => {
    const templateList: TemplateListItem[] = Object.values(TEMPLATES).map(
        (template) => ({
            id: template.id,
            name: template.name,
            description: template.description,
        })
    );

    const response: TemplateListResponse = {
        templates: templateList,
    };

    return c.json(response);
});

// ============================================================================
// GET /api/episode/:episodeId/transcript.txt - Download transcript as text file
// ============================================================================

api.get("/episode/:episodeId/transcript.txt", async (c) => {
    const episodeId = c.req.param("episodeId");

    // Fetch episode for filename
    const episode = await getEpisode(c.env.TLDL_DATA, episodeId);
    if (!episode) {
        return c.json({ error: "Episode not found" }, 404);
    }

    // Fetch transcript
    const transcript = await getTranscript(c.env.TLDL_DATA, episodeId);
    if (!transcript) {
        return c.json({ error: "Transcript not found" }, 404);
    }

    // Create a safe filename from episode title
    const safeTitle = episode.episodeTitle
        .replace(/[^a-zA-Z0-9\s-]/g, "") // Remove special characters
        .replace(/\s+/g, "-") // Replace spaces with dashes
        .substring(0, 100); // Limit length
    const filename = `${safeTitle}-transcript.txt`;

    // Return as downloadable text file
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);

    return c.body(transcript.text);
});

export default api;
