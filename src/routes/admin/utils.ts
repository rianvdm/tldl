/**
 * Shared utilities for admin views.
 */

export function generateUUID(): string {
    return crypto.randomUUID();
}

export function isValidUrl(s: string): boolean {
    try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

export function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

export function formatRelativeTime(input: string | number): string {
    const now = Date.now();
    const then = typeof input === "number"
        // Treat numbers <1e12 as seconds (unix), otherwise ms
        ? (input < 1e12 ? input * 1000 : input)
        : new Date(input).getTime();
    const diffMs = now - then;
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return "just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(then));
}

export function formatDate(dateString: string | number): string {
    const ms = typeof dateString === "number"
        ? (dateString < 1e12 ? dateString * 1000 : dateString)
        : new Date(dateString).getTime();
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(new Date(ms));
}

export type AdminTab =
    | "dashboard"
    | "episodes"
    | "podcasts"
    | "subscribers"
    | "activity"
    | "maintenance";
