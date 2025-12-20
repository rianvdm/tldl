/**
 * Custom Error class for TLDL application errors
 * Provides structured error information with machine-readable codes
 * and human-friendly messages.
 */

import type { ErrorCode } from "./constants";

export class AppError extends Error {
    public readonly code: ErrorCode;
    public readonly userMessage: string;
    public readonly cause?: Error;

    constructor(code: ErrorCode, userMessage: string, cause?: Error) {
        super(userMessage);
        this.name = "AppError";
        this.code = code;
        this.userMessage = userMessage;
        this.cause = cause;

        // Maintains proper stack trace for where error was thrown (V8 only)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }
    }

    /**
     * Create a JSON-serializable representation of the error
     */
    toJSON(): { code: ErrorCode; message: string; cause?: string } {
        return {
            code: this.code,
            message: this.userMessage,
            ...(this.cause && { cause: this.cause.message }),
        };
    }
}
