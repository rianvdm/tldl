# Transcript Paragraph Formatting Plan

## Overview

Modify the Whisper transcription service to output formatted text with paragraph breaks, using a hybrid heuristic based on time gaps between segments and paragraph length.

**Goal:** Transform transcripts from walls of text into readable paragraphs.

**Scope:** New Whisper transcripts only (not RSS transcripts or existing data).

## Current State

- Whisper API is called with `response_format: "text"` which returns plain text
- Transcripts are stored as a single blob of text with no paragraph breaks
- UI renders with `white-space: pre-wrap` but there are no line breaks to display

## Proposed Solution

### Use Whisper's Verbose JSON Format

Change `response_format` from `"text"` to `"verbose_json"`. This returns:

```json
{
  "text": "Full transcript text...",
  "segments": [
    { "start": 0.0, "end": 2.5, "text": "Welcome to the show." },
    { "start": 2.5, "end": 5.1, "text": "Today we're discussing AI." },
    { "start": 7.8, "end": 10.2, "text": "I'm joined by Dr. Smith." }
  ]
}
```

### Paragraph Break Heuristic

Use a hybrid approach combining time gaps and text length to handle both slow-paced interviews and rapid back-and-forth conversations.

**Start a new paragraph if:**

| Condition | Rationale |
|-----------|-----------|
| Gap >= 1.5 seconds | Natural pause in speech |
| Gap >= 0.8 seconds AND paragraph >= 200 words AND ends with `.!?` | Long paragraph with medium pause |
| Paragraph >= 400 words AND ends with `.!?` | Force break on very long paragraphs |

**Always continue same paragraph if:**

| Condition | Rationale |
|-----------|-----------|
| Gap < 0.5 seconds | Rapid speech / people talking over each other |

### Example Output

**Before (current):**
```
Welcome to the show today we're going to talk about AI and its impact on society I'm joined by my guest Dr Smith thank you for having me it's great to be here let's start with the basics what is AI...
```

**After (with paragraphs):**
```
Welcome to the show. Today we're going to talk about AI and its impact on society. I'm joined by my guest, Dr. Smith.

Thank you for having me. It's great to be here.

Let's start with the basics. What is AI?
```

## Files to Modify

### 1. `src/services/transcription.ts`

**Add types for Whisper verbose JSON response:**

```typescript
interface WhisperSegment {
    start: number;      // Start time in seconds
    end: number;        // End time in seconds
    text: string;       // Segment text
}

interface WhisperVerboseResponse {
    text: string;       // Full text (fallback)
    segments: WhisperSegment[];
}
```

**Update `callWhisperApi()` function:**
- Change `response_format` from `"text"` to `"verbose_json"`
- Parse JSON response
- Return the `WhisperVerboseResponse` object instead of plain string

**Add new function `formatTranscriptWithParagraphs()`:**

```typescript
function formatTranscriptWithParagraphs(segments: WhisperSegment[]): string {
    // Implementation of paragraph break heuristic
    // Returns formatted string with \n\n between paragraphs
}
```

**Update `transcribeAudio()` (small files):**
- Call updated `callWhisperApi()` which returns verbose JSON
- Apply `formatTranscriptWithParagraphs()` to segments
- Return formatted text

**Update `transcribeWithChunking()` (large files):**
- Each chunk returns verbose JSON with segments
- Apply formatting per chunk
- Stitch chunks together (existing logic)
- Final cleanup pass to avoid triple+ newlines

**Add fallback:**
- If `segments` array is empty/missing, fall back to the `text` field

### 2. `test/transcription.test.ts`

**Add tests for `formatTranscriptWithParagraphs()`:**
- Segments with 1.5s+ gaps -> creates paragraph breaks
- Rapid segments (<0.5s gaps) -> stays in same paragraph
- Long paragraph (400+ words) -> forces break at sentence end
- Medium paragraph (200+ words) with 0.8s+ gap -> breaks at sentence end
- Empty segments array -> returns empty string
- Single segment -> returns trimmed text

## No Changes Needed

| Component | Reason |
|-----------|--------|
| `src/types/index.ts` | `Transcript.text` stays as `string` |
| `src/lib/kv.ts` | Storage format unchanged |
| `src/routes/public.ts` | Already uses `white-space: pre-wrap` |
| `src/routes/api.ts` | Download endpoint works with `\n\n` |
| RSS transcript parsing | Out of scope for this change |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Whisper API changes response format | Fallback to `text` field if `segments` missing |
| Chunked transcription edge cases | Format each chunk independently, clean up at stitch time |
| Very short podcasts with few segments | Works fine - just fewer/no paragraph breaks |
| People talking over each other | <0.5s gap rule keeps rapid speech together; length-based breaks ensure paragraphs don't get too long |

## Estimated Effort

| File | Lines Added/Modified |
|------|---------------------|
| `src/services/transcription.ts` | ~80 lines |
| `test/transcription.test.ts` | ~60 lines |

## Testing Strategy

1. Unit tests for `formatTranscriptWithParagraphs()` with various segment patterns
2. Integration test verifying `transcribeAudio()` output contains `\n\n` separators
3. Manual test with real podcast episode to verify readability

## Rollout

1. Implement changes
2. Run test suite
3. Test locally with a real episode submission
4. Deploy to production
5. New transcripts will have paragraphs; existing transcripts unchanged
