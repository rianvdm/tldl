import type { Env } from "./types";
import { sendTemplate } from "./services/postmark";
import { getMonitoredPodcast } from "./lib/kv";
import { listConfirmedSubscribersForPodcast } from "./lib/db";
import { signToken, manageMessage, unsubMessage } from "./lib/emailTokens";
import { renderMarkdown } from "./lib/markdown";

const BASE_URL = "https://tldl-pod.com";
const MONITOR_SUBMITTER = "monitor@tldl.app";
const BROADCAST_STREAM = "episode-summaries";

interface NotifyInput {
    podcastId: string;
    episode: {
        id: string;
        podcastName: string;
        episodeTitle: string;
        episodeDate: string;
        summaryText?: string;
        submittedBy?: string;
        podcastWebsiteUrl?: string;
    };
}

export async function notifySubscribers(env: Env, input: NotifyInput): Promise<void> {
    try {
        if (env.EMAIL_DISPATCH_ENABLED?.trim().toLowerCase() === "false") return;
        if (input.episode.submittedBy !== MONITOR_SUBMITTER) return;

        const podcast = await getMonitoredPodcast(env.TLDL_DATA, input.podcastId);
        if (!podcast) {
            console.log(JSON.stringify({ event: "notify_skip_orphan", podcastId: input.podcastId }));
            return;
        }

        const subscribers = await listConfirmedSubscribersForPodcast(env.DB, input.podcastId);
        if (subscribers.length === 0) return;

        const summaryHtml = input.episode.summaryText ? renderMarkdown(input.episode.summaryText) : "";
        const episodeDate = formatDate(input.episode.episodeDate);

        const results = await Promise.allSettled(subscribers.map(async (sub) => {
            const manageToken = await signToken(env.MANAGE_LINK_HMAC_SECRET, manageMessage(sub.id, sub.email));
            const unsubToken = await signToken(env.MANAGE_LINK_HMAC_SECRET, unsubMessage(sub.id, input.podcastId));
            const manageUrl = `${BASE_URL}/preferences/manage?s=${sub.id}&token=${manageToken}`;
            const unsubUrl = `${BASE_URL}/unsubscribe?s=${sub.id}&p=${encodeURIComponent(input.podcastId)}&token=${unsubToken}`;

            const model: Record<string, unknown> = {
                podcastName: podcast.name,
                episodeTitle: input.episode.episodeTitle,
                episodeDate,
                summaryHtml,
                summaryText: input.episode.summaryText ?? "",
                episodeUrl: `${BASE_URL}/episode/${input.episode.id}`,
                unsubscribePodcastUrl: unsubUrl,
                manageUrl,
            };

            const res = await sendTemplate(env.POSTMARK_API_KEY ?? "", {
                from: env.POSTMARK_FROM_EMAIL,
                to: sub.email,
                templateAlias: "episode-summary",
                templateModel: model,
                messageStream: BROADCAST_STREAM,
            });
            if (!res.success) {
                console.error(JSON.stringify({
                    event: "notify_send_failed", recipient_id: sub.id,
                    episode_id: input.episode.id, podcast_id: input.podcastId,
                    errorMessage: res.errorMessage,
                }));
            }
        }));

        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
            console.error(JSON.stringify({
                event: "notify_rejected", failed,
                podcast_id: input.podcastId,
                episode_id: input.episode.id,
            }));
        }
    } catch (error) {
        console.error(JSON.stringify({
            event: "notify_subscribers_error",
            podcastId: input.podcastId,
            error: error instanceof Error ? error.message : String(error),
        }));
    }
}

function formatDate(iso: string): string {
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })
            .format(new Date(iso));
    } catch {
        return iso;
    }
}
