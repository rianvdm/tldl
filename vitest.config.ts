import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: {
                bindings: {
                    ENVIRONMENT: "development",
                    TURNSTILE_SECRET: "dummy-for-tests",
                    MANAGE_LINK_HMAC_SECRET: "test-hmac-secret-32-bytes-exactly!",
                    POSTMARK_API_KEY: "test-postmark",
                    POSTMARK_FROM_EMAIL: "test@tldl.test",
                    POSTMARK_WEBHOOK_AUTH: "u:p",
                    POSTMARK_MESSAGE_STREAM: "tldl",
                },
            },
        }),
    ],
    test: {
        provide: {
            DB_MIGRATIONS: migrations,
        },
    },
});
