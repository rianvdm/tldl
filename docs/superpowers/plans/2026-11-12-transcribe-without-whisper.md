# Transcribe Without whisper-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every upload `gpt-transcribe` receives is ≤15 minutes with no stale duration header, so the whisper-1 fallback can be deleted, and a retried job resumes from its cached chunks.

**Architecture:** A new pure module (`src/lib/mp3.ts`) parses MPEG frames and VBR headers. A new MP3 planner in `src/services/chunk-planning.ts` uses it to cut frame-aligned, header-free chunks sized by bytes and duration. `transcribeAudio()` runs every file, small ones included, through `planChunks()` (small files use an in-memory range reader), and one chunk loop transcribes any plan, with a best-effort KV cache per chunk. whisper-1 goes away; a model rejection becomes `AUDIO_REJECTED`, fails on the first attempt, and is logged in enough detail to debug from Workers Logs.

**Tech Stack:** TypeScript on Cloudflare Workers, Vitest with `@cloudflare/vitest-pool-workers`, KV, ffmpeg/ffprobe for fixtures and the local check script (`tsx`), Node 22.

**Spec:** `docs/superpowers/specs/2026-11-12-transcribe-without-whisper-design.md`. Read it before starting any task; its spike table is the evidence behind every number below.

**Branch:** `fix/transcribe-without-whisper`, an ordinary branch in the main clone at `/Users/rian/git/tldl` (no worktree). Merging does not deploy; `npm run deploy` is manual and needs Rian's go-ahead.

## Global Constraints

- Transcription model: `gpt-transcribe` only. No production code, test, script or doc may send or name `whisper-1` when this plan is done (historical docs under `docs/_ARCHIVE/` excepted).
- `MAX_CHUNK_SECONDS` = `15 * 60` applies to MP3, MP4 and ADTS uploads, chunked or whole. `TARGET_CHUNK_SIZE_BYTES` stays 15 MB; the upload limit stays 25 MB (`MAX_AUDIO_SIZE_BYTES`).
- Overlap: `CHUNK_OVERLAP_BYTES` (32 KB) and `CHUNK_OVERLAP_SECONDS` (2), applied as `planAdtsChunks` already does: `min(CHUNK_OVERLAP_BYTES, round(bytesPerSecond × CHUNK_OVERLAP_SECONDS), floor(maxChunkBytes / 4))`.
- MP3 chunks are bare MPEG frames: no ID3 tag, no raw 512-byte prepend, never a Xing/Info/VBRI frame as the first frame. (Frames-only uploads were verified against gpt-transcribe on 2026-11-12: 200 for a 14-minute cut and a 9-minute tail.)
- The `other` container (OGG, WAV, anything unrecognised) keeps today's byte path, including the 512-byte prepend.
- Duration estimate: use the longer of declared and byte-estimated seconds.
- Logs carry hostnames only, never full audio URLs (Substack CDN URLs are signed) and never the API key.
- New error code: `AUDIO_REJECTED`, HTTP 422, one queue attempt, never retried by `withRetry`.
- Chunk cache: KV key `chunkcache:{episodeId}:{chunkKey}`, TTL `TTL.JOB` (1 day), value `{ text: string }`, best effort both ways.
- `TIMEOUTS.JOB_MS` = `35 * 60 * 1000`.
- TDD every behaviour change. `npm test` and `npm run typecheck` pass at the end of every task.
- Fixtures are importable modules in `test/fixtures/audio.ts`, regenerated only via `bash scripts/make-audio-fixtures.sh`.

## Review Focus

1. **A small, under-25 MB file that works today must still work.** A fragmented or truncated MP4 that `gpt-transcribe` accepts as a whole file would start failing if the small-file path propagated the planner's `AUDIO_UNSUPPORTED`. Expected: the small-file path falls back to today's whole-file upload when planning throws. Test in Task 3.
2. **A rejection message containing a 5xx-looking number gets retried.** `isServerError` matches `/5\d{2}/` anywhere in the message, and chunk byte offsets ("bytes 15695872-…") contain such runs. Expected: `AUDIO_REJECTED` is never transient. Test in Task 4.
3. **False sync words inside MP3 audio data.** `0xFF 0xE?` occurs naturally in compressed audio, so a resync on one unconfirmed header cuts a chunk at garbage. Expected: a frame only counts when a second valid header sits one frame-length later. Test in Task 1.
4. **A chunk-boundary change between attempts.** A deploy of this branch while a job is mid-retry, or a CDN serving a re-encoded file, would otherwise stitch cached chunks from a different plan. Expected: a cached chunk is used only when plan version, container, file size, index and range all match. Test in Task 6.
5. **A stitched ad-inserted MP3 whose first Info frame describes only a pre-roll.** Expected: chunks are sized by the longer byte estimate, and a chunk whose first frame is an Info frame drops it. Test in Task 2.

