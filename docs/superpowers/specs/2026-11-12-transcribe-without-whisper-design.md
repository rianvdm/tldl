# Transcribe without whisper-1

Issues: [#48](https://github.com/rianvdm/tldl/issues/48) (per-chunk resume), and the whisper-1 fallback in general. Builds on [#46](https://github.com/rianvdm/tldl/issues/46) (gpt-transcribe migration) and [#53](https://github.com/rianvdm/tldl/issues/53) (container-aware chunking).

## Why

OpenAI removes `whisper-1` from the API on 2027-02-26 ([deprecations](https://developers.openai.com/api/docs/deprecations)), along with the whole gpt-4o transcribe family. `gpt-transcribe` is the recommended model for recorded audio ([speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)), it is what tldl already uses as its primary model, and there is no newer or mini file-transcription model to move to. So the model choice stays; the fallback has to go.

Today the fallback is load-bearing. When `gpt-transcribe` returns `400 "Audio file might be corrupted or unsupported"`, `callWhisperApi()` retries the same bytes on `whisper-1`, which decodes them. That rescues real episodes (Supra Insider #135 on 2026-11-09, all five chunks; Lenny's twice in August). It is also the reason #48 exists: whisper-1 takes 50–150 s per 15 MB chunk against ~20 s for gpt-transcribe, so long episodes on the fallback lane run past the 15-minute queue wall clock, get killed, and restart from chunk 1 on every retry.

Removing whisper-1 without fixing why gpt-transcribe rejects those files would turn every one of those rescues into a failed episode. This design fixes the cause, removes the fallback, and adds the per-chunk cache from #48 as a safety net for the failures that remain (a killed or crashed attempt, an OpenAI 5xx on a late chunk).

## What the rejections actually are (spike, 2026-11-12)

The "corrupted or unsupported" 400 is gpt-transcribe refusing audio whose **declared** length is too long. It is not about corruption. This has been open, misdiagnosed, since March (`docs/audio-format-debugging.md`).

Evidence, from `1737704130_rss_088792fc20` (Supra Insider #135: 96 min, 96 kbps mono MP3, encoded by Descript, 69,384,349 bytes, Substack CDN):

- The file's first MPEG frame (at byte 95, right after a 95-byte ID3v2.4 tag) is a LAME/Xing **Info** frame declaring 221,342 frames, i.e. 96 minutes.
- Today's MP3 chunker sends chunk 1 as the raw first 15 MB, and prepends the file's first 512 bytes (ID3 tag + the Info frame + part of the next frame) to every later chunk. So every chunk carries the Info frame and declares 96 minutes. `ffprobe` reports 5,782 s for all of them.
- Sent straight to `gpt-transcribe`:

| Variant | Real audio | Declared | Result |
|---|---|---|---|
| A: chunk 1 as production sends it | 21.8 min | 96 min | 400 corrupted, 2 s |
| B: chunk 1, Info frame removed | 21.8 min | — | 200, 19 s, 17,806 chars |
| C: first 14 min, raw | 14 min | 96 min | 400 corrupted |
| D: first 14 min, Info frame removed | 14 min | — | 200, 17 s |
| E: chunk 5 as production sends it | 9.2 min | 96 min | 400 corrupted |
| F: chunk 5, ID3 + audio from the next frame sync, no Info frame | 9.2 min | — | 200, 8 s, ends on the sign-off |

- A real duration limit also exists, and it reports the same misleading error. Re-encoded clean files (32 kbps mono, no Info frame): 20, 30 and 45 min → 200; 70 min → 400 "corrupted or unsupported".
- Consistent with the other cases: Lenny's 2026-11-08 episode has the same Descript/Lavc Info frame declaring 58 min and transcribed with no fallback; the August Lenny's episodes (84–85 min) were rejected on every chunk. The 2026-11-09 Deprecated Human MP4 had chunk 1 rejected because its `moov` declared 68 min over 15 MB of data (that path is already fixed by #53's self-contained M4A chunks).

Working rule: **never upload anything whose real or declared duration exceeds the chunk cap.** The exact limit sits somewhere between 45 and 70 minutes (the Info-frame cases suggest about an hour); the design does not depend on finding it.

Spike artifacts (gitignored, laptop only): `/private/tmp/claude-501/-Users-rian-git-product-ai/27809db9-16d8-428c-929b-b21ebb15085c/scratchpad/supra/`.

## Goals

1. Every MP3 upload, chunk or whole file, contains no Xing, Info or VBRI frame, starts on an MPEG frame boundary, and covers at most `MAX_CHUNK_SECONDS` (15 min) of audio.
2. No MP3, MP4 or ADTS upload covers more than `MAX_CHUNK_SECONDS` of audio. A file under 25 MB but longer than the cap gets chunked. (OGG/WAV and other formats stay out of scope; see Non-goals.)
3. `whisper-1` is gone from production code, tests, scripts and docs. Every transcript is `gpt-transcribe`.
4. A gpt-transcribe rejection that survives goals 1–2 fails the job on the first attempt with a message that names the cause and the debugging command, instead of three identical queue retries.
5. A queue retry resumes from the first chunk without a cached transcript (#48), so a killed or crashed attempt doesn't re-pay OpenAI for finished chunks.
6. The three known-bad files transcribe end to end on gpt-transcribe alone (see Verification).

## Non-goals

- Finding gpt-transcribe's exact duration limit.
- Transcoding. Still no ffmpeg or WASM in the Worker.
- OGG, WAV, FLAC, WebM ("other" container). They keep today's byte-range path. A WAV chunk carries a header declaring the whole file's length, so it likely has the same bug, but podcasts essentially never ship WAV over 25 MB. Note it in docs; fix if one turns up.
- One queue message per chunk. The cache gets the resume behaviour for far less change (reasoning in #48).
- `prompt` / `keywords[]` transcription hints (#47), the 429 work (#52), the `skipValidation` memory issue (#51).
- Re-transcribing existing episodes. Transcripts produced by whisper-1 stay as they are.

## Anti-goals

- **A regression on MP3s that work today**, which is nearly every episode. Existing MP3 tests that assert transcription behaviour must keep passing; tests that assert the 512-byte header prepend change on purpose and should say so in the commit.
- **Silent partial transcripts.** The #54 tail-skip rule (drop a failed final chunk only if it holds ≤10% of the audio) still applies, and still alerts.
- **Losing episodes quietly.** Any rejection still ends in a red Discord alert and an `episode_failed` activity entry.
- **Holding a whole large file in memory.** Keep one chunk in memory at a time.

## Constraints

- Workers: 128 MB memory, 15-minute queue-consumer wall clock, no filesystem.
- OpenAI: 25 MB per upload; keep the 15 MB chunk target. Pricing is per minute, so more, shorter chunks cost the same; dropping the whisper fallback saves money ($0.006/min against $0.0045/min).
- Tests run in `@cloudflare/vitest-pool-workers`; binary fixtures must be importable modules (existing pattern in `scripts/make-audio-fixtures.sh`).
- Audio CDNs rate-limit. All audio fetches go through `fetchAudioChunk()`. The 15-minute cap means more chunks for long low-bitrate files (Supra #135 goes from 5 range requests to 7; a 121-minute file needs at least 9). That is accepted: the rate limits that bite are on the publisher origins, which `resolveAudioUrl()` already keeps out of the range reads, not on the CDNs.
- Repo norm: TDD the behaviour changes.

## Design

### 1. MP3 chunking on frame boundaries, without the VBR header

Replace `planByteChunks` for the `mp3` container with an MP3-specific planner. `other` keeps the existing byte path.

- **Find the first frame.** After any ID3 tag, scan forward for the first valid MPEG audio frame header (version, layer, bitrate, sample rate, padding, channel mode), confirmed by a second valid header one frame-length on. Use the probe; when the ID3 tag outgrows the probe, use the after-tag probe that `sniffContainer` already fetches (today it discards it unless the file is ADTS). Cap the scan at the probe. If that frame holds a `Xing`, `Info` or `VBRI` tag, record the frame count it declares and drop the frame. Audio starts at the next frame.
- **If no valid frame is found** (junk after the tag, free-format bitrate, an ID3 tag on something that isn't MP3), fall back to today's byte path for that file and log `mp3_frame_parse_failed`. Files like that work today or fail today; this design leaves them as they are.
- **Work out duration, pessimistically.** Compute both the declared duration (`frames × samplesPerFrame / sampleRate`, when a header exists) and the byte estimate (`audioBytes × 8 / firstFrameBitrate`), and use the **longer**. A stitched ad-inserted file whose first Info frame describes only a pre-roll then still gets chunked by its real length. A VBR file with no header gets a rough estimate; the 15-minute cap leaves a 3× margin under the smallest limit seen to pass (45 min).
- **Size chunks by both caps.** Bytes per chunk = min(`maxBytes`, bytes for `maxSeconds` at the estimated bitrate). Keep the 32 KB overlap for stitching. Supra #135 plans to 7 chunks of about 10.8 MB (the last about 6 min), not today's 5.
- **Start every chunk on a frame sync.** For chunk 2+, scan forward from the range start to the first validated frame header. `findMp3FrameBoundary` in `src/lib/audio.ts` (unused in production, tested in `test/audio.test.ts`) is the forward scan to reuse or tighten. If a chunk's first frame is itself a `Xing`/`Info`/`VBRI` frame (stitched files), drop it too. Don't scan chunk interiors for such frames: decoders read only the first.
- **Upload shape.** Tested working: ID3 tag + audio frames from a sync point (variant F). Frames alone, no tag, is the simpler shape and should also work. The builder picks, and confirms the choice in the pre-flight (Verification step 1). Either way, the MP3 path stops prepending the raw 512 bytes.
- `AUDIO_HEADER_SIZE_BYTES` and `prependHeader` stay: the `other` byte path still uses them.

### 2. Duration-aware routing for files under 25 MB

`transcribeAudio()` currently sends any file ≤25 MB as one upload. After fetching a small file, check its duration:

- MP3: the same first-frame parse as section 1. Strip the Xing/Info/VBRI frame from the whole-file upload regardless of length.
- MP4/M4A: duration from the track's sample table or `mdhd`, which `src/lib/mp4.ts` already reads.
- ADTS: estimate from the frames, as `planAdtsChunks` already does.

If the duration exceeds `MAX_CHUNK_SECONDS`, go through `transcribeWithChunking()` instead. A second fetch of a ≤25 MB file by range is acceptable; it's rare, and the builder can avoid it if `planChunks` can take an in-memory buffer cleanly. Update the stale comment on `MAX_CHUNK_SECONDS` in `src/lib/audio.ts` (it says MP4-only) and the "MP3/other byte path uses bytes only" notes.

### 3. Remove whisper-1

- `callWhisperApi()`: delete the fallback branch (`attemptWhisper1`, `whisper_fallback_*` events, the `isCorruptedError`/`isInputTooLarge` gate).
- A 400 whose body contains `corrupted or unsupported`, `input_too_large` or `too large for this model` becomes a deterministic failure: throw `AppError` with a new code, `AUDIO_REJECTED`. The consumer gives it one attempt, like `AUDIO_UNSUPPORTED`. The user-facing message (`mapErrorToUserMessage`) says the model rejected the audio and points at `npm run check:chunks -- <url> --transcribe`.
- Use a new code rather than reusing `AUDIO_UNSUPPORTED`, because `transcribeWithChunking` rethrows `AUDIO_UNSUPPORTED` before the #54 tail-skip check, and that ordering should stay for MP4/ADTS format failures. A rejected chunk goes through the tail-skip rule first; only if that doesn't apply does the job fail.
- **Rollout, decided by Rian 2026-11-12:** remove whisper-1 in the same release as the fix, not after a soak period. The safety net is logging good enough to diagnose a rejection from Workers Logs alone (section 3a), plus the existing Discord alert.
- `TranscriptionResult.model` is always `gpt-transcribe`; delete the mixed-model join (`"whisper-1+gpt-transcribe"`) and the `partialReason` wording that names both models.
- Update `src/types/index.ts`, the consumer and rescue-script comments, `README.md`, `CLAUDE.md` (request flow, chunking notes, the troubleshooting entries that explain the whisper lane, the rescue runbook's "mostly whisper-1 fallback" note) and add a "Resolved 2026-11-12" section to `docs/audio-format-debugging.md` pointing at this spec.
- **Names-only commit, last:** rename `callWhisperApi` → `callTranscriptionApi`, `TIMEOUTS.WHISPER_API_MS` → `TRANSCRIPTION_API_MS`, and the `whisper_api_*` log events → `transcription_api_*`, plus any doc prose that names them. #46 deferred this to keep the behaviour change readable; with whisper gone the old names are actively misleading. Keep it a separate commit so the diff stays reviewable.

### 3a. Logging for rejections

With no fallback, a rejection that slips through must be fixable from the logs, without re-downloading the file first. Workers Logs keep about 7 days.

- **Plan log.** Extend `chunking_plan` (and add an equivalent `upload_plan` event for whole-file uploads) with: `container`, `bitrateKbps`, `sampleRate`, `channels`, `vbrHeader` (`xing` / `info` / `vbri` / `none`), `vbrHeaderDropped`, `declaredSeconds`, `estimatedSeconds`, the `usedSeconds` the cap was applied to, `maxChunkSeconds`, and `audioHost` (hostname only). Log `mp3_frame_parse_failed` with the offset scanned and the first 32 bytes after the ID3 tag (hex) when the planner falls back to the byte path.
- **Rejection log.** On a deterministic 400, log `transcription_rejected` at error level with: `container`, `chunkIndex` / `totalChunks` (or `wholeFile: true`), `uploadBytes`, the chunk's planned seconds, `startByte` / `endByte` (or sample range), `firstBytesHex` (first 32 bytes of the upload), `vbrHeaderDropped`, the full OpenAI error body, and `audioHost`. It is the same Worker invocation as `job_started`, so the episode ID joins on `$metadata.requestId`.
- **Alert.** The Discord failure message and the activity-log entry for `AUDIO_REJECTED` name the chunk (for example "chunk 3/7 rejected by gpt-transcribe") and end with `npm run check:chunks -- <audio url> --transcribe`, so the debugging step is one copy-paste.
- **Runbook.** Add a short `CLAUDE.md` troubleshooting entry: what `transcription_rejected` means, the telemetry query that pulls it (filter `event` = `transcription_rejected`, ≤6-hour windows to avoid sampling), and to reproduce with the check script before changing code. Remove the whisper-lane entries it replaces.
- Never log the API key or full signed CDN URLs (Substack's carry an `Expires` signature): hostnames only.

### 4. Per-chunk transcript cache (#48)

Keep #48's design, adapted to the #53 chunk planner (#48's line numbers predate it):

- `ChunkTranscriptCache { get(key), put(key, { text }) }` on `TranscribeOptions`, passed into `transcribeWithChunking()`. The service stays storage-agnostic; the consumer builds the KV-backed implementation with the episode ID.
- **Key:** `chunkcache:{episodeId}:{planId}:{chunkIndex}`, where `planId` captures everything that decides chunk boundaries: a `CHUNK_PLAN_VERSION` constant, the container, the file's byte length, and the chunk's byte range (or sample range for MP4). Bump `CHUNK_PLAN_VERSION` whenever planner output changes, which this change itself does. A deploy between two attempts, or a CDN re-encode, then misses cleanly instead of stitching mismatched chunks.
- Check the cache before loading a chunk, so a hit skips the range fetch and the inter-chunk sleep. Write after each successful chunk. Both are best effort: a KV error is logged (`chunk_cache_read_failed` / `chunk_cache_write_failed`) and never fails the chunk. Log `chunk_cache_hit`.
- TTL: `TTL.JOB` (1 day). No explicit cleanup; once `transcript:{id}` exists the consumer never reaches chunking again.
- Only successful chunks are cached. The tail-skip path is unchanged.
- The rescue script runs `transcribeAudio()` without a cache; leave it that way.

### 5. Stale-job sweep

Raise `TIMEOUTS.JOB_MS` from 20 to 35 minutes, with a comment: one killed 15-minute attempt plus a resumed attempt plus summarising fits inside 35. Without it, a resumed job is marked failed (and alerts on Discord) while still running. The sweep (`src/lib/job-status-do.ts`) measures from `createdAt`, so the consumer's retry comment claiming that bumping `updatedAt` holds off a "119-min stale-job sweep" is wrong; correct it in the same commit. The rate-limit backoff interaction belongs to #52.

### 7. Tests need real MP3 bytes

Most chunked "MP3" tests in `test/transcription.test.ts` serve zero-filled buffers as `audio/mpeg`. `detectContainer` classifies those as `other`, so they exercise the byte path, not the MP3 path. The no-regression promise needs real fixtures: generate short MP3s (CBR with an Info frame, VBR with a Xing frame, no header, ID3 larger than the probe, a stitched file whose second piece starts with an Info frame) via `scripts/make-audio-fixtures.sh`, and test the planner and the routing against them. Existing `other`-path tests keep passing unmodified.

### 6. Chunk check script covers MP3

`scripts/check-mp4-chunks.ts` (`npm run check:chunks`) exits with an error for non-MP4 containers. Extend it to MP3 through the new planner: write each planned chunk, report `ffprobe` duration (must not show the file's full length), decode it fully, and with `--transcribe` send it to gpt-transcribe with no fallback. Rename the file if it no longer fits; keep the npm script name. This is the tool the new failure message points at.

## Verification

1. **Pre-flight on the laptop, before merging.** Run `npm run check:chunks -- <url> --transcribe` against:
   - Supra Insider #135 (`https://api.substack.com/feed/podcast/223758658/08f8c4a23d698de4c35722d94cc695f3.mp3`): 7 chunks, none over 15 minutes by `ffprobe`, all accepted;
   - one August Lenny's episode that fell back (from the Lenny's feed, `https://api.substack.com/feed/podcast/10845.rss`: "This CPO regrets that product management exists", or the Jen Abel episode);
   - two known-good MP3s from different hosts (for example, Lenny's from 2026-11-08 and a Megaphone episode);
   - the Deprecated Human MP4 from #53, as a regression check.
   Every chunk must be accepted, with transcript tails ending on the episode's sign-off.
2. `npm test` green.
3. Deploy is manual (`npm run deploy`). Afterwards, watch the next few cron runs in Workers Logs: no `whisper_*` events, `transcription_api_*` events with `model: gpt-transcribe`, `chunking_plan` carrying the new duration fields, and `chunk_cache_*` writes on chunked episodes. For the first two weeks, check `transcription_rejected` every few days; any hit gets the runbook treatment above.
4. Close #48. Comment on #52 that the wall-clock half of the double failure is gone.

## Left to the builder

- Frames-only versus ID3 + frames upload shape, decided by the pre-flight.
- How to avoid the second fetch in section 2, if it's clean.
- Exact sync-validation rules, provided they reject false syncs inside audio data.
- Fixture design for the new MP3 tests: a short generated MP3 with an Info frame is enough (extend `scripts/make-audio-fixtures.sh`).
