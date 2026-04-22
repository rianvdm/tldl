import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown (email path)", () => {
    it("strips raw HTML", () => {
        expect(renderMarkdown("<script>alert(1)</script>hi")).not.toContain("<script>");
    });
    it("sanitises javascript: links", () => {
        const out = renderMarkdown("[click](javascript:alert(1))");
        expect(out).not.toContain("javascript:");
    });
    it("preserves safe markdown", () => {
        const out = renderMarkdown("**bold** and [ok](https://ok.example)");
        expect(out).toContain("<strong>bold</strong>");
        expect(out).toContain('href="https://ok.example"');
    });
});
