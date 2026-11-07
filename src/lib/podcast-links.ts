/**
 * Outbound links shown on an episode page: the podcast's website, the
 * publisher's page for this episode, and Apple Podcasts.
 *
 * Feeds, Podcast Index and hand-edited records all supply these, and all of
 * them sometimes supply the wrong kind of URL (an Apple listing as the
 * "website", a feed URL, the audio file, a bare homepage repeated on every
 * item). Every writer goes through these helpers so the rules live in one place.
 */

const APPLE_HOSTS = new Set(["podcasts.apple.com", "itunes.apple.com"]);
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|oga|opus|wav|mp4)$/i;

function parseHttpUrl(raw: string | undefined): URL | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;
    try {
        const url = new URL(trimmed);
        return url.protocol === "https:" || url.protocol === "http:" ? url : null;
    } catch {
        return null;
    }
}

/** Apple listings and feed hosts are never a podcast's own web page. */
function isNonWebPageHost(url: URL): boolean {
    return APPLE_HOSTS.has(url.hostname) || url.hostname.startsWith("feeds.");
}

function isFeedPath(pathname: string): boolean {
    const p = pathname.toLowerCase();
    return (
        p.endsWith(".xml") ||
        p.endsWith(".rss") ||
        /\/(feed|rss)\/?$/.test(p) ||
        p.includes("/feed/") ||
        p.includes("/rss/")
    );
}

/** Compare URLs ignoring a trailing slash, which feeds use inconsistently. */
function sameUrl(a: string, b: string | undefined): boolean {
    if (!b) return false;
    const strip = (s: string) => s.trim().replace(/\/+$/, "");
    return strip(a) === strip(b);
}

/**
 * Normalise a candidate podcast website URL, or return undefined if it isn't one.
 * A feed URL on the podcast's own domain is cut back to its directory
 * (e.g. /podcast/rss.xml -> /podcast) since that is usually the show page.
 */
export function toWebsiteUrl(raw: string | undefined): string | undefined {
    const url = parseHttpUrl(raw);
    if (!url || isNonWebPageHost(url)) return undefined;
    if (!isFeedPath(url.pathname)) return raw!.trim();

    let pathname = url.pathname;
    if (/\.(xml|rss)$/i.test(pathname)) {
        pathname = pathname.substring(0, pathname.lastIndexOf("/"));
    }
    pathname = pathname.replace(/\/(feed|rss)\/?$/i, "");
    const middle = pathname.search(/\/(feed|rss)\//i);
    if (middle !== -1) pathname = pathname.substring(0, middle);

    return !pathname || pathname === "/" ? url.origin : `${url.origin}${pathname}`;
}

/**
 * Pick the website to store. A stored value that is already valid is kept:
 * feed <link>s are sometimes a hosting page (audioboom, buzzsprout) that is
 * worse than what an admin or an earlier source set. Otherwise the first valid
 * candidate wins, then a cleaned copy of the stored value, then nothing.
 */
export function resolveWebsiteUrl(stored: string | undefined, candidates: Array<string | undefined>): string | undefined {
    const cleanedStored = toWebsiteUrl(stored);
    if (cleanedStored && cleanedStored === stored?.trim()) return cleanedStored;
    for (const candidate of candidates) {
        const website = toWebsiteUrl(candidate);
        if (website) return website;
    }
    return cleanedStored;
}

/**
 * Validate an RSS item's <link> as a page about this specific episode.
 * Returns undefined for anything that isn't episode-specific.
 */
export function toEpisodePageUrl(
    raw: string | undefined,
    context: { websiteUrl?: string; audioUrl?: string } = {}
): string | undefined {
    const url = parseHttpUrl(raw);
    if (!url || isNonWebPageHost(url)) return undefined;
    if (url.pathname === "" || url.pathname === "/") return undefined;
    if (isFeedPath(url.pathname) || AUDIO_EXTENSIONS.test(url.pathname)) return undefined;

    const value = raw!.trim();
    if (sameUrl(value, context.websiteUrl) || sameUrl(value, context.audioUrl)) return undefined;
    return value;
}

/**
 * Apple Podcasts URL for the show as a whole. Used until the episode's own
 * Apple URL is known (see apple-link-enrichment.ts).
 */
export function showLevelAppleUrl(podcastId: string): string | undefined {
    return /^\d+$/.test(podcastId) ? `https://podcasts.apple.com/us/podcast/id${podcastId}` : undefined;
}

/** True for an Apple Podcasts URL that points at the show, not an episode. */
export function isShowLevelAppleUrl(raw: string | undefined): boolean {
    const url = parseHttpUrl(raw);
    if (!url || !APPLE_HOSTS.has(url.hostname)) return false;
    return !url.searchParams.has("i") && /\/id\d+\/?$/.test(url.pathname);
}
