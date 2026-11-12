/**
 * Tests for the log-safe URL and header helpers (src/lib/log-urls.ts).
 */

import { describe, it, expect } from "vitest";
import { loggableHeaders, urlHost, urlPath } from "../src/lib/log-urls";

const SIGNED = "https://substackcdn.example.com/feed/podcast/1/ep.mp3?Expires=1789000000&Signature=s3cr3t&Key-Pair-Id=K2";

describe("urlHost / urlPath", () => {
    it("return the hostname and the path, never the query", () => {
        expect(urlHost(SIGNED)).toBe("substackcdn.example.com");
        expect(urlPath(SIGNED)).toBe("/feed/podcast/1/ep.mp3");
    });

    it("don't throw on a URL that doesn't parse", () => {
        expect(urlHost("not a url?Signature=s3cr3t")).toBe("(unparseable URL)");
        expect(urlPath("not a url?Signature=s3cr3t")).toBe("(unparseable URL)");
    });
});

describe("loggableHeaders", () => {
    it("keeps only the allowlisted headers", () => {
        const headers = new Headers({
            "Content-Type": "application/xml",
            "content-length": "123",
            "content-range": "bytes 0-1/2",
            "retry-after": "30",
            "cf-ray": "8abc-LHR",
            server: "AmazonS3",
            location: SIGNED,
            "set-cookie": "session=abc",
            "x-amz-request-id": "REQ",
        });

        expect(loggableHeaders(headers)).toEqual({
            "content-type": "application/xml",
            "content-length": "123",
            "content-range": "bytes 0-1/2",
            "retry-after": "30",
            "cf-ray": "8abc-LHR",
            server: "AmazonS3",
        });
    });
});
