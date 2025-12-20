export const TEMPLATES = {
  'key-takeaways': {
    id: 'key-takeaways',
    name: 'Key Takeaways & Practical Steps',
    description: 'For craft and professional development podcasts',
  },
  'narrative-summary': {
    id: 'narrative-summary',
    name: 'Narrative Summary',
    description: 'For story-driven and interview podcasts',
  },
  'eli5': {
    id: 'eli5',
    name: 'ELI5 (Explain Like I\'m 5)',
    description: 'For technical and complex topics',
  },
};

export interface Episode {
  id: string;
  appleUrl: string;
  podcastName: string;
  episodeTitle: string;
  episodeDuration: number;
  episodeDate: string;
  audioUrl: string;
  transcriptSource: 'apple' | 'rss' | 'openai';
  createdAt: string;
  expiresAt: string;
}

export interface Summary {
  episodeId: string;
  templateId: string;
  text: string;
  model: string;
  createdAt: string;
}

export interface Transcript {
  episodeId: string;
  text: string;
  source: 'apple' | 'rss' | 'openai';
  createdAt: string;
}

export interface Job {
  id: string;
  episodeId: string;
  appleUrl: string;
  status: 'queued' | 'fetching_metadata' | 'checking_transcript' | 'transcribing' | 'summarizing' | 'completed' | 'failed';
  templateId: string;
  error?: string;
  estimatedSeconds?: number;
  createdAt: string;
  updatedAt: string;
}

// Mock episodes
export const mockEpisodes: Episode[] = [
  {
    id: 'ep-001',
    appleUrl: 'https://podcasts.apple.com/us/podcast/example/id123?i=1000',
    podcastName: 'The Knowledge Project',
    episodeTitle: 'How to Think Better: First Principles and Mental Models',
    episodeDuration: 3240, // 54 minutes
    episodeDate: '2024-12-10',
    audioUrl: 'https://example.com/audio.mp3',
    transcriptSource: 'apple',
    createdAt: '2024-12-10T10:00:00Z',
    expiresAt: '2025-12-10T10:00:00Z',
  },
  {
    id: 'ep-002',
    appleUrl: 'https://podcasts.apple.com/us/podcast/example/id123?i=1001',
    podcastName: 'Lenny\'s Podcast',
    episodeTitle: 'Building Products That Users Love with Des Traynor',
    episodeDuration: 4200, // 70 minutes
    episodeDate: '2024-12-08',
    audioUrl: 'https://example.com/audio2.mp3',
    transcriptSource: 'rss',
    createdAt: '2024-12-08T14:00:00Z',
    expiresAt: '2025-12-08T14:00:00Z',
  },
  {
    id: 'ep-003',
    appleUrl: 'https://podcasts.apple.com/us/podcast/example/id123?i=1002',
    podcastName: 'Huberman Lab',
    episodeTitle: 'The Science of Sleep and How to Optimize It',
    episodeDuration: 5400, // 90 minutes (but allowed for demo)
    episodeDate: '2024-12-05',
    audioUrl: 'https://example.com/audio3.mp3',
    transcriptSource: 'openai',
    createdAt: '2024-12-05T08:00:00Z',
    expiresAt: '2025-12-05T08:00:00Z',
  },
  {
    id: 'ep-004',
    appleUrl: 'https://podcasts.apple.com/us/podcast/example/id123?i=1003',
    podcastName: 'How I Built This',
    episodeTitle: 'Airbnb: Joe Gebbia',
    episodeDuration: 2700, // 45 minutes
    episodeDate: '2024-12-01',
    audioUrl: 'https://example.com/audio4.mp3',
    transcriptSource: 'apple',
    createdAt: '2024-12-01T16:00:00Z',
    expiresAt: '2025-12-01T16:00:00Z',
  },
  {
    id: 'ep-005',
    appleUrl: 'https://podcasts.apple.com/us/podcast/example/id123?i=1004',
    podcastName: 'Acquired',
    episodeTitle: 'NVIDIA: The GPU Company (with Jensen Huang)',
    episodeDuration: 4800, // 80 minutes
    episodeDate: '2024-11-28',
    audioUrl: 'https://example.com/audio5.mp3',
    transcriptSource: 'openai',
    createdAt: '2024-11-28T10:00:00Z',
    expiresAt: '2025-11-28T10:00:00Z',
  },
];