---

### Task 1: MP3 frame and VBR header parsing

**Files:**
- Create: `src/lib/mp3.ts`
- Modify: `scripts/make-audio-fixtures.sh`, regenerate `test/fixtures/audio.ts`
- Test: `test/mp3.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Mp3FrameHeader {
      version: 1 | 2 | 2.5; bitrateKbps: number; sampleRate: number;
      channels: 1 | 2; padding: boolean; crc: boolean;
      frameLength: number; samplesPerFrame: 1152 | 576;
  }
  export function parseMp3FrameHeader(bytes: Uint8Array, offset: number): Mp3FrameHeader | null;
  export function findMp3Frame(bytes: Uint8Array, from: number, to?: number): number; // -1 when none
  export type VbrHeaderKind = "xing" | "info" | "vbri";
  export interface VbrHeader { kind: VbrHeaderKind; frames: number | null }
  export function readVbrHeader(bytes: Uint8Array, frameOffset: number, header: Mp3FrameHeader): VbrHeader | null;
  export interface Mp3Analysis {
      firstFrameOffset: number;   // absolute file offset of the first frame
      audioStart: number;         // absolute offset of the first audio frame (after any VBR header frame)
      header: Mp3FrameHeader;     // the frame at audioStart
      vbrHeader: VbrHeaderKind | "none";
      declaredSeconds: number | null;
      estimatedSeconds: number;
      usedSeconds: number;        // max(declaredSeconds ?? 0, estimatedSeconds)
  }
  export function analyzeMp3(probe: Uint8Array, probeOffset: number, fileSize: number, scanFrom: number): Mp3Analysis | null;
  export const MP3_RESYNC_WINDOW_BYTES: number; // 16 * 1024
  ```

- [ ] **Step 1: Add MP3 fixtures to `scripts/make-audio-fixtures.sh` and regenerate**

All 5 s of the existing 440 Hz tone source, mono, 44.1 kHz, via libmp3lame, emitted as base64 constants:
- `MP3_CBR_INFO`: `-b:a 64k` (ffmpeg writes an `Info` frame by default for CBR).
- `MP3_VBR_XING`: `-q:a 5` (writes `Xing`).
- `MP3_NO_HEADER`: `-b:a 64k -write_xing 0`.
- `MP3_BIG_ID3`: `MP3_CBR_INFO` plus `-metadata comment=<70,000 'x' characters>` so the ID3 tag exceeds the 64 KB probe; assert in the script that its ID3 body is > 65,536 bytes.
- `MP3_STITCHED`: the bytes of a 2 s `-b:a 64k` file followed by the bytes of `MP3_CBR_INFO` (`cat a b`), so the second piece starts with its own ID3 tag and Info frame.

Run: `bash scripts/make-audio-fixtures.sh`
Expected: `Wrote …/test/fixtures/audio.ts`, existing MP4/ADTS constants unchanged in content.

- [ ] **Step 2: Write failing tests in `test/mp3.test.ts`**

```ts
it("parses MPEG-1 Layer III mono 96 kbps (Supra Insider #135's first frame)", () => {
    const h = parseMp3FrameHeader(new Uint8Array([0xff, 0xfb, 0x70, 0xc0]), 0);
    expect(h).toMatchObject({ version: 1, bitrateKbps: 96, sampleRate: 44100, channels: 1, padding: false, frameLength: 313, samplesPerFrame: 1152 });
});
it("rejects free-format, bad-bitrate, reserved-rate and non-Layer-III headers", () => { /* bitrate index 0 and 15, sample-rate index 3, layer bits 10 → null */ });
it("findMp3Frame ignores a lone sync word with no second header one frame on", () => {
    // MP3_NO_HEADER audio with 0xFF 0xFB 0x70 0xC0 written 50 bytes into a frame's payload:
    // findMp3Frame(bytes, start-of-that-frame + 1) returns the next real frame, not the planted one.
});
it("findMp3Frame returns -1 when no confirmed frame starts before `to`", () => {});
it("readVbrHeader finds Info in CBR, Xing in VBR, nothing without a header", () => {
    // MP3_CBR_INFO → { kind: "info", frames: >0 }; MP3_VBR_XING → { kind: "xing", frames: >0 }; MP3_NO_HEADER → null
});
it("analyzeMp3 skips the Info frame and declares ~5 s", () => {
    // MP3_CBR_INFO: audioStart === firstFrameOffset + Info frame length; vbrHeader "info";
    // declaredSeconds within 0.1 of 5; usedSeconds >= estimatedSeconds and >= declaredSeconds
});
it("analyzeMp3 uses the longer estimate when the header under-declares", () => {
    // MP3_STITCHED: declaredSeconds ≈ 2 (first piece's Info), usedSeconds ≈ 7 (byte estimate)
});
it("analyzeMp3 reads a probe that starts after a large ID3 tag", () => {
    // MP3_BIG_ID3: probe = bytes.slice(id3, id3 + 65536), probeOffset = id3, scanFrom = id3 → firstFrameOffset === id3
});
it("analyzeMp3 returns null when nothing after the tag is a confirmed frame", () => {});
```

