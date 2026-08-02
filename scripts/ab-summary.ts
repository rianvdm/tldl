/**
 * Episode-summary model A/B harness.
 *
 * Runs the EXACT production summary prompt over real prod transcripts through
 * two or more models (OpenAI Responses API) and writes a side-by-side markdown
 * report with per-run token usage, word count, latency, and cost. Use it to
 * decide whether to adopt a newly released model for episode summaries before
 * touching `src/services/summarization.ts`.
 *
 * Not wired into the Worker. Cache-bypassed (fresh API calls every run).
 *
 *   npm run ab:summary                       # curated 6-episode sample, gpt-5.4 vs gpt-5.5
 *   npm run ab:summary -- --random 8         # 8 random transcripts from prod KV
 *   npm run ab:summary -- <id> <id> ...      # specific episode IDs
 *   npm run ab:summary -- --models gpt-5.4,gpt-5.5,gpt-5.6
 *   npm run ab:summary -- --template narrative-summary
 *   npm run ab:summary -- --help
 *
 * Adding a new model: just pass it via --models. If its price isn't in PRICING
 * below, cost shows as n/a (add the row to get $ numbers).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getTemplate, isValidTemplateId } from "../src/lib/constants";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const KV_NAMESPACE = "ee123158d5d54359b4257f8a1b678adf"; // TLDL_DATA (prod), see wrangler.toml
const RESPONSES_URL = "https://api.openai.com/v1/responses";

// USD per 1M tokens (input / output). Add a row when a new model ships so the
// report can show cost; unknown models still run (cost = n/a).
const PRICING: Record<string, { in: number; out: number }> = {
    "gpt-5.4": { in: 2.5, out: 15 },
    "gpt-5.5": { in: 5.0, out: 30 },
    "gpt-5.5-pro": { in: 30, out: 180 },
    "gpt-5.6-luna": { in: 0.2, out: 1.2 },
    "gpt-5.6-terra": { in: 2.0, out: 12 },
    "gpt-5.6-sol": { in: 5.0, out: 30 },
};

const DEFAULT_MODELS = ["gpt-5.6-terra", "gpt-5.4"];
const DEFAULT_TEMPLATE = "key-takeaways"; // prod default (wrangler.toml DEFAULT_TEMPLATE)

// Curated default sample: 6 episodes across 6 distinct shows, mixed lengths.
const DEFAULT_EPISODES = [
    "1809663079_1000773109920", // How I AI
    "1548604447_1000773386224", // Ezra Klein
    "1627920305_1000771544935", // Lenny's
    "1769051199_1000760299204", // Pragmatic Engineer
    "1737704130_1000752597036", // Supra Insider
    "1190000968_1000761835607", // Eat Sleep Work Repeat
];

interface Usage {
    input_tokens: number;
    output_tokens: number;
}

interface Args {
    episodes: string[];
    models: string[];
    template: string;
    random: number | null;
    out: string | null;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { episodes: [], models: DEFAULT_MODELS, template: DEFAULT_TEMPLATE, random: null, out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            printHelp();
            process.exit(0);
        } else if (a === "--models") {
            args.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        } else if (a === "--template") {
            args.template = argv[++i];
        } else if (a === "--random") {
            args.random = parseInt(argv[++i], 10);
        } else if (a === "--out") {
            args.out = argv[++i];
        } else if (a.startsWith("--")) {
            throw new Error(`Unknown flag: ${a} (try --help)`);
        } else {
            args.episodes.push(a);
        }
    }
    return args;
}

function printHelp() {
    console.log(
        `episode-summary model A/B harness\n\n` +
            `Usage: npm run ab:summary -- [options] [episodeId ...]\n\n` +
            `Options:\n` +
            `  --random N            Sample N random transcripts from prod KV\n` +
            `  --models a,b,c        Models to compare (default: ${DEFAULT_MODELS.join(", ")})\n` +
            `  --template ID         Summary template: key-takeaways | narrative-summary | eli5\n` +
            `  --out PATH            Output markdown path (default: scripts/ab-results/<ts>.md)\n` +
            `  --help                This help\n\n` +
            `With no episode IDs and no --random, runs a curated 6-episode sample.`
    );
}

function readApiKey(): string {
    const vars = readFileSync(join(REPO_ROOT, ".dev.vars"), "utf8");
    const match = vars.match(/^OPENAI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (!match) throw new Error("OPENAI_API_KEY not found in .dev.vars");
    return match[1].trim();
}

function kvGet(key: string): string | null {
    try {
        return execFileSync(
            "npx",
            ["wrangler", "kv", "key", "get", key, "--namespace-id", KV_NAMESPACE, "--remote"],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], cwd: REPO_ROOT }
        );
    } catch {
        return null;
    }
}

function kvListTranscripts(): string[] {
    const raw = execFileSync(
        "npx",
        ["wrangler", "kv", "key", "list", "--namespace-id", KV_NAMESPACE, "--remote"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], cwd: REPO_ROOT }
    );
    return (JSON.parse(raw) as { name: string }[])
        .map((k) => k.name)
        .filter((n) => n.startsWith("transcript:"))
        .map((n) => n.slice("transcript:".length));
}

function sample<T>(arr: T[], n: number): T[] {
    const copy = [...arr];
    const out: T[] = [];
    while (out.length < n && copy.length) {
        out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
}

function extractText(data: any): string {
    const content = data?.output?.find((o: any) => o.type === "message")?.content?.[0];
    return content?.text ?? "";
}

function costStr(usage: Usage, model: string): string {
    const p = PRICING[model];
    if (!p) return "n/a";
    return "$" + ((usage.input_tokens / 1e6) * p.in + (usage.output_tokens / 1e6) * p.out).toFixed(4);
}

function wordCount(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

async function runModel(
    model: string,
    instructions: string,
    transcript: string,
    apiKey: string
): Promise<{ text: string; usage: Usage; ms: number }> {
    const started = Date.now();
    const res = await fetch(RESPONSES_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions, input: transcript }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${model} HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    return { text: extractText(data), usage: data.usage ?? { input_tokens: 0, output_tokens: 0 }, ms };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!isValidTemplateId(args.template)) {
        throw new Error(`Invalid template "${args.template}" (key-takeaways | narrative-summary | eli5)`);
    }
    const instructions = getTemplate(args.template)!.prompt;
    const apiKey = readApiKey();

    let episodeIds = args.episodes;
    if (args.random) {
        console.error(`Sampling ${args.random} random transcripts from prod KV...`);
        episodeIds = sample(kvListTranscripts(), args.random);
    } else if (episodeIds.length === 0) {
        episodeIds = DEFAULT_EPISODES;
    }

    console.error(`Models: ${args.models.join(", ")} · template: ${args.template} · episodes: ${episodeIds.length}\n`);

    const sections: string[] = [];
    const rows: string[] = [];

    for (const id of episodeIds) {
        console.error(`=== ${id} ===`);
        const rawT = kvGet(`transcript:${id}`);
        if (!rawT) {
            console.error("  no transcript, skipping");
            continue;
        }
        const transcript = (JSON.parse(rawT) as { text: string }).text;
        const rawE = kvGet(`episode:${id}`);
        const ep = rawE ? (JSON.parse(rawE) as { episodeTitle: string; podcastName: string }) : null;
        const title = ep ? `${ep.podcastName} — ${ep.episodeTitle}` : id;
        const approxIn = Math.round(transcript.length / 4);
        console.error(`  ${title}\n  transcript ~${approxIn.toLocaleString()} tokens`);

        sections.push(`## ${title}\n\n*Transcript ~${approxIn.toLocaleString()} tokens · template \`${args.template}\`*\n`);

        for (const model of args.models) {
            process.stderr.write(`  running ${model}... `);
            let r: { text: string; usage: Usage; ms: number };
            try {
                r = await runModel(model, instructions, transcript, apiKey);
            } catch (e) {
                console.error(`FAILED: ${(e as Error).message}`);
                sections.push(`### ${model}\n\n_Failed: ${(e as Error).message}_\n`);
                continue;
            }
            const words = wordCount(r.text);
            console.error(`${(r.ms / 1000).toFixed(1)}s · ${words} words · ${r.usage.output_tokens} out · ${costStr(r.usage, model)}`);
            rows.push(
                `| ${title.slice(0, 38)} | ${model} | ${r.usage.input_tokens} | ${r.usage.output_tokens} | ${words} | ${(r.ms / 1000).toFixed(1)}s | ${costStr(r.usage, model)} |`
            );
            sections.push(
                `### ${model}\n\n` +
                    `<sub>${r.usage.input_tokens} in / ${r.usage.output_tokens} out · ${words} words · ${(r.ms / 1000).toFixed(1)}s · ${costStr(r.usage, model)}</sub>\n\n` +
                    r.text +
                    "\n"
            );
        }
        sections.push("---\n");
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const outDir = join(REPO_ROOT, "scripts", "ab-results");
    mkdirSync(outDir, { recursive: true });
    const out = args.out ?? join(outDir, `summary-ab-${stamp}.md`);

    const header =
        `# tldl episode-summary A/B\n\n` +
        `Models: ${args.models.join(", ")} · template \`${args.template}\` · ${episodeIds.length} episodes · ${stamp}\n` +
        `Generated by \`scripts/ab-summary.ts\` — production prompt, real prod transcripts, fresh (cache-bypassed) calls.\n\n` +
        `## Cost · words · latency per run\n\n` +
        `| Episode | Model | In | Out | Words | Latency | Cost |\n` +
        `|---|---|--:|--:|--:|--:|--:|\n` +
        rows.join("\n") +
        `\n\n*The \`key-takeaways\` template asks for 400–600 words — watch the Words column for length drift.*\n\n---\n`;

    writeFileSync(out, header + sections.join("\n"));
    console.error(`\nWrote ${out}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
