#!/usr/bin/env npx tsx
/**
 * Seed Local KV with Test Data
 * 
 * This script populates the local KV namespace with diverse test data
 * for development and testing purposes.
 * 
 * Usage: npx tsx scripts/seed-local-data.ts
 */

import { execSync } from 'child_process';

// Namespace ID from wrangler.toml for local development
const NAMESPACE_ID = 'ee123158d5d54359b4257f8a1b678adf';

interface Episode {
    id: string;
    appleUrl: string;
    podcastName: string;
    episodeTitle: string;
    episodeDuration: number;
    episodeDate: string;
    audioUrl: string;
    transcriptSource: 'rss' | 'apple' | 'openai';
    createdAt: string;
    expiresAt: string;
    submittedBy: string;
    tags?: string[];
    podcastAuthor?: string;
    podcastWebsiteUrl?: string;
}

interface EpisodeIndexEntry {
    id: string;
    podcastName: string;
    episodeTitle: string;
    episodeDate: string;
    episodeDuration: number;
    createdAt: string;
    expiresAt: string;
    tags?: string[];
    podcastAuthor?: string;
}

interface Summary {
    episodeId: string;
    templateId: string;
    text: string;
    model: string;
    createdAt: string;
}

// Test data: Multiple podcasts with varied episodes
const testEpisodes: Episode[] = [
    // Podcast 1: This American Life (storytelling/narrative)
    {
        id: '1335892956_1000680000001',
        appleUrl: 'https://podcasts.apple.com/us/podcast/this-american-life/id1335892956?i=1000680000001',
        podcastName: 'This American Life',
        episodeTitle: 'The Weight of the Wait',
        episodeDuration: 3600,
        episodeDate: '2024-12-15T00:00:00Z',
        audioUrl: 'https://example.com/audio1.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-20T10:00:00Z',
        expiresAt: '2025-12-20T10:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['psychology', 'creativity'],
        podcastAuthor: 'Ira Glass',
        podcastWebsiteUrl: 'https://www.thisamericanlife.org',
    },
    {
        id: '1335892956_1000680000002',
        appleUrl: 'https://podcasts.apple.com/us/podcast/this-american-life/id1335892956?i=1000680000002',
        podcastName: 'This American Life',
        episodeTitle: 'The Invisible Made Visible',
        episodeDuration: 3540,
        episodeDate: '2024-12-08T00:00:00Z',
        audioUrl: 'https://example.com/audio2.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-18T14:30:00Z',
        expiresAt: '2025-12-18T14:30:00Z',
        submittedBy: 'test@example.com',
        tags: ['psychology'],
        podcastAuthor: 'Ira Glass',
        podcastWebsiteUrl: 'https://www.thisamericanlife.org',
    },
    {
        id: '1335892956_1000680000003',
        appleUrl: 'https://podcasts.apple.com/us/podcast/this-american-life/id1335892956?i=1000680000003',
        podcastName: 'This American Life',
        episodeTitle: 'Small Town, Big Secrets',
        episodeDuration: 3480,
        episodeDate: '2024-12-01T00:00:00Z',
        audioUrl: 'https://example.com/audio3.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-16T09:15:00Z',
        expiresAt: '2025-12-16T09:15:00Z',
        submittedBy: 'test@example.com',
        tags: ['politics'],
        podcastAuthor: 'Ira Glass',
        podcastWebsiteUrl: 'https://www.thisamericanlife.org',
    },

    // Podcast 2: Huberman Lab (science/health)
    {
        id: '1500000001_1000690000001',
        appleUrl: 'https://podcasts.apple.com/us/podcast/huberman-lab/id1500000001?i=1000690000001',
        podcastName: 'Huberman Lab',
        episodeTitle: 'The Science of Sleep & How to Improve It',
        episodeDuration: 7200,
        episodeDate: '2024-12-18T00:00:00Z',
        audioUrl: 'https://example.com/huberman1.mp3',
        transcriptSource: 'openai',
        createdAt: '2024-12-22T08:00:00Z',
        expiresAt: '2025-12-22T08:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['health', 'science'],
        podcastAuthor: 'Andrew Huberman',
        podcastWebsiteUrl: 'https://hubermanlab.com',
    },
    {
        id: '1500000001_1000690000002',
        appleUrl: 'https://podcasts.apple.com/us/podcast/huberman-lab/id1500000001?i=1000690000002',
        podcastName: 'Huberman Lab',
        episodeTitle: 'Tools for Managing Stress & Anxiety',
        episodeDuration: 6900,
        episodeDate: '2024-12-11T00:00:00Z',
        audioUrl: 'https://example.com/huberman2.mp3',
        transcriptSource: 'openai',
        createdAt: '2024-12-19T11:30:00Z',
        expiresAt: '2025-12-19T11:30:00Z',
        submittedBy: 'test@example.com',
        tags: ['health', 'psychology'],
        podcastAuthor: 'Andrew Huberman',
        podcastWebsiteUrl: 'https://hubermanlab.com',
    },

    // Podcast 3: Lenny's Podcast (product/business)
    {
        id: '1556004618_1000700000001',
        appleUrl: 'https://podcasts.apple.com/us/podcast/lennys-podcast/id1556004618?i=1000700000001',
        podcastName: "Lenny's Podcast",
        episodeTitle: 'How to Build Products Users Love',
        episodeDuration: 4200,
        episodeDate: '2024-12-19T00:00:00Z',
        audioUrl: 'https://example.com/lenny1.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-23T16:00:00Z',
        expiresAt: '2025-12-23T16:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['product', 'business'],
        podcastAuthor: 'Lenny Rachitsky',
        podcastWebsiteUrl: 'https://www.lennyspodcast.com',
    },
    {
        id: '1556004618_1000700000002',
        appleUrl: 'https://podcasts.apple.com/us/podcast/lennys-podcast/id1556004618?i=1000700000002',
        podcastName: "Lenny's Podcast",
        episodeTitle: 'Growth Strategies That Actually Work',
        episodeDuration: 3900,
        episodeDate: '2024-12-12T00:00:00Z',
        audioUrl: 'https://example.com/lenny2.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-21T10:45:00Z',
        expiresAt: '2025-12-21T10:45:00Z',
        submittedBy: 'test@example.com',
        tags: ['product', 'business'],
        podcastAuthor: 'Lenny Rachitsky',
        podcastWebsiteUrl: 'https://www.lennyspodcast.com',
    },

    // Podcast 4: Lex Fridman Podcast (technology/science)
    {
        id: '1434243584_1000710000001',
        appleUrl: 'https://podcasts.apple.com/us/podcast/lex-fridman-podcast/id1434243584?i=1000710000001',
        podcastName: 'Lex Fridman Podcast',
        episodeTitle: 'The Future of AI and Humanity',
        episodeDuration: 10800,
        episodeDate: '2024-12-20T00:00:00Z',
        audioUrl: 'https://example.com/lex1.mp3',
        transcriptSource: 'apple',
        createdAt: '2024-12-24T09:00:00Z',
        expiresAt: '2025-12-24T09:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['technology', 'science'],
        podcastAuthor: 'Lex Fridman',
        podcastWebsiteUrl: 'https://lexfridman.com',
    },
    {
        id: '1434243584_1000710000002',
        appleUrl: 'https://podcasts.apple.com/us/podcast/lex-fridman-podcast/id1434243584?i=1000710000002',
        podcastName: 'Lex Fridman Podcast',
        episodeTitle: 'Consciousness and the Mind',
        episodeDuration: 9600,
        episodeDate: '2024-12-13T00:00:00Z',
        audioUrl: 'https://example.com/lex2.mp3',
        transcriptSource: 'apple',
        createdAt: '2024-12-17T15:00:00Z',
        expiresAt: '2025-12-17T15:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['science', 'psychology'],
        podcastAuthor: 'Lex Fridman',
        podcastWebsiteUrl: 'https://lexfridman.com',
    },

    // Podcast 5: The Daily (news/politics)
    {
        id: '1200000001_1000720000001',
        appleUrl: 'https://podcasts.apple.com/us/podcast/the-daily/id1200000001?i=1000720000001',
        podcastName: 'The Daily',
        episodeTitle: 'The Year in Review: 2024',
        episodeDuration: 1800,
        episodeDate: '2024-12-21T00:00:00Z',
        audioUrl: 'https://example.com/daily1.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-24T06:30:00Z',
        expiresAt: '2025-12-24T06:30:00Z',
        submittedBy: 'test@example.com',
        tags: ['politics'],
        podcastAuthor: 'Michael Barbaro',
        podcastWebsiteUrl: 'https://www.nytimes.com/the-daily',
    },

    // Podcast 6: Hidden Brain (psychology)
    {
        id: '1100000001_1000730000001',
        appleUrl: 'https://podcasts.apple.com/us/podcast/hidden-brain/id1100000001?i=1000730000001',
        podcastName: 'Hidden Brain',
        episodeTitle: 'The Power of Unconscious Decisions',
        episodeDuration: 2700,
        episodeDate: '2024-12-17T00:00:00Z',
        audioUrl: 'https://example.com/hidden1.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-22T13:00:00Z',
        expiresAt: '2025-12-22T13:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['psychology', 'science'],
        podcastAuthor: 'Shankar Vedantam',
        podcastWebsiteUrl: 'https://hiddenbrain.org',
    },
    {
        id: '1100000001_1000730000002',
        appleUrl: 'https://podcasts.apple.com/us/podcast/hidden-brain/id1100000001?i=1000730000002',
        podcastName: 'Hidden Brain',
        episodeTitle: 'Why We Make Bad Choices',
        episodeDuration: 2940,
        episodeDate: '2024-12-10T00:00:00Z',
        audioUrl: 'https://example.com/hidden2.mp3',
        transcriptSource: 'rss',
        createdAt: '2024-12-15T17:00:00Z',
        expiresAt: '2025-12-15T17:00:00Z',
        submittedBy: 'test@example.com',
        tags: ['psychology'],
        podcastAuthor: 'Shankar Vedantam',
        podcastWebsiteUrl: 'https://hiddenbrain.org',
    },
];