Run: `npm test -- test/mp3.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/mp3.ts`**

Standard MPEG audio header tables (Layer III only; MPEG-2 and 2.5 share the LSF bitrate table). `frameLength = floor(coef × bitrate × 1000 / sampleRate) + padding`, coef 144 for MPEG-1, 72 for MPEG-2/2.5. `findMp3Frame` accepts an offset only when a second header parses at `offset + frameLength` (or the frame ends exactly at `bytes.length`). Xing/Info tag offset: 4-byte header, +2 if `crc`, + side info (MPEG-1: 32 stereo / 17 mono; MPEG-2/2.5: 17 stereo / 9 mono); frames field at tag+8 when flags bit 0 is set. VBRI: tag at frame offset 36, frames at tag+14. `estimatedSeconds = (fileSize − audioStart) × 8 / (header.bitrateKbps × 1000)` using the frame at `audioStart`. `declaredSeconds = frames × samplesPerFrame / sampleRate` from the first frame's VBR header. Move `findMp3Frame` here and delete the unused `findMp3FrameBoundary` / `findMp3FrameBoundaryReverse` from `src/lib/audio.ts` along with their tests in `test/audio.test.ts` (nothing in production imports them).

- [ ] **Step 4: Run tests**

Run: `npm test -- test/mp3.test.ts test/audio.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mp3.ts src/lib/audio.ts test/mp3.test.ts test/audio.test.ts scripts/make-audio-fixtures.sh test/fixtures/audio.ts
git commit -m "Parse MP3 frames and Xing/Info/VBRI headers (#48)"
```

### Task 2: MP3 chunk planner