// Mock summaries
export const mockSummaries: Summary[] = [
  {
    episodeId: 'ep-001',
    templateId: 'key-takeaways',
    text: `## Overview

This episode explores the power of first principles thinking and mental models in decision-making. Shane Parrish discusses how breaking down complex problems to their fundamental truths can lead to breakthrough insights and better outcomes.

## Key Takeaways

**First Principles Thinking**: Rather than reasoning by analogy, first principles thinking involves breaking a problem down to its most basic, foundational elements and building up from there. This approach was famously used by Elon Musk when developing SpaceX—instead of accepting the high cost of rockets, he analyzed the raw materials and found a much cheaper solution.

**Mental Models as Tools**: Mental models are frameworks for understanding how the world works. The more models you have in your toolkit, the better equipped you are to solve diverse problems. Key models discussed include:

- The map is not the territory (recognizing abstractions vs. reality)
- Circle of competence (knowing what you know and don't know)
- Inversion (thinking about what you want to avoid)

**Quality Over Quantity in Information**: In an age of information overload, the ability to filter signal from noise is crucial. Reading deeply rather than skimming widely, and giving yourself time to think without constant input, leads to better understanding and decision-making.

## Practical Steps

1. **Practice breaking things down**: When faced with a complex decision, write down all your assumptions. Then challenge each one—which are actually true, and which are just inherited beliefs?

2. **Build your mental model library**: Dedicate time each week to learning one new mental model. Start with classics from Charlie Munger's list or books like "Thinking in Systems."

3. **Create thinking time**: Block out at least 30 minutes daily for pure thinking—no phone, no input, just processing and connecting ideas you've absorbed.

4. **Use inversion regularly**: Before making a decision, ask "What would guarantee failure?" and work backward to avoid those paths.

## Notable Quotes

"The person who says they can't afford to think doesn't understand the cost of not thinking." - Shane Parrish

"When you strip away the noise and get to first principles, you often find that conventional wisdom is just conventional, not wisdom."`,
    model: 'gpt-5.2',
    createdAt: '2024-12-10T10:05:00Z',
  },
  {
    episodeId: 'ep-001',
    templateId: 'eli5',
    text: `## What's the Big Idea?

Imagine you're building with LEGO blocks. Most people look at someone else's creation and try to copy it. But first principles thinking is like dumping out all your LEGO blocks and asking: "What can I build from scratch that actually solves my problem?"

## Why Does It Matter?

We often make decisions based on what everyone else is doing, or what we've always done. It's like following a recipe without understanding why each ingredient is there. First principles thinking teaches you to understand the "why" behind everything, which means you can create better solutions and not just copy what already exists.

Think of it like this: If everyone tells you that getting to the moon is impossible because rockets cost too much, you might give up. But if you ask "What's a rocket made of?" and find out it's just aluminum and fuel, you might realize you can build one much cheaper than everyone thinks!

## Key Concepts Explained Simply

**Mental Models - Your Brain's Toolkit**

Mental models are like different pairs of glasses you can put on to see problems differently. Imagine you're trying to understand why your plant is dying. You could use:
- The "system" glasses: How do water, sunlight, and soil work together?
- The "inversion" glasses: What would definitely kill this plant? (Then don't do that!)
- The "second-order thinking" glasses: If I water it more, what happens next? And then what?

Having more "glasses" means you can solve more types of problems.

**The Map Is Not the Territory**

This is a fancy way of saying: Don't confuse the picture with the real thing. A map of your neighborhood shows the streets, but it doesn't show the smell of the bakery or the sound of kids playing. Always remember that simple explanations (maps) miss some details of reality (territory).

**Circle of Competence**

This just means: know what you're good at and what you're not. It's like knowing you're great at baking cookies but terrible at fixing cars. The smartest people aren't those who know everything—they're the ones who know what they don't know and aren't afraid to say "I need to learn more about this."

## The Bottom Line

Better thinking isn't about being smarter—it's about having better tools and knowing when to use them. Start by questioning your assumptions, learn from multiple fields, and give yourself time to actually think through problems instead of just reacting to them. Like learning to ride a bike, it feels awkward at first, but becomes natural with practice.`,
    model: 'gpt-5.2',
    createdAt: '2024-12-10T10:10:00Z',
  },
  {
    episodeId: 'ep-002',
    templateId: 'key-takeaways',
    text: `## Overview

Des Traynor, co-founder of Intercom, shares insights on building products that users genuinely love. The conversation explores the balance between user feedback and product vision, the importance of solving real problems, and why great products often start simple.

## Key Takeaways

**Solve Problems, Not Feature Requests**: Users are excellent at identifying problems but often terrible at proposing solutions. When a user asks for a specific feature, dig deeper to understand the underlying problem they're trying to solve. Often, there's a simpler, more elegant solution than what they requested.

**The Power of Starting Simple**: Complex products usually fail because they try to do too much. Start with the smallest possible version that solves a real problem. Intercom began as a simple messaging tool, not the comprehensive platform it is today.

**Know Your "Product Truths"**: Every successful product has core beliefs that guide decisions. For Intercom, one truth is "business is personal"—even in B2B software, you're serving real humans. These truths help you say no to features that don't align.

## Practical Steps

1. **Create a "Jobs to Be Done" framework**: For each feature request, write down: What job is the user trying to accomplish? What's preventing them? What would success look like? This reveals whether you need a new feature or better implementation of existing ones.

2. **Implement the "Why, Why, Why" technique**: When users request features, ask "why" at least three times to get to the root problem. Often the real need is different from the initial request.

3. **Define your product's core truths**: Write down 3-5 fundamental beliefs about your product and users. Use these as a filter for all feature decisions.

## Notable Quotes

"Your job isn't to build what users ask for. It's to solve the problems they have." - Des Traynor

"The best products feel inevitable in hindsight, but that's because they solved a real problem simply."`,
    model: 'gpt-5.2',
    createdAt: '2024-12-08T14:05:00Z',
  },
  {
    episodeId: 'ep-003',
    templateId: 'narrative-summary',
    text: `Dr. Andrew Huberman opens this episode with a striking statement: most of us are chronically sleep deprived without even realizing it. What follows is a deep dive into the science of sleep that challenges many common assumptions about this fundamental biological process.

The conversation begins with the architecture of sleep itself. Sleep isn't a single state but a carefully orchestrated cycle of different phases, each serving crucial functions. Deep sleep, occurring primarily in the first half of the night, is when the brain clears metabolic waste—a janatorial process that may protect against neurodegenerative diseases. REM sleep, concentrated in the later hours, processes emotions and consolidates creative insights.

Huberman explains why the exact timing of sleep matters more than most people think. Our bodies run on a roughly 24-hour circadian rhythm, controlled by a master clock in the brain that responds primarily to light. This is where the episode takes a practical turn: getting bright light in your eyes within the first hour of waking is perhaps the single most powerful tool for setting your sleep-wake cycle. Conversely, late-night blue light doesn't just keep you awake—it actively confuses your biological clock, making it harder to fall asleep on subsequent nights.

Temperature regulation emerges as another critical factor. Your body temperature needs to drop by about one to three degrees to initiate sleep. This explains why a hot bath before bed can help—it's not the warmth itself, but the rapid cooling that follows when you get out. The room itself should be cool, around 65-68 degrees Fahrenheit for optimal sleep.

Perhaps most surprising are Huberman's insights on sleep supplements and medications. While prescription sleep medications can help in crisis situations, many work by sedating rather than inducing natural sleep—meaning you're unconscious but not getting the full restorative benefits. Natural supplements like magnesium threonate and apigenin can support sleep architecture without this downside, though individual responses vary.

The episode concludes with a framework for optimization: view sleep as a skill to be practiced rather than something that just happens. Track your sleep patterns, experiment with the timing of exercise and caffeine, and recognize that improving sleep is one of the highest-leverage interventions for overall health, cognitive performance, and longevity.`,
    model: 'gpt-5.2',
    createdAt: '2024-12-05T08:05:00Z',
  },
  {
    episodeId: 'ep-004',
    templateId: 'key-takeaways',
    text: `## Overview

Joe Gebbia, co-founder of Airbnb, shares the improbable story of how three roommates turned air mattresses in their living room into a global hospitality empire worth billions. This episode explores the early days of Airbnb, the challenges of building trust between strangers, and the design thinking that shaped one of the most transformative companies of the 21st century.

## Key Takeaways

**Start With the Problem, Not the Solution**: Airbnb didn't begin as a grand vision to disrupt hospitality. It started with Gebbia and Brian Chesky unable to pay rent and noticing that all hotels were booked during a design conference. They offered air mattresses and breakfast—hence "Air Bed and Breakfast"—and stumbled onto a massive unmet need.

**Design for Trust**: The biggest barrier to Airbnb's growth wasn't technology—it was convincing strangers to sleep in each other's homes. The team obsessed over trust-building features: professional photography, verified reviews, secure payments, and the $1,000 guarantee (later expanded to $1 million host protection). Every design decision asked: "Does this make users feel safer?"

**Do Things That Don't Scale**: In the early days, the founders personally visited hosts to photograph their spaces and give feedback. This hands-on approach didn't scale, but it taught them what made listings succeed, informed product decisions, and built deep relationships with early adopters. Paul Graham's advice "do things that don't scale" became their mantra.

**Persistence Through Rejection**: Airbnb was rejected by dozens of investors. They were told the idea would never work, that people wouldn't rent to strangers, that the market was too small. The founders funded the company by selling themed cereal boxes during the 2008 election—"Obama O's" and "Cap'n McCain's"—raising $30,000. This creative hustle kept them alive until they got into Y Combinator.

## Practical Steps

1. **Validate with the smallest possible test**: Don't build the full product. Test your core assumption with a minimal experiment, like Airbnb's three air mattresses.

2. **Obsess over the highest-friction moment**: Identify the biggest objection or fear your users have, and design specifically to address it. For Airbnb, it was trust.

3. **Get out of the building**: Spend time with your users in person, especially in the early days. The insights you gain from direct observation are irreplaceable.

4. **Creative resourcefulness beats capital**: When you have no money, you're forced to think creatively. Selling cereal boxes is unconventional, but it demonstrates commitment and generates buzz.

## Notable Quotes

"We had $40,000 in debt on credit cards, and we turned that into a company worth billions—not because we were smarter than everyone else, but because we were too naive to quit." - Joe Gebbia

"Build something 100 people love, not something 1 million people kind of like."`,
    model: 'gpt-5.2',
    createdAt: '2024-12-01T16:05:00Z',
  },
];