// Generate summaries for each episode
function generateSummary(episode: Episode, templateId: string): Summary {
    const summaryTexts: Record<string, string> = {
        'key-takeaways': `## Key Takeaways from "${episode.episodeTitle}"

### Main Points

1. **First Key Insight** - This episode explores the fascinating intersection of ${episode.tags?.[0] || 'ideas'} and everyday life.

2. **Second Key Insight** - ${episode.podcastAuthor} discusses the importance of intentional practice and reflection.

3. **Third Key Insight** - The conversation highlights practical strategies that listeners can apply immediately.

### Practical Steps

- Start with small, consistent actions rather than dramatic changes
- Keep a journal to track progress and insights
- Share what you learn with others to reinforce understanding

### Memorable Quote

> "The most powerful changes often come from the smallest adjustments."`,

        'narrative-summary': `## Episode Summary: "${episode.episodeTitle}"

In this engaging episode, ${episode.podcastAuthor} takes us on a journey through ${episode.tags?.[0] || 'compelling'} territory.

The episode opens with a thought-provoking question that sets the stage for the entire conversation. Through expert storytelling and insightful interviews, we learn about the hidden forces that shape our daily experiences.

What makes this episode particularly compelling is how it weaves together personal narratives with broader themes that resonate with listeners from all walks of life.

The conclusion offers both reflection and hope, leaving listeners with actionable wisdom they can apply immediately.`,

        'eli5': `## Simple Explanation: "${episode.episodeTitle}"

**What's this episode about?**

Imagine you have a superpower you didn't know about. This episode is all about discovering that superpower and learning how to use it!

**The big idea:**

${episode.podcastAuthor} explains that everyone has the ability to make their life better by paying attention to small things. It's like being a detective for your own mind!

**Why it matters:**

When we understand how our brain works, we can make better choices. It's like having a instruction manual for being human.

**One thing to try:**

Tonight before bed, think of three good things that happened today. That's it! This simple trick helps your brain focus on the positive.`,
    };

    return {
        episodeId: episode.id,
        templateId,
        text: summaryTexts[templateId] || summaryTexts['key-takeaways'],
        model: 'gpt-5.2',
        createdAt: episode.createdAt,
    };
}

