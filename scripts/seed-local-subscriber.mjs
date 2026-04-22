#!/usr/bin/env node
// Seed a test subscriber in local D1 and print signed URLs for every
// subscription-related route. Requires wrangler dev to have been started
// once (so the local D1 exists under .wrangler/state) but the server
// does not need to be running while this script executes.
//
// Usage:  node scripts/seed-local-subscriber.mjs
//
// Reads MANAGE_LINK_HMAC_SECRET from .dev.vars so the generated tokens
// match what the running Worker will verify.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHmac, webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = Object.fromEntries(
    readFileSync(".dev.vars", "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
);
const SECRET = env.MANAGE_LINK_HMAC_SECRET;
if (!SECRET) throw new Error("MANAGE_LINK_HMAC_SECRET missing from .dev.vars");

function sign(message) {
    return createHmac("sha256", SECRET).update(message).digest("hex").slice(0, 32);
}

const SUB_ID = 1;
const EMAIL = "test@example.com";
const PODCASTS = ["1627920305", "1769051199", "1809663079"]; // Lenny, Pragmatic Engineer, How I AI
const now = Math.floor(Date.now() / 1000);

// Build SQL as a single file to hand to wrangler d1 execute.
const sql = `
DELETE FROM subscriptions WHERE subscriber_id = ${SUB_ID};
DELETE FROM subscribers WHERE id = ${SUB_ID};
INSERT INTO subscribers (id, email, confirmed_at, created_at, updated_at, status)
    VALUES (${SUB_ID}, '${EMAIL}', ${now}, ${now}, ${now}, 'active');
${PODCASTS.map((p) => `INSERT INTO subscriptions (subscriber_id, podcast_id, created_at) VALUES (${SUB_ID}, '${p}', ${now});`).join("\n")}
`;
const tmpFile = join(tmpdir(), `tldl-seed-${Date.now()}.sql`);
writeFileSync(tmpFile, sql);
try {
    execSync(`npx wrangler d1 execute tldl-subscribers --local --file=${tmpFile}`, { stdio: "inherit" });
} finally {
    unlinkSync(tmpFile);
}

// Generate tokens
const manageToken = sign(`manage|${SUB_ID}|${EMAIL}`);
const unsubOneToken = sign(`unsub|${SUB_ID}|${PODCASTS[0]}`);
const unsubAllToken = sign(`unsuball|${SUB_ID}`);

const base = "http://localhost:8787";

console.log("\n======================================");
console.log("Seeded subscriber:");
console.log(`  id = ${SUB_ID}`);
console.log(`  email = ${EMAIL}`);
console.log(`  podcasts = ${PODCASTS.join(", ")}`);
console.log("\nURLs (paste into browser):\n");
console.log("  Manage preferences:");
console.log(`    ${base}/preferences/manage?s=${SUB_ID}&token=${manageToken}\n`);
console.log(`  Unsubscribe from one podcast (${PODCASTS[0]}):`);
console.log(`    ${base}/unsubscribe?s=${SUB_ID}&p=${PODCASTS[0]}&token=${unsubOneToken}\n`);
console.log("  Unsubscribe from all:");
console.log(`    ${base}/unsubscribe?s=${SUB_ID}&token=${unsubAllToken}`);
console.log("\nOther forms (no token needed):");
console.log(`    ${base}/subscribe`);
console.log(`    ${base}/preferences`);
console.log(`    ${base}/confirm?token=nope  (expect 400 invalid-link page)`);
console.log("======================================\n");
