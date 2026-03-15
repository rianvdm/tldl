/**
 * Postmark Email Service
 *
 * Minimal client for sending transactional email via Postmark's API.
 * Used for the "Request a Podcast" contact form.
 */

export interface SendEmailOptions {
    from: string;
    to: string;
    subject: string;
    textBody: string;
    htmlBody?: string;
    messageStream?: string;
}

interface PostmarkErrorResponse {
    ErrorCode: number;
    Message: string;
}

/**
 * Send an email via Postmark.
 * Returns { success: true } on success, or { success: false, errorMessage } on failure.
 * Never throws.
 */
export async function sendEmail(
    apiKey: string,
    options: SendEmailOptions
): Promise<{ success: boolean; errorMessage?: string }> {
    try {
        const response = await fetch("https://api.postmarkapp.com/email", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Postmark-Server-Token": apiKey,
            },
            body: JSON.stringify({
                From: options.from,
                To: options.to,
                Subject: options.subject,
                TextBody: options.textBody,
                HtmlBody: options.htmlBody,
                MessageStream: options.messageStream,
            }),
        });

        if (!response.ok) {
            const error = await response.json() as PostmarkErrorResponse;
            console.error(JSON.stringify({
                event: "postmark_send_failed",
                status: response.status,
                errorCode: error.ErrorCode,
                message: error.Message,
            }));
            return { success: false, errorMessage: error.Message || "Failed to send email" };
        }

        return { success: true };
    } catch (error) {
        console.error(JSON.stringify({
            event: "postmark_send_error",
            error: error instanceof Error ? error.message : String(error),
        }));
        return { success: false, errorMessage: "Failed to send email" };
    }
}
