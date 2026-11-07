import { describe, it, expect } from "vitest";
import { planEpisodeLinks, type PodcastLinkSources } from "../scripts/lib/episode-links-plan";
import { deriveRssEpisodeId } from "../src/lib/rss-episode-id";
import type { Episode } from "../src/types";

const PID = "1769051199";
const GUID = "substack:post:223203725";
const APPLE_URL = `https://podcasts.apple.com/us/podcast/scaling-slack/id${PID}?i=1000800061661`;

function sources(overrides: Partial<PodcastLinkSources> = {}): PodcastLinkSources {
    return {
        feed: {
            title: "The Pragmatic Engineer",
            link: "https://newsletter.pragmaticengineer.com/podcast",
            episodes: [{
                guid: GUID,
                title: "Scaling Slack and GitHub with Maude Lemaire",
                pubDate: "2026-11-05T15:58:00.000Z",
                duration: 3600,
                audioUrl: "https://api.substack.com/feed/podcast/223203725/abc.mp3?token=1",
                link: "https://newsletter.pragmaticengineer.com/p/scaling-slack-and-github-with-maude",
            }],
        },
        appleEpisodes: [{ guid: GUID, trackId: 1000800061661, title: "Scaling Slack and GitHub with Maude Lemaire", url: APPLE_URL }],
        ...overrides,
    };
}

function episode(overrides: Partial<Episode> = {}): Episode {
    return {
        id: `${PID}_rss_0000000000`,
        appleUrl: `https://podcasts.apple.com/us/podcast/id${PID}`,
        podcastName: "The Pragmatic Engineer",
        episodeTitle: "Scaling Slack and GitHub with Maude Lemaire",
        episodeDuration: 3600,
        episodeDate: "2026-11-05T15:58:00.000Z",
        audioUrl: "https://api.substack.com/feed/podcast/223203725/abc.mp3?token=2",
        transcriptSource: "openai",
        createdAt: "2026-11-05T16:30:00.000Z",
        expiresAt: "2027-11-05T16:30:00.000Z",
        ...overrides,
    };
}

describe("planEpisodeLinks", () => {
    it("fills every link for a cron episode, finding its GUID by hashing feed GUIDs", async () => {
        const id = await deriveRssEpisodeId(PID, GUID);

        const plan = await planEpisodeLinks(episode({ id, episodeTitle: "Retitled since" }), sources());

        expect(plan.matchedBy).toBe("rss-id-hash");
        expect(plan.changes).toEqual({
            episodeGuid: GUID,
            appleUrl: APPLE_URL,
            episodePageUrl: "https://newsletter.pragmaticengineer.com/p/scaling-slack-and-github-with-maude",
            podcastWebsiteUrl: "https://newsletter.pragmaticengineer.com/podcast",
        });
    });

    it("finds the GUID of an Apple-submitted episode from its Apple ID and keeps its Apple URL", async () => {
        const appleSubmitted = episode({
            id: `${PID}_1000800061661`,
            appleUrl: `https://podcasts.apple.com/us/podcast/scaling-slack/id${PID}?i=1000800061661`,
            episodeTitle: "Different title",
        });

        const plan = await planEpisodeLinks(appleSubmitted, sources());

        expect(plan.matchedBy).toBe("apple-id");
        expect(plan.changes.episodeGuid).toBe(GUID);
        expect("appleUrl" in plan.changes).toBe(false);
    });

    it("replaces an Apple URL built from a Podcast Index ID, matching on audio URL", async () => {
        const piQueued = episode({
            id: `${PID}_62880121466`,
            appleUrl: `https://podcasts.apple.com/us/podcast/podcast/id${PID}?i=62880121466`,
            episodeTitle: "Different title",
        });

        const plan = await planEpisodeLinks(piQueued, sources());

        expect(plan.matchedBy).toBe("audio-url");
        expect(plan.changes.appleUrl).toBe(APPLE_URL);
    });

    it("falls back to an exact title match", async () => {
        const plan = await planEpisodeLinks(episode({ audioUrl: "https://elsewhere.example/x.mp3" }), sources());
        expect(plan.matchedBy).toBe("title");
        expect(plan.changes.episodeGuid).toBe(GUID);
    });

    it("trusts a GUID already stored on the episode", async () => {
        const plan = await planEpisodeLinks(
            episode({ episodeGuid: GUID, audioUrl: "https://elsewhere.example/x.mp3", episodeTitle: "?" }),
            sources()
        );
        expect(plan.matchedBy).toBe("stored");
        expect("episodeGuid" in plan.changes).toBe(false);
    });

    it("removes an Apple listing stored as the website when no real website is known", async () => {
        const plan = await planEpisodeLinks(
            episode({ podcastWebsiteUrl: "https://podcasts.apple.com/us/podcast/x/id1" }),
            sources({ feed: { ...sources().feed!, link: "https://feeds.acast.com/public/shows/x" } })
        );
        expect("podcastWebsiteUrl" in plan.changes).toBe(true);
        expect(plan.changes.podcastWebsiteUrl).toBeUndefined();
    });

    it("keeps a valid stored website when the feed has no usable one", async () => {
        const plan = await planEpisodeLinks(
            episode({ podcastWebsiteUrl: "https://www.platformer.news" }),
            sources({ feed: { ...sources().feed!, link: "https://feeds.acast.com/public/shows/platformer" } })
        );
        expect("podcastWebsiteUrl" in plan.changes).toBe(false);
    });

    it("keeps a valid stored website even when the feed links somewhere else", async () => {
        // Pod Save America: stored crooked.com, feed <link> is its audioboom host page.
        const plan = await planEpisodeLinks(
            episode({ podcastWebsiteUrl: "https://crooked.com" }),
            sources({ feed: { ...sources().feed!, link: "https://audioboom.com/channels/5166624" } })
        );
        expect("podcastWebsiteUrl" in plan.changes).toBe(false);
    });

    it("still fixes the website when the episode cannot be matched", async () => {
        const plan = await planEpisodeLinks(
            episode({ episodeTitle: "Not in feed", audioUrl: "https://elsewhere.example/x.mp3" }),
            sources()
        );
        expect(plan.matchedBy).toBeNull();
        expect(plan.changes).toEqual({ podcastWebsiteUrl: "https://newsletter.pragmaticengineer.com/podcast" });
    });

    it("plans no changes when everything is already right", async () => {
        const plan = await planEpisodeLinks(episode({
            episodeGuid: GUID,
            appleUrl: APPLE_URL,
            episodePageUrl: "https://newsletter.pragmaticengineer.com/p/scaling-slack-and-github-with-maude",
            podcastWebsiteUrl: "https://newsletter.pragmaticengineer.com/podcast",
        }), sources());
        expect(plan.changes).toEqual({});
    });
});