**Files:**
- Modify: `src/services/chunk-planning.ts`
- Test: `test/chunk-planning.test.ts` (create if absent; follow `test/transcription.test.ts`'s in-memory `fetchRange` pattern)

**Interfaces:**
- Consumes: Task 1's `analyzeMp3`, `findMp3Frame`, `parseMp3FrameHeader`, `readVbrHeader`, `MP3_RESYNC_WINDOW_BYTES`.
- Produces:
  ```ts
  export const CHUNK_PLAN_VERSION = 2;
  export interface ChunkPlanAudio {
      bitrateKbps?: number; sampleRate?: number; channels?: number;
      vbrHeader?: VbrHeaderKind | "none"; vbrHeaderDropped?: boolean;
      declaredSeconds?: number | null; estimatedSeconds?: number; usedSeconds?: number;
  }
  // ChunkPlan gains:   fileSize: number; audio: ChunkPlanAudio;   ({} for "other")
  // PlannedChunk gains: cacheId: string; plannedSeconds?: number;
  //   cacheId: "b{startByte}-{endByte}" on byte/MP3/ADTS paths, "s{firstSample}-{endSample}" on MP4.
  ```

- [ ] **Step 1: Write failing tests**

Use `planChunks` with an in-memory `fetchRange` over each fixture and `limits = { maxBytes: TARGET_CHUNK_SIZE_BYTES, maxSeconds: 2 }` so 5 s fixtures produce several chunks.
```ts
it("MP3 with Info frame: no chunk starts with a VBR header frame, every chunk starts on a confirmed frame", async () => {
    // MP3_CBR_INFO → container "mp3", chunks.length === 3; for each loaded chunk:
    // parseMp3FrameHeader(b, 0) !== null && readVbrHeader(b, 0, header) === null && b[0..2] !== "ID3"
});
it("MP3 plan carries the audio summary", async () => {
    // plan.audio: vbrHeader "info", vbrHeaderDropped true, bitrateKbps 64, sampleRate 44100, channels 1, usedSeconds ≈ 5
});
it("chunk 1 starts at audioStart, after the ID3 tag and the Info frame", async () => {});
it("plannedSeconds never exceeds maxSeconds", async () => {});
it("stitched MP3: chunks sized by the byte estimate; a chunk starting on the second piece's Info frame drops it", async () => {
    // MP3_STITCHED with maxSeconds 2 → ≥4 chunks (byte estimate ≈ 7 s), and no loaded chunk starts with a VBR header frame
});
it("large ID3 tag: plans from the after-tag probe", async () => {
    // MP3_BIG_ID3: container "mp3", plan.audio.vbrHeader "info", chunk 1's first bytes are a frame header
});
it("unparseable MP3 falls back to the byte path and logs mp3_frame_parse_failed", async () => {
    // ID3 tag followed by 2 KB of zeros: chunks match calculateChunkRanges(fileSize, maxBytes); a console.log spy sees
    // { event: "mp3_frame_parse_failed", scanFrom, firstBytesHex } where firstBytesHex is the 32 bytes after the ID3 tag,
    // formatted like audio_format_detected's (lowercase, space-separated pairs)
});
it("every planner sets cacheId", async () => {
    // MP3: /^b\d+-\d+$/; MP4 (MOOV_FIRST_M4A): /^s\d+-\d+$/; ADTS_AAC: /^b\d+-\d+$/; other: /^b\d+-\d+$/
});
```

Run: `npm test -- test/chunk-planning.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `planMp3Chunks(input, audioProbe, audioProbeOffset)` in `src/services/chunk-planning.ts`**

`sniffContainer` additionally returns `audioProbeOffset` (0, or `id3Bytes` when it fetched the after-tag probe) and keeps the after-tag probe for `mp3` too, not only `adts`. `planChunks` routes `mp3` to `planMp3Chunks`; `other` stays on `planByteChunks`. In `planMp3Chunks`: `analyzeMp3(audioProbe, audioProbeOffset, fileSize, id3Bytes)`; on `null`, log `mp3_frame_parse_failed` and return `planByteChunks("mp3", input)`. Otherwise `bytesPerSecond = (fileSize − audioStart) / usedSeconds`, `maxChunkBytes = min(limits.maxBytes, floor(bytesPerSecond × limits.maxSeconds))`, overlap per Global Constraints, ranges from `calculateChunkRanges(fileSize − audioStart, maxChunkBytes, overlap)` shifted by `audioStart`. Chunk 1's `load` returns its range unchanged. A later chunk's `load` finds the first confirmed frame with `findMp3Frame(body, 0, MP3_RESYNC_WINDOW_BYTES)`; if that frame holds a VBR header, skip it too; if none is found, log `mp3_resync_failed` (chunk index, `startByte`) and return the body unchanged. `plannedSeconds = sizeBytes / bytesPerSecond`. Fill `plan.audio` for MP3 from the analysis; for MP4 set `usedSeconds` from `track.durationSeconds`; for ADTS set `usedSeconds = audioBytes / bytesPerSecond` and `plannedSeconds` per chunk. Update the module and `ChunkSizeLimits` comments that say the MP3 path uses bytes only. Update the `MAX_CHUNK_SECONDS` comment in `src/lib/audio.ts` (no longer MP4-only).

- [ ] **Step 3: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS. The existing test asserting the 512-byte prepend on an MP3 chunk now fails: rewrite it to assert the new MP3 behaviour, and say so in the commit message. Tests of the `other` path pass unmodified.

- [ ] **Step 4: Commit**

```bash
git add src/services/chunk-planning.ts src/lib/audio.ts test/chunk-planning.test.ts test/transcription.test.ts
git commit -m "Plan MP3 chunks on frame boundaries without the VBR header, capped at 15 minutes (#48)

The MP3 path no longer prepends the file's first 512 bytes: that copied the
Info frame, which declares the whole file's length, into every chunk."
```

### Task 3: Duration-aware routing for every upload

**Files:**
- Modify: `src/services/transcription.ts` (`transcribeAudio`, `transcribeWithChunking`)
- Test: `test/transcription.test.ts`

**Interfaces:**
- Consumes: `planChunks`, `ChunkPlan`, `ChunkPlanAudio`, `PlannedChunk.plannedSeconds` from Task 2.
- Produces (module-internal, used by Tasks 4 and 6):
  ```ts
  async function planRemote(audioUrl: string, contentLength: number, contentType: string, limits: ChunkSizeLimits): Promise<ChunkPlan>;
  async function transcribePlan(plan: ChunkPlan, ctx: {
      apiKey: string; provider: ProviderConfig; contentType: string; audioHost: string;
      onProgress?: (current: number, total: number) => void;
  }): Promise<TranscriptionResult>;
  function inMemoryRange(buffer: ArrayBuffer): FetchRange;
  ```
  `transcribeWithChunking` becomes `planRemote` + `transcribePlan`. `ctx` gains `chunkCache` in Task 6.

- [ ] **Step 1: Write failing tests**

```ts
it("uploads a small MP3 whole, without its Info frame", async () => {
    // MP3_CBR_INFO served as the file: one OpenAI call; the uploaded blob's first frame has no VBR header
});
it("chunks a small file whose duration exceeds the cap", async () => {
    // MP3_CBR_INFO with chunkLimits { maxSeconds: 2 }: 3 OpenAI calls, stitched text in order
});
it("uploads a small MP4 under the cap byte-for-byte as today", async () => {
    // MOOV_FIRST_M4A: one call; uploaded bytes equal the fixture
});
it("uploads a small 'other' file whole as today", async () => {});
it("falls back to the whole-file upload when planning a small file throws AUDIO_UNSUPPORTED", async () => {
    // FRAGMENTED_M4A: one OpenAI call with the original bytes, and an upload_plan_unavailable log
});
it("logs chunking_plan with the audio summary and the host only", async () => {
    // fields: container, bitrateKbps, vbrHeader, vbrHeaderDropped, declaredSeconds, estimatedSeconds,
    // usedSeconds, maxChunkSeconds 900 (default limits), audioHost "example.com"; no field contains "https://"
});
it("logs upload_plan for a whole-file upload with the same fields", async () => {});
```

Run: `npm test -- test/transcription.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

Small-file path in `transcribeAudio`, after `fetchAudio` and the existing size-mismatch check: plan with `planChunks({ probe: first CONTAINER_PROBE_BYTES of the buffer, fileSize: buffer.byteLength, contentType, limits: { maxBytes: uploadLimitBytes, maxSeconds: chunkLimits.maxSeconds }, fetchRange: inMemoryRange(buffer) })`. If that throws `AppError` `AUDIO_UNSUPPORTED`, log `upload_plan_unavailable` (reason) and upload `prepareForUpload(buffer)` as today. If the plan has more than one chunk, `transcribePlan(plan, …)`. Otherwise log `upload_plan` and upload `await plan.chunks[0].load()` for `mp3`, `prepareForUpload(buffer)` for every other container. `audioHost` = `new URL(audioUrl).hostname` after resolution. Extend `chunking_plan` with `...plan.audio`, `maxChunkSeconds: limits.maxSeconds` and `audioHost`.

- [ ] **Step 3: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/transcription.ts test/transcription.test.ts
git commit -m "Route every upload through the chunk planner so none exceeds 15 minutes (#48)"
```

### Task 4: Remove whisper-1 and make rejections deterministic

**Files:**
- Modify: `src/services/transcription.ts`, `src/lib/constants.ts`, `src/lib/errors.ts`, `src/lib/retry.ts`, `src/types/index.ts`
- Test: `test/transcription.test.ts`, `test/retry.test.ts` (or the existing "error predicates" block in `test/transcription.test.ts`)

**Interfaces:**
- Consumes: `transcribePlan`, `PlannedChunk.logFields` / `plannedSeconds` / `cacheId` from Tasks 2–3.
- Produces: `ERROR_CODES.AUDIO_REJECTED = "AUDIO_REJECTED"`; user message prefix `"gpt-transcribe rejected "` followed by `"chunk {n}/{total} of the audio"` or `"the audio"` (whole file); `isTransientError` returns `false` for `AppError` with code `AUDIO_REJECTED` or `AUDIO_UNSUPPORTED`.

- [ ] **Step 1: Write failing tests**

```ts
it("never retries AUDIO_REJECTED, even when its message contains a 5xx-like number", () => {
    expect(isTransientError(new AppError(ERROR_CODES.AUDIO_REJECTED, "gpt-transcribe rejected chunk 2/7 (bytes 15695872-31424511)"))).toBe(false);
});
it("a 400 'corrupted or unsupported' throws AUDIO_REJECTED after exactly one OpenAI call, with no whisper-1 request", async () => {
    // whole-file: fetchSpy sees one POST to the transcriptions URL; no FormData with model "whisper-1"; error.code AUDIO_REJECTED;
    // error.message === "gpt-transcribe rejected the audio"
});
it("input_too_large and 'too large for this model' are rejections too", async () => {});
it("a rejected middle chunk fails the job as AUDIO_REJECTED naming the chunk", async () => {
    // 3-chunk plan, chunk 2 400s → message "gpt-transcribe rejected chunk 2/3 of the audio"; chunk 3 never requested
});
it("a rejected small tail chunk is still skipped under the #54 rule", async () => {
    // partial: true; partialReason names gpt-transcribe only and does not contain "whisper"
});
it("logs transcription_rejected with chunk context", async () => {
    // console.error spy: { event: "transcription_rejected", container, chunkIndex, totalChunks, uploadBytes, plannedSeconds,
    //   startByte, endByte (or sample range for MP4), firstBytesHex (32 bytes), vbrHeaderDropped, openAiError (full body), audioHost }
    // whole-file variant: wholeFile: true instead of chunk fields
});
it("result.model is always gpt-transcribe", async () => {});
```
Delete the whisper-1 fallback tests (`should fall back to whisper-1…`, the mixed-model `"whisper-1+gpt-transcribe"` test) and rewrite the tail-skip tests' mocks so the rejected chunk gets one 400, not a 400 then a whisper 400.

Run: `npm test -- test/transcription.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `callWhisperApi` delete the fallback branch entirely (`attemptWhisper1`, `whisper_fallback_*`, `isPrimaryTranscribeModel`). Keep the substring checks (`"corrupted or unsupported"`, `"input_too_large"`, `"too large for this model"`) on HTTP 400 and throw `AppError(AUDIO_REJECTED, "gpt-transcribe rejected the audio")`, attaching the raw OpenAI body as `cause` (an `Error` whose message is the body). In `transcribePlan`'s catch: for `AUDIO_REJECTED`, log `transcription_rejected` (fields above; `firstBytesHex` from the upload buffer, so keep a reference to it), run the existing tail-skip check, and if it doesn't skip, throw `AppError(AUDIO_REJECTED, "gpt-transcribe rejected chunk {n}/{total} of the audio", cause)`. Keep `AUDIO_UNSUPPORTED` rethrown before tail-skip, as today. Whole-file path: catch, log with `wholeFile: true`, rethrow. Replace `modelsUsed` with `provider.model`; the `partialReason` becomes `Final chunk {n}/{total} was rejected by {provider.model} ({error}). The transcript is missing the last {pct}% of the audio.` Add `AUDIO_REJECTED` to `ERROR_CODES`, `ERROR_MESSAGES` ("The transcription model rejected this episode's audio.") and `ERROR_HTTP_STATUS` (422). In `isTransientError`, return `false` first for `AppError` with `AUDIO_REJECTED` or `AUDIO_UNSUPPORTED`. Update header and doc comments in `transcription.ts`, and the `model` example in `src/types/index.ts`, to stop naming whisper-1.

- [ ] **Step 3: Run tests**

Run: `npm test && npm run typecheck && grep -rn "whisper-1" src test`
Expected: tests PASS; grep prints nothing.

- [ ] **Step 4: Commit**

```bash
git add -A src test
git commit -m "Remove the whisper-1 fallback; a model rejection is AUDIO_REJECTED and fails fast (#48)"
```

### Task 5: Consumer handling for AUDIO_REJECTED

**Files:**
- Modify: `src/queue/consumer.ts`
- Test: `test/consumer.test.ts`

**Interfaces:**
- Consumes: `ERROR_CODES.AUDIO_REJECTED` and its message format from Task 4.

- [ ] **Step 1: Write failing tests** (mirror `fails unsupported audio on the first attempt without retrying`)

```ts
it("fails rejected audio on the first attempt with a copy-paste debug command", async () => {
    // transcribeAudio rejects with AppError(AUDIO_REJECTED, "gpt-transcribe rejected chunk 3/7 of the audio")
    // metadata audioUrl "https://example.com/audio.mp3"
    // expect retry not called, ack called, job failed, and job.error ===
    //   "gpt-transcribe rejected chunk 3/7 of the audio. Debug with: npm run check:chunks -- https://example.com/audio.mp3 --transcribe"
    // activity log has episode_failed with the same details
});
```

Run: `npm test -- test/consumer.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

Around the `transcribeAudio` call in `processEpisode`, catch `AppError` with `AUDIO_REJECTED` and rethrow a new `AppError(AUDIO_REJECTED, "{message}. Debug with: npm run check:chunks -- {audioUrl} --transcribe", original)`, where `audioUrl` is the URL `processEpisode` passed to `transcribeAudio`. In the queue handler, set `maxAttempts` to 1 for `AUDIO_REJECTED` as for `AUDIO_UNSUPPORTED`. Update the file-header and step comments that say "Transcribe via OpenAI Whisper".

- [ ] **Step 3: Run tests, then commit**

Run: `npm test && npm run typecheck`
Expected: PASS.
```bash
git add src/queue/consumer.ts test/consumer.test.ts
git commit -m "Fail rejected audio on the first attempt and put the check command in the alert (#48)"
```

### Task 6: Per-chunk transcript cache

**Files:**
- Modify: `src/types/index.ts`, `src/lib/kv.ts`, `src/services/transcription.ts`, `src/queue/consumer.ts`
- Test: `test/transcription.test.ts`, `test/kv.test.ts`, `test/consumer.test.ts`

**Interfaces:**
- Consumes: `transcribePlan`, `CHUNK_PLAN_VERSION`, `PlannedChunk.cacheId`, `ChunkPlan.fileSize`.
- Produces:
  ```ts
  // src/types/index.ts
  export interface ChunkTranscriptCache {
      get(chunkKey: string): Promise<{ text: string } | null>;
      put(chunkKey: string, value: { text: string }): Promise<void>;
  }
  // src/services/transcription.ts
  export function chunkCacheKey(plan: ChunkPlan, chunk: PlannedChunk): string;
  //   `${CHUNK_PLAN_VERSION}:${plan.container}:${plan.fileSize}:${chunk.index}:${chunk.cacheId}`
  // TranscribeOptions gains: chunkCache?: ChunkTranscriptCache
  // src/lib/kv.ts
  KV_KEYS.chunkCache(episodeId: string, chunkKey: string): string   // `chunkcache:${episodeId}:${chunkKey}`
  export function makeChunkTranscriptCache(kv: KVNamespace, episodeId: string): ChunkTranscriptCache; // TTL.JOB on put
  ```

- [ ] **Step 1: Write failing tests** (Map-backed fake cache)

```ts
it("writes each successful chunk to the cache", async () => {});
it("resumes: cached chunks 1–2 skip their range fetch and OpenAI call; chunk 3 runs; text stitched in order", async () => {
    // fetchSpy call counts prove chunks 1–2 were neither fetched nor sent; no inter-chunk sleep before a cached chunk
});
it("a cache entry from a different file size, plan version or range is a miss", async () => {
    // seed under chunkCacheKey with fileSize + 1, and with CHUNK_PLAN_VERSION - 1 → full transcription
});
it("cache get/put errors are logged and ignored", async () => {
    // get and put throw → result identical to uncached; chunk_cache_read_failed / chunk_cache_write_failed logged
});
it("logs chunk_cache_hit", async () => {});
it("a rejected chunk is not cached", async () => {});
// kv.test.ts
it("makeChunkTranscriptCache round-trips under chunkcache:{episodeId}:{key} with TTL.JOB", async () => {});
// consumer.test.ts
it("passes a chunk cache bound to the episode to transcribeAudio", async () => {
    // vi.mocked(transcribeAudio).mock.calls[0][1].chunkCache is defined
});
```

Run: `npm test -- test/transcription.test.ts test/kv.test.ts test/consumer.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

Thread `opts.chunkCache` into `transcribePlan`'s `ctx` on both the remote and the small-file multi-chunk paths. In the loop, check the cache before the inter-chunk sleep and `chunk.load()`; on a hit push the cached text with the chunk's `isFirst`/`isLast`/`overlapBytes` and continue. Write after a successful chunk, the trimmed text the loop pushes. The consumer passes `chunkCache: makeChunkTranscriptCache(kv, episodeId)`. The rescue script stays uncached.

- [ ] **Step 3: Run tests, then commit**

Run: `npm test && npm run typecheck`
Expected: PASS.
```bash
git add -A src test
git commit -m "Cache chunk transcripts in KV so a retry resumes instead of restarting (#48)"
```

### Task 7: Stale-job sweep threshold

**Files:**
- Modify: `src/lib/constants.ts`, `src/queue/consumer.ts` (retry comment)
- Test: `test/job-timeout.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
it("does not fail a 25-minute-old job and fails a 36-minute-old one", async () => {
    // createJob in env.TLDL_DATA with createdAt now−25 min and now−36 min, status "transcribing";
    // await listActiveJobsWithDO(env, env.TLDL_DATA); getJob → first still "transcribing", second "failed"
});
```

Run: `npm test -- test/job-timeout.test.ts`
Expected: FAIL (the 25-minute job is failed at 20 min).

- [ ] **Step 2: Implement**

`JOB_MS: 35 * 60 * 1000`, comment: one killed 15-minute attempt, a resumed attempt and the summary fit inside 35 minutes. Fix the consumer comment that claims bumping `updatedAt` holds off a "119-min stale-job sweep": the sweep in `src/lib/job-status-do.ts` measures from `createdAt` and runs at `JOB_MS`. Rename the `WHISPER_API_MS` comment to "OpenAI transcription call (per chunk)" (the constant's rename is Task 9).

- [ ] **Step 3: Run tests, then commit**

Run: `npm test && npm run typecheck`
Expected: PASS.
```bash
git add src/lib/constants.ts src/queue/consumer.ts test/job-timeout.test.ts
git commit -m "Raise the stale-job sweep to 35 minutes so a resumed job isn't marked failed (#48)"
```

### Task 8: Chunk check script covers every container

**Files:**
- Modify: `scripts/check-mp4-chunks.ts` → rename to `scripts/check-chunks.ts`; `package.json` (`check:chunks` points at the new path)

**Interfaces:**
- Consumes: `planChunks`, `ChunkPlan.audio`, `PlannedChunk.plannedSeconds`, Task 1's `parseMp3FrameHeader` / `readVbrHeader`.

- [ ] **Step 1: Rebuild the script on `planChunks`**

Keep `parseArgs`, `readApiKey`, `openSource`, `ffmpegDecodeErrors` and `transcribe`. Replace the MP4-specific planning with `planChunks({ probe, fileSize, contentType: "", limits, fetchRange })` for any container. For each chunk write `chunk-NN.{mp3|m4a|bin}`, then check: ffmpeg decodes with no errors; `ffprobe` format duration ≤ `maxSeconds + 5`; for MP4, the existing packet-count check; for MP3, the first frame parses and carries no VBR header. Print the plan's `audio` summary first. `--transcribe` sends each chunk with its real MIME type (`audio/mpeg` for MP3, `audio/mp4` for M4A) and the production model, no fallback. Exit non-zero on any failed check or non-200. Update the header comment and the CLAUDE.md "Helpful Commands" entry.

- [ ] **Step 2: Verify on the spike file, offline**

Run: `npm run check:chunks -- /private/tmp/claude-501/-Users-rian-git-product-ai/27809db9-16d8-428c-929b-b21ebb15085c/scratchpad/supra/ep.mp3`
Expected: container `mp3`, `vbrHeader info`, 7 chunks, every chunk passes, exit 0. (If the scratch file is gone, use the Supra URL from the spec.)

- [ ] **Step 3: Commit**

```bash
git add scripts/check-chunks.ts scripts/check-mp4-chunks.ts package.json CLAUDE.md
git commit -m "Extend the chunk check script to MP3 and every container (#48)"
```

### Task 9: Docs, runbook, and the names-only rename

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/audio-format-debugging.md`, `scripts/rescue-transcript.ts` (comments), `src/services/transcription.ts`, `src/lib/constants.ts`, `src/lib/audio.ts` (comments), tests that reference renamed identifiers

- [ ] **Step 1: Docs commit**

- `CLAUDE.md`: request-flow step 2 and the project-structure entry name gpt-transcribe only; the chunking notes describe the MP3 frame path, the 15-minute cap on every container except `other`, and small files chunked by duration; replace the whisper-lane troubleshooting entries (the `+15:00` wall-clock entry, the rescue runbook's "mostly whisper-1 fallback" note, the "every chunk falls back to whisper-1" phrasing) with a `transcription_rejected` entry: what it means, the telemetry query (`event` = `transcription_rejected`, ≤6-hour windows), and "reproduce with `npm run check:chunks -- <url> --transcribe` before changing code"; add `chunkcache:{episodeId}:{chunkKey}` (TTL 1 day) to the KV schema; note the WAV/OGG limitation.
- `README.md`: tech table and structure comment.
- `docs/audio-format-debugging.md`: a "Resolved 2026-11-12" section at the top: the Info-frame cause, the real 45–70 minute limit, a link to the spec.
- `scripts/rescue-transcript.ts`: header comment no longer cites whisper-1.

Run: `grep -rn -i "whisper" CLAUDE.md README.md scripts src test | grep -v -i "whisper_api\|WhisperApi\|WHISPER_API"`
Expected: nothing (only identifiers Step 2 renames remain).
```bash
git add CLAUDE.md README.md docs/audio-format-debugging.md scripts/rescue-transcript.ts src/lib/audio.ts
git commit -m "Document transcription without whisper-1 and the rejection runbook (#48)"
```

- [ ] **Step 2: Names-only commit**

Rename `callWhisperApi` → `callTranscriptionApi`, `TIMEOUTS.WHISPER_API_MS` → `TIMEOUTS.TRANSCRIPTION_API_MS`, log events `whisper_api_call_start|complete|error|timeout|network_error` → `transcription_api_*`, and every reference in `src`, `test`, `scripts` and `CLAUDE.md`. No behaviour change.

Run: `npm test && npm run typecheck && grep -rn -i "whisper" src test scripts CLAUDE.md README.md`
Expected: PASS; grep prints nothing.
```bash
git add -A src test scripts CLAUDE.md
git commit -m "Rename whisper-named identifiers and log events to transcription_* (names only)"
```

### Task 10: Pre-flight against real episodes (controller, not a subagent)

Spends roughly $3 of OpenAI credit; run by the controller on the laptop.

- [ ] **Step 1: Run the check script with `--transcribe` on each file**

1. Supra Insider #135: `https://api.substack.com/feed/podcast/223758658/08f8c4a23d698de4c35722d94cc695f3.mp3`
2. An August Lenny's episode that fell back (from `https://api.substack.com/feed/podcast/10845.rss`: "This CPO regrets that product management exists" or the Jen Abel episode)
3. Lenny's 2026-11-08: `https://pscrb.fm/rss/p/api.substack.com/feed/podcast/219474705/120c52772b1e5a4f640d8a9add8ed0ea.mp3`
4. A Megaphone episode: `https://www.podtrac.com/pts/redirect.mp3/pdst.fm/e/pscrb.fm/rss/p/mgln.ai/e/257/traffic.megaphone.fm/VMP8681259132.mp3`
5. Deprecated Human (MP4, #53): the "Moral Math" enclosure from `https://anchor.fm/s/111fa6e48/podcast/rss`

Expected: every chunk passes every check and returns 200; each file's last chunk ends on a sign-off.

- [ ] **Step 2: Final whole-branch review, then hand off**

Final review on GPT-6.1 Sol at `xhigh`. Then `superpowers:finishing-a-development-branch`. Deploy (`npm run deploy`) only with Rian's go-ahead; afterwards, check Workers Logs per the spec's Verification step 3, close #48, and comment on #52.