// Mock transcripts
export const mockTranscripts: Transcript[] = [
  {
    episodeId: 'ep-001',
    text: `[00:00:00] Shane Parrish: Welcome to The Knowledge Project. I'm your host, Shane Parrish. Today we're diving deep into first principles thinking and mental models.

[00:00:15] First principles thinking is one of the most powerful tools in your cognitive toolkit. It's the practice of breaking down complex problems into their most basic elements and building up from there, rather than reasoning by analogy.

[00:00:45] Let me give you an example. Most people, when they look at the cost of space travel, accept it as a given. Rockets are expensive because they've always been expensive. But Elon Musk asked a different question...

[Full transcript would continue for ~54 minutes of content]`,
    source: 'apple',
    createdAt: '2024-12-10T10:00:00Z',
  },
  {
    episodeId: 'ep-002',
    text: `[00:00:00] Lenny: Welcome to Lenny's Podcast. Today I'm joined by Des Traynor, co-founder of Intercom. Des, thanks for being here.

[00:00:05] Des Traynor: Thanks for having me, Lenny.

[00:00:08] Lenny: Let's start with a fundamental question: how do you think about building products that users actually love versus products that just solve a problem?

[00:00:18] Des Traynor: That's a great question. I think there's a fundamental misunderstanding in the product world...

[Full transcript would continue for ~70 minutes of content]`,
    source: 'rss',
    createdAt: '2024-12-08T14:00:00Z',
  },
  {
    episodeId: 'ep-003',
    text: `[00:00:00] Dr. Huberman: Welcome to the Huberman Lab Podcast, where we discuss science and science-based tools for everyday life. I'm Andrew Huberman, and I'm a professor of neurobiology and ophthalmology at Stanford School of Medicine.

[00:00:15] Today, we're going to talk about sleep. And I know what you're thinking - you've heard about sleep before. But I promise you, by the end of this episode, you'll understand sleep in a completely different way...

[Full transcript would continue for ~90 minutes of content]`,
    source: 'openai',
    createdAt: '2024-12-05T08:00:00Z',
  },
];

// Mock jobs
export const mockJobs: Job[] = [
  {
    id: 'job-001',
    episodeId: 'ep-001',
    appleUrl: 'https://podcasts.apple.com/us/podcast/example/id123?i=1000',
    status: 'completed',
    templateId: 'key-takeaways',
    createdAt: '2024-12-10T10:00:00Z',
    updatedAt: '2024-12-10T10:05:00Z',
  },
];

// Helper functions
export function getEpisodeById(id: string): Episode | undefined {
  return mockEpisodes.find(ep => ep.id === id);
}

export function getSummariesByEpisodeId(episodeId: string): Summary[] {
  return mockSummaries.filter(s => s.episodeId === episodeId);
}

export function getTranscriptByEpisodeId(episodeId: string): Transcript | undefined {
  return mockTranscripts.find(t => t.episodeId === episodeId);
}

export function getJobById(id: string): Job | undefined {
  return mockJobs.find(j => j.id === id);
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function calculateDaysRemaining(expiresAt: string): number {
  const now = new Date();
  const expires = new Date(expiresAt);
  const diffTime = expires.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}