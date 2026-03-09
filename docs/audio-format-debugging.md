# Audio Format Detection & Transcription Debugging

**Date:** 2026-03-08  
**Codebase:** [tldl](file:///Users/rian/Documents/GitHub/tldl) (Cloudflare Workers podcast transcription app)  
**Key files:**
- [transcription.ts](file:///Users/rian/Documents/GitHub/tldl/src/services/transcription.ts) — transcription service with format detection, chunking, and API calls
- [audio.ts](file:///Users/rian/Documents/GitHub/tldl/src/lib/audio.ts) — chunk range calculation, `TARGET_CHUNK_SIZE_BYTES`
- [constants.ts](file:///Users/rian/Documents/GitHub/tldl/src/lib/constants.ts) — `AUDIO_LIMITS` (has a duplicate `CHUNK_SIZE_BYTES` but it's **not used** for chunking — `audio.ts` has the real one)
- [transcription.test.ts](file:///Users/rian/Documents/GitHub/tldl/test/transcription.test.ts) — 43 tests covering format detection, chunking, and API calls

---

## The Problem

Two podcast episodes were submitted for transcription. One worked, one didn't.

| Episode | Podcast | Size | Result |
|---------|---------|------|--------|
| Search Engine | Search Engine | ~79MB, 4 chunks | ✅ Worked with `gpt-4o-mini-transcribe` |
| Qasar Younis interview | Lenny's Podcast | ~77MB, 4 chunks | ❌ Every chunk rejected with "corrupted or unsupported" |

The transcription model was recently switched from `whisper-1` to `gpt-4o-mini-transcribe` (in a prior commit on the `feat/gpt4o-mini-transcribe` branch, now merged to main).

---

## Root Cause Analysis

### What we know definitively (from diagnostic logs)

1. **The file is genuine MP3 with ID3v2.4 tags**
   - First bytes: `49 44 33 04 00 00 00 00 02 0d 54 58 58 58 00 00`
   - `49 44 33` = "ID3", version 2.4
   - ID3 tag body size: 269 bytes (syncsafe integer from bytes 6-9)
   - Audio frames start at byte 279
   - `54 58 58 58` = "TXXX" (standard user-defined text frame)

2. **After skipping the ID3 tag, the audio frames have MP3 sync bytes (layer bits confirm MPEG Layer III, not AAC)**

3. **The CDN (Lenny's Podcast uses Simplecast/ART19) correctly serves byte ranges**
   - Returns HTTP 206 with correct content-length
   - Content-type: `binary/octet-stream` (not `audio/mpeg`)
   - The data is real audio, not an error page or redirect

4. **The 20MB chunk is correctly constructed**
   - Correct byte range (0-20971519)
   - Buffer size matches (20971520 bytes)
   - Format detection labels it as `audio/mpeg` with `.mp3` extension

5. **`gpt-4o-mini-transcribe` rejects it with HTTP 400 in ~2-5 seconds**
   - Error: `"Audio file might be corrupted or unsupported"`
   - The ~5 second response time matches upload time for 20MB, suggesting the model checks the file immediately after upload and instantly rejects it

6. **This is a known issue** — web search confirmed many developers report `gpt-4o-mini-transcribe` rejecting files that `whisper-1` handles fine. Reported patterns include VBR MP3, certain encoders, and files around 15-20MB.

### What we DON'T know

- The specific MP3 encoding of Lenny's Podcast (bitrate mode, encoder, sample rate). We couldn't inspect the raw file locally because it's served from a CDN that rate-limits.
- Why Search Engine's MP3 works but Lenny's doesn't — likely an encoding difference (CBR vs VBR, different encoder software, etc.)
- Whether stripping the ID3 tag before sending would help (the model might not like the large ID3 header in a truncated chunk)

---

## Changes Made (chronological)

### 1. MIME-to-extension mapping + content-type threading
**Commit:** `feat: switch transcription from whisper-1 to gpt-4o-mini-transcribe`

- Added `extensionFromMime()` function mapping MIME types to file extensions
- Changed model from `whisper-1` to `gpt-4o-mini-transcribe`
- Threaded `contentType` from the HEAD validation through to `callWhisperApi`
- Previously, all files were hardcoded as `audio/mpeg` + `audio.mp3`

### 2. Magic byte detection (`detectAudioFormat`)
**Commit:** `fix: detect audio format via magic bytes instead of trusting CDN headers`

- Added `detectAudioFormat()` that inspects the first bytes of the audio buffer
- Detects: ID3 (MP3), MPEG sync word (MP3), ftyp (M4A), RIFF (WAV), OggS (OGG), EBML (WebM)
- Falls back to content-type header for unrecognized formats
- Added `audio_format_detected` log event

### 3. ADTS AAC vs MP3 distinction
**Commit:** `fix: distinguish ADTS AAC from MP3 in magic byte detection`

- The MPEG sync word (`0xFF 0xE_`) matches both MP3 and ADTS AAC
- Added layer bit inspection: `(byte1 >> 1) & 0x03`
  - `00` = ADTS AAC → returns `"m4a"`
  - `01` = MPEG Layer III (MP3) → returns `"mp3"`
- **This turned out NOT to be the issue** for Lenny's Podcast (the file is genuine MP3)

### 4. Diagnostic hex dump logging
**Commit:** `debug: add hex dump and CDN response logging for format detection`

- Added `firstBytesHex` (first 16 bytes as hex) and `bufferSizeBytes` to the `audio_format_detected` log
- Added `chunk_fetch_response` log with CDN response status, content-type, and content-length
- This is how we confirmed the file is valid MP3 with correct CDN responses

### 5. Chunk size reduction (20MB → 10MB)
**Commit:** `fix: reduce chunk size from 20MB to 10MB for gpt-4o-mini-transcribe`

- Web search suggested `gpt-4o-mini-transcribe` struggles with chunks >10-15MB
- Changed `CHUNK_SIZE_BYTES` in `constants.ts` to 10MB
- **BUT**: `constants.ts` value is NOT used for chunking! The real value is `TARGET_CHUNK_SIZE_BYTES` in `audio.ts` line 21
- Fixed `audio.ts` in a follow-up commit
- **Result: Still failed at 10MB.** The chunk size was not the issue.
- **Reverted both back to 20MB** in the final commit

> [!WARNING]
> **Duplicate constant:** `AUDIO_LIMITS.CHUNK_SIZE_BYTES` in `constants.ts` and `TARGET_CHUNK_SIZE_BYTES` in `audio.ts` are separate values. The one actually used for chunking is in `audio.ts`. This should be consolidated at some point.

### 6. ID3 tag parsing (skip past tag to check audio frames)
**Commit:** `fix: parse past ID3 tags to detect AAC audio underneath`

- ID3 tags are codec-agnostic — some podcast hosts add them to AAC files
- `detectAudioFormat()` now parses the ID3v2 tag size (syncsafe integer from bytes 6-9), skips past the tag, and checks the actual audio frame bytes
- Added `id3_tag_parsed` log event with version, tag body size, and audio start offset
- **Result:** Confirmed the audio frames after the ID3 tag ARE MP3 (not AAC). The format detection is now fully correct, but the model still rejects the file.

### 7. Whisper-1 fallback (current solution)
**Commit:** `feat: auto-fallback to whisper-1 when gpt-4o-mini-transcribe rejects audio`

- When `callWhisperApi` gets a 400 with "corrupted or unsupported" from `gpt-4o-mini-transcribe`, it automatically retries the same chunk with `whisper-1`
- Same API key, same base URL, same audio data — just a different model name
- Logs: `whisper_fallback_start` → `whisper_fallback_success` (or `whisper_fallback_failed`)
- If the fallback also fails, falls through to the original error
- **Status: Deployed, awaiting test results**

---

## Current State (as of 2026-03-08 14:41 MT)

### What's deployed
- `gpt-4o-mini-transcribe` as primary model
- Automatic fallback to `whisper-1` on "corrupted or unsupported" errors
- Magic byte format detection with ID3 tag parsing
- ADTS AAC vs MP3 distinction
- 20MB chunk size
- Full diagnostic logging (hex dump, CDN response, ID3 parsing)

### Confirmed: whisper-1 fallback works ✅

Tested with Lenny's Podcast episode. All 4 chunks were rejected by `gpt-4o-mini-transcribe` and successfully transcribed by `whisper-1`:

| Chunk | gpt-4o-mini (rejected) | whisper-1 (success) | Text length |
|-------|----------------------|-------------------|-------------|
| 1 (20MB) | 5s | 53s | 21,505 chars |
| 2 (20MB) | 5s | 48s | 22,109 chars |
| 3 (20MB) | 6s | 82s | 23,475 chars |
| 4 (17MB) | 4s | 50s | 20,235 chars |

Total transcript: 87,323 chars. Job completed with tags: `ai, business, technology`.

The overhead of trying gpt-4o-mini-transcribe first adds ~20 seconds total (4 × ~5s rejection). For podcasts where gpt-4o-mini-transcribe works (like Search Engine), there's no overhead.

### Known risks
- The whisper-1 fallback adds ~5s latency per chunk for files the primary model rejects
- whisper-1 may eventually be deprecated by OpenAI
- The fallback only triggers on "corrupted or unsupported" — other 400 errors are not retried

---

## Possible Future Improvements

1. **Consolidate chunk size constants** — `AUDIO_LIMITS.CHUNK_SIZE_BYTES` (constants.ts) vs `TARGET_CHUNK_SIZE_BYTES` (audio.ts). Only `audio.ts` is actually consumed by `calculateChunkRanges`.

2. **Track fallback frequency** — if whisper-1 fallback triggers often, consider switching back to whisper-1 as the primary model (it's more tolerant but may be costlier/slower).

3. **CDN rate limit handling** — the CDN for Lenny's Podcast returns 429 on the HEAD request in `validateAudioUrl()`. The retry delay is only 5 seconds with `isRateLimited: false` (because the error is `AUDIO_UNAVAILABLE`, not `RATE_LIMITED`). Could add smarter backoff for CDN 429s.

4. **Audio format logging for successful runs** — `audio_format_detected` log now includes hex dump. Consider keeping a lighter version permanently (just the detected format and content-type mismatch) and removing the hex dump.

5. **Test with more podcast CDNs** — different hosting platforms (Megaphone, Libsyn, Anchor, Podbean) may have different behaviors with content-type headers and byte-range support.

6. **Per-podcast model memory** — if a podcast's CDN consistently fails with gpt-4o-mini-transcribe, cache that and skip straight to whisper-1 for future episodes from the same feed.

---

## Key Log Events for Debugging

| Event | Where | What it tells you |
|-------|-------|-------------------|
| `id3_tag_parsed` | `detectAudioFormat` | ID3 version, tag size, audio start offset |
| `audio_format_detected` | `callWhisperApi` | Detected extension, MIME, header content-type, first 16 bytes hex, buffer size |
| `chunk_fetch_response` | `fetchAudioChunkOnce` | CDN response status (200/206), content-type, content-length, range requested |
| `whisper_fallback_start` | `callWhisperApi` | Fallback triggered, original model, fallback model |
| `whisper_fallback_success` | `callWhisperApi` | Fallback worked, elapsed time |
| `whisper_fallback_failed` | `callWhisperApi` | Fallback also failed, status and error |
| `whisper_api_error` | `callWhisperApi` | Original model error (status, elapsed, error text) |

---

## How to Reproduce

1. Submit Lenny's Podcast episode (iTunes ID `1627920305`, episode ID `1000753869845`)
2. The episode title: "The most successful AI company you've never heard of | Qasar Younis"
3. The audio CDN serves `binary/octet-stream` content-type
4. The file is ~77MB MP3 with ID3v2.4 tags
5. `gpt-4o-mini-transcribe` rejects every chunk with "corrupted or unsupported"
6. The whisper-1 fallback kicks in and transcribes successfully

