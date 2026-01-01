// Script to look up Product Thinking podcast episode titles
async function main() {
    const itunesId = '1550800132';
    const itunesUrl = `https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`;
    console.log('Looking up from iTunes...');

    try {
        const resp = await fetch(itunesUrl);
        const data = await resp.json() as { results: Array<{ wrapperType: string; feedUrl?: string; collectionName?: string }> };

        const podcast = data.results?.find((r) => r.wrapperType === 'collection');
        if (podcast?.feedUrl) {
            console.log('Feed URL:', podcast.feedUrl);
            console.log('Podcast name:', podcast.collectionName);

            // Now fetch and parse the feed
            const feedResp = await fetch(podcast.feedUrl, { headers: { 'User-Agent': 'TLDL/1.0' } });
            const feedText = await feedResp.text();

            // Get all episode titles
            const allTitles: string[] = [];
            const itemRegex = /<item>[\s\S]*?<\/item>/g;
            let match;
            while ((match = itemRegex.exec(feedText)) !== null) {
                const itemBlock = match[0];
                const titleMatch = itemBlock.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+))<\/title>/);
                if (titleMatch) {
                    allTitles.push(titleMatch[1] || titleMatch[2]);
                }
            }

            console.log('\nTotal episodes:', allTitles.length);
            console.log('\nFirst 15 titles:');
            allTitles.slice(0, 15).forEach((t, i) => console.log('  ' + (i + 1) + '. ' + t));

            // Search for episode 259 or Simplifying AI
            console.log('\nSearching for matching titles:');
            const matching = allTitles.filter(t =>
                t.toLowerCase().includes('259') ||
                t.toLowerCase().includes('simplifying')
            );
            matching.forEach(t => console.log('  - ' + t));
        }
    } catch (err) {
        console.error('Error:', err);
    }
}
main();
