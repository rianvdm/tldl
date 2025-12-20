# TLDL - Too Long Didn't Listen

A dark-themed web application for browsing AI-generated podcast episode summaries.

## Features

### Episode List
- Browse recent podcast episode summaries
- View available summary templates (badges)
- Click any episode to view full details

### Episode Detail
- View episode metadata (podcast name, title, date, duration)
- Multiple summary templates available via tabs:
  - Key Takeaways & Practical Steps
  - Narrative Summary
  - ELI5 (Explain Like I'm 5)
- Full transcript viewer
- Download PDF functionality (simulated)
- Expiration countdown
- Delete episode (authenticated users only)

### Submit Form
- Paste Apple Podcasts episode URL
- Select summary template
- Form validation
- Processing status tracking

### Job Status
- Real-time progress tracking
- Visual progress bar
- Status indicators for each processing step:
  - Queued
  - Fetching metadata
  - Checking for transcript
  - Transcribing
  - Summarizing
  - Completed
- Estimated time remaining
- Auto-redirect on completion

## Design Features

- **Dark Mode**: Full dark theme by default
- **Responsive**: Mobile-friendly design
- **Accessible**: Proper ARIA labels and keyboard navigation
- **Modern UI**: Clean, minimalist design with smooth transitions
- **Visual Hierarchy**: Clear typography and spacing

## Mock Data

The application includes 5 example podcast episodes with:
- 3 different summary templates
- Full transcripts
- Various transcript sources (Apple, RSS, OpenAI)
- Realistic episode metadata

## Authentication Simulation

Toggle between authenticated and public views to see:
- Public: View episodes and summaries only
- Authenticated: Submit new episodes, delete episodes, regenerate summaries

## Technology Stack

- React 18
- TypeScript
- Tailwind CSS v4
- Radix UI components
- Lucide React icons
