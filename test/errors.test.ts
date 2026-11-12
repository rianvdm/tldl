/**
 * AppError tests
 */

import { describe, it, expect } from "vitest";
import { AppError, ERROR_MESSAGES } from "../src/lib/errors";
import { ERROR_CODES } from "../src/lib/constants";

describe("AppError", () => {
    it("uses the message as the user message by default", () => {
        const error = new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, "Unsupported MP4");
        expect(error.message).toBe("Unsupported MP4");
        expect(error.userMessage).toBe("Unsupported MP4");
    });

    it("falls back to the code's default message", () => {
        const error = new AppError(ERROR_CODES.AUDIO_REJECTED);
        expect(error.message).toBe(ERROR_MESSAGES[ERROR_CODES.AUDIO_REJECTED]);
        expect(error.userMessage).toBe(ERROR_MESSAGES[ERROR_CODES.AUDIO_REJECTED]);
    });

    it("keeps a separate user message out of message and stack", () => {
        const cause = new Error("upstream body");
        const error = new AppError(
            ERROR_CODES.AUDIO_REJECTED,
            "gpt-transcribe rejected the audio",
            cause,
            "gpt-transcribe rejected the audio. Debug with: secret-command"
        );
        expect(error.message).toBe("gpt-transcribe rejected the audio");
        expect(error.stack).not.toContain("secret-command");
        expect(error.userMessage).toBe("gpt-transcribe rejected the audio. Debug with: secret-command");
        expect(error.cause).toBe(cause);
    });
});
