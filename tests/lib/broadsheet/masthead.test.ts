import { describe, it, expect } from "vitest";
import { computeVolume, computeIssueNumber } from "../../../src/lib/broadsheet/masthead";

describe("computeVolume", () => {
    it("returns Vol. I in the launch year", () => {
        expect(computeVolume(2024)).toBe("I");
    });
    it("returns Vol. II one year later", () => {
        expect(computeVolume(2025)).toBe("II");
    });
    it("returns Vol. III two years later", () => {
        expect(computeVolume(2026)).toBe("III");
    });
    it("returns Vol. X after nine years", () => {
        expect(computeVolume(2033)).toBe("X");
    });
});

describe("computeIssueNumber", () => {
    it("returns ISO week for early January", () => {
        expect(computeIssueNumber(new Date("2026-01-05T12:00:00Z"))).toBe(2);
    });
    it("returns week 1 when Jan 4 falls in week 1", () => {
        expect(computeIssueNumber(new Date("2026-01-04T12:00:00Z"))).toBe(1);
    });
    it("returns week 52 for a late-December date", () => {
        expect(computeIssueNumber(new Date("2024-12-23T12:00:00Z"))).toBe(52);
    });
    it("returns week 53 when the year has one", () => {
        expect(computeIssueNumber(new Date("2020-12-28T12:00:00Z"))).toBe(53);
    });
});
