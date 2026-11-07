/**
 * Production KV access for local maintenance scripts, via the wrangler CLI.
 *
 * Every call passes --remote: without it wrangler silently reads and writes the
 * local .wrangler/state simulator instead of production.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const KV_NAMESPACE = "ee123158d5d54359b4257f8a1b678adf"; // TLDL_DATA (prod), see wrangler.toml
export const CONTENT_TTL_SECONDS = 31536000; // 365 days, matches TTL.CONTENT

/** Cloudflare's bulk-read API accepts at most 100 keys per request. */
const BULK_GET_CHUNK = 100;

function wrangler(args: string[], opts: { capture: true }): string;
function wrangler(args: string[], opts?: { capture?: false }): void;
function wrangler(args: string[], { capture = false }: { capture?: boolean } = {}): string | void {
    const fullArgs = ["wrangler", "kv", ...args, "--namespace-id", KV_NAMESPACE, "--remote"];
    if (capture) {
        return execFileSync("npx", fullArgs, {
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
            cwd: REPO_ROOT,
        });
    }
    execFileSync("npx", fullArgs, { stdio: ["ignore", "ignore", "inherit"], cwd: REPO_ROOT });
}

function tempJsonFile(value: unknown): string {
    const file = join(mkdtempSync(join(tmpdir(), "tldl-kv-")), "value.json");
    writeFileSync(file, JSON.stringify(value));
    return file;
}

/**
 * Read a KV key. Returns null when the key is absent.
 *
 * Note: `wrangler kv key get` on a missing key exits non-zero AND prints its 404
 * to stdout, so "did I get bytes back?" is not a valid existence check. We rely
 * on the exit code (execFileSync throws) and discard stderr entirely.
 */
export function kvGet(key: string): string | null {
    try {
        return wrangler(["key", "get", key], { capture: true });
    } catch {
        return null;
    }
}

export function kvGetJson<T>(key: string): T | null {
    const raw = kvGet(key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new Error(`KV key ${key} did not contain valid JSON (got ${raw.length} bytes)`);
    }
}

/**
 * Write a KV value from a temp file.
 *
 * `ttlSeconds` omitted means no expiry — required for `monitored:*` records,
 * which must never be scheduled for deletion. Content keys pass CONTENT_TTL_SECONDS.
 * The flag is `--ttl`; `--expiration-ttl` hard-errors on wrangler 4.x.
 */
export function kvPutJson(key: string, value: unknown, ttlSeconds?: number): void {
    const args = ["key", "put", key, "--path", tempJsonFile(value)];
    if (ttlSeconds !== undefined) args.push("--ttl", String(ttlSeconds));
    wrangler(args);
}

/**
 * Read many keys, parsed as JSON. Absent keys map to null.
 *
 * `wrangler kv bulk get` prints a JSON object of key -> raw string (null when
 * absent) followed by a trailing "Success!" line, so only the leading object
 * is parsed.
 */
export function kvBulkGetJson<T>(keys: string[]): Map<string, T | null> {
    const out = new Map<string, T | null>();
    for (let i = 0; i < keys.length; i += BULK_GET_CHUNK) {
        const chunk = keys.slice(i, i + BULK_GET_CHUNK);
        const raw = wrangler(["bulk", "get", tempJsonFile(chunk)], { capture: true });
        const objectEnd = raw.lastIndexOf("}");
        const values = JSON.parse(raw.slice(raw.indexOf("{"), objectEnd + 1)) as Record<string, string | null>;
        for (const key of chunk) {
            const value = values[key];
            out.set(key, value == null ? null : (JSON.parse(value) as T));
        }
    }
    return out;
}

/** Write many JSON values in one call. Omit ttlSeconds only for keys that must never expire. */
export function kvBulkPutJson(entries: Array<{ key: string; value: unknown }>, ttlSeconds?: number): void {
    if (entries.length === 0) return;
    const payload = entries.map(({ key, value }) => ({
        key,
        value: JSON.stringify(value),
        ...(ttlSeconds !== undefined && { expiration_ttl: ttlSeconds }),
    }));
    wrangler(["bulk", "put", tempJsonFile(payload)]);
}