// Build index entries
function buildIndexEntry(episode: Episode): EpisodeIndexEntry {
    return {
        id: episode.id,
        podcastName: episode.podcastName,
        episodeTitle: episode.episodeTitle,
        episodeDate: episode.episodeDate,
        episodeDuration: episode.episodeDuration,
        createdAt: episode.createdAt,
        expiresAt: episode.expiresAt,
        tags: episode.tags,
        podcastAuthor: episode.podcastAuthor,
    };
}

// Put a key-value pair into local KV
function putKV(key: string, value: string) {
    const escaped = value.replace(/'/g, "'\\''");
    execSync(
        `npx wrangler kv key put --namespace-id=${NAMESPACE_ID} --local "${key}" '${escaped}'`,
        { stdio: 'inherit' }
    );
}

// Delete a key from local KV
function deleteKV(key: string) {
    try {
        execSync(
            `npx wrangler kv key delete --namespace-id=${NAMESPACE_ID} --local "${key}" --force`,
            { stdio: 'inherit' }
        );
    } catch {
        // Key might not exist, that's fine
    }
}

async function main() {
    console.log('🌱 Seeding local KV with test data...\n');

    // Clear any existing failed jobs
    console.log('🧹 Cleaning up old job data...');
    try {
        const listOutput = execSync(
            `npx wrangler kv key list --namespace-id=${NAMESPACE_ID} --local --prefix="job:"`,
            { encoding: 'utf-8' }
        );
        const jobs = JSON.parse(listOutput);
        for (const job of jobs) {
            deleteKV(job.name);
        }
    } catch {
        console.log('   No existing jobs to clean up');
    }

    // Seed episodes
    console.log('\n📦 Seeding episodes...');
    for (const episode of testEpisodes) {
        console.log(`   - ${episode.podcastName}: ${episode.episodeTitle}`);
        putKV(`episode:${episode.id}`, JSON.stringify(episode));
    }

    // Seed summaries (key-takeaways for all, narrative for some)
    console.log('\n📝 Seeding summaries...');
    for (const episode of testEpisodes) {
        // All episodes get key-takeaways
        const ktSummary = generateSummary(episode, 'key-takeaways');
        putKV(`summary:${episode.id}:key-takeaways`, JSON.stringify(ktSummary));

        // Some episodes get additional templates
        if (episode.podcastName === 'Huberman Lab') {
            const eli5Summary = generateSummary(episode, 'eli5');
            putKV(`summary:${episode.id}:eli5`, JSON.stringify(eli5Summary));
        }
        if (episode.podcastName === 'This American Life') {
            const narrativeSummary = generateSummary(episode, 'narrative-summary');
            putKV(`summary:${episode.id}:narrative-summary`, JSON.stringify(narrativeSummary));
        }
    }

    // Build and seed episode index
    console.log('\n📋 Building episode index...');
    const index: EpisodeIndexEntry[] = testEpisodes
        .map(buildIndexEntry)
        .sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
    putKV('episodes:index', JSON.stringify(index));

    console.log('\n✅ Seeding complete!');
    console.log(`   - ${testEpisodes.length} episodes`);
    console.log(`   - ${new Set(testEpisodes.map(e => e.podcastName)).size} podcasts`);
    console.log(`   - Multiple summary templates`);
    console.log(`   - Tags, authors, and website URLs populated`);
    console.log('\n🚀 Start the dev server with: npm run dev');
}

main().catch(console.error);
