/**
 * Discord Webhook Helper
 *
 * Sends notifications to a Discord channel via webhook.
 * Used for proactive monitoring alerts (job failures, monitoring errors).
 * All calls are non-critical — failures are logged but never thrown.
 */

export interface DiscordNotification {
    title: string;
    description: string;
    color?: number;
}

/** Discord embed color constants */
export const DISCORD_COLORS = {
    ERROR: 0xff0000,
    SUCCESS: 0x22c55e,
    WARNING: 0xeab308,
    INFO: 0x3b82f6,
} as const;

/**
 * Send a notification to Discord via webhook.
 * Returns true if the message was sent successfully, false otherwise.
 * Never throws — failures are logged to console.
 */
export async function sendDiscordNotification(
    webhookUrl: string,
    notification: DiscordNotification
): Promise<boolean> {
    try {
        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                embeds: [
                    {
                        title: notification.title,
                        description: truncate(notification.description, 2000),
                        color: notification.color ?? DISCORD_COLORS.INFO,
                        timestamp: new Date().toISOString(),
                        footer: {
                            text: "TLDL Monitoring",
                        },
                    },
                ],
            }),
        });

        if (!response.ok) {
            console.error(
                JSON.stringify({
                    event: "discord_webhook_failed",
                    status: response.status,
                    statusText: response.statusText,
                })
            );
            return false;
        }

        return true;
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "discord_webhook_error",
                error: error instanceof Error ? error.message : String(error),
            })
        );
        return false;
    }
}

/**
 * Send a Discord notification if the webhook URL is configured.
 * No-op if DISCORD_WEBHOOK_URL is not set.
 */
export async function notifyDiscord(
    webhookUrl: string | undefined,
    notification: DiscordNotification
): Promise<void> {
    if (!webhookUrl) return;
    await sendDiscordNotification(webhookUrl, notification);
}

/** Truncate a string to a maximum length, appending "..." if truncated. */
function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + "...";
}
