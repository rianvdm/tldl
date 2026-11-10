# Container-Aware Audio Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MP4/M4A episodes over 25 MB and raw ADTS AAC episodes of any size transcribe reliably, by sending OpenAI self-contained MP4 chunks cut on AAC frame boundaries.

**Architecture:** Pure-TypeScript box parsing and remuxing, no transcoding. `src/lib/mp4.ts` reads `moov`, expands the audio track's sample table, plans chunks on sample boundaries, and writes a minimal M4A per chunk. `src/lib/adts.ts` parses ADTS frames and wraps them with the same writer. `src/services/audio-containers.ts` does the range fetching. `transcribeWithChunking()` sniffs the container once and runs every container through one shared chunk loop.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest with `@cloudflare/vitest-pool-workers` (no filesystem in tests), tsx for scripts, local ffmpeg/ffprobe for fixtures and decode checks.

**Spec:** `docs/superpowers/specs/2026-11-09-mp4-aware-chunking-design.md`. Read it before starting any task.

## Global Constraints

- No new runtime dependencies. No transcoding (ffmpeg, WASM, Containers) in the Worker.
- MP3 behaviour unchanged: existing tests in `test/transcription.test.ts` must pass **without edits**.
- Chunk limits: `TARGET_CHUNK_SIZE_BYTES` (15 MB) **and** `MAX_CHUNK_SECONDS = 15 * 60`, whichever comes first.
- MP4 overlap: `CHUNK_OVERLAP_SECONDS = 2`. MP3/ADTS/other overlap stays `CHUNK_OVERLAP_BYTES` (32 KB).
- `CONTAINER_PROBE_BYTES = 64 * 1024`, `MAX_MOOV_BYTES = 32 * 1024 * 1024`, `RUN_COALESCE_GAP_BYTES = 1024 * 1024`. All new constants live in `src/lib/audio.ts`.
- Never hold a whole large file in memory. One output chunk at a time.
- Every audio byte fetched goes through the existing `fetchAudioChunk()` retry wrapper (injected as `fetchRange`).
- New error code `AUDIO_UNSUPPORTED`; its messages name the specific reason, e.g. `Unsupported MP4: audio codec 'alac' (only AAC is supported)`.
- MP4 files under 25 MB are sent untouched. Only ADTS is rewritten below 25 MB.
- Logging: `console.log(JSON.stringify({ event, ... }))`. New events: `container_detected`, `mp4_layout`, `mp4_chunk_plan`, `adts_chunk_plan`. `chunk_processing` keeps firing per chunk.
- Big-endian everywhere in MP4. File offsets can exceed 2^32 (`co64`), so store offsets as `number` (in a `Float64Array`), never `Uint32`.

## Review Focus

1. **Extra top-level boxes before `moov`** (`free`, `wide`, `uuid`, `udta`). The walker must skip any box type, not just `ftyp`/`mdat`. Test in Task 3.
2. **A CDN that ignores `Range` and answers 200 with the whole file.** `fetchAudioChunkOnce()` accepts 200, so a run fetch would silently hand back the wrong bytes. `loadMp4Chunk()` must check the returned length equals the requested run length and throw `AUDIO_UNAVAILABLE` otherwise. Test in Task 3.
3. **`stsc` with several entries** (ffmpeg's last chunk usually holds fewer samples). Sample offsets must still come out right. Test in Task 1.
4. **ADTS frames with CRC** (`protection_absent = 0`, 9-byte header). Header stripping must use the right length. Test in Task 6.
5. **A box with `size == 0`** (runs to end of file) as the last top-level box, usually `mdat`. Test in Task 3.

---

### Task 1: Fixtures, error code, and the MP4 sample-table reader

**Files:**
- Create: `scripts/make-audio-fixtures.sh`, `test/fixtures/audio.ts` (generated), `src/lib/mp4.ts`, `test/mp4.test.ts`
- Modify: `src/lib/constants.ts` (`ERROR_CODES`), `src/lib/errors.ts` (`ERROR_MESSAGES`, `ERROR_HTTP_STATUS`)

**Interfaces:**
- Produces:
  - `ERROR_CODES.AUDIO_UNSUPPORTED = "AUDIO_UNSUPPORTED"`. Default message: `"This episode's audio format isn't supported."` HTTP status 422.
  - `test/fixtures/audio.ts` exports base64 strings `MOOV_FIRST_M4A`, `MOOV_LAST_M4A`, `CHAPTERS_M4A`, `FRAGMENTED_M4A`, `ALAC_M4A`, `ADTS_AAC`, `ADTS_AAC_ID3`, and `fixtureBytes(b64: string): Uint8Array`.
  - In `src/lib/mp4.ts`:
    - `interface BoxHeader { type: string; offset: number; size: number; headerSize: number }`. `offset` is absolute in the file; `size` is the full box size, with `size == 0` resolved to `fileSize - offset`.
    - `readBoxHeader(bytes: Uint8Array, at: number, fileSize: number, baseOffset?: number): BoxHeader | null`. Returns null if fewer than 8 bytes (16 for largesize) are available at `at`.
    - `findChild(container: Uint8Array, path: string[]): Uint8Array | null`. Walks nested boxes (`["trak","mdia","hdlr"]`) and returns the box including its header.
    - `interface Mp4AudioTrack { codec: string; timescale: number; language: number; stsd: Uint8Array; sampleCount: number; offsets: Float64Array; sizes: Uint32Array; durations: Uint32Array; totalPayloadBytes: number; durationSeconds: number }`
    - `parseAudioTrack(moov: Uint8Array): Mp4AudioTrack`. Throws `AppError(AUDIO_UNSUPPORTED, …)` for: `mvex` present (`"Unsupported MP4: fragmented file"`), no `soun` track (`"Unsupported MP4: no audio track"`), sample entry not `mp4a` (`"Unsupported MP4: audio codec '<fourcc>' (only AAC is supported)"`), or any structural inconsistency (`"Unsupported MP4: malformed <box>"`).
    - `box(type: string, ...parts: Uint8Array[]): Uint8Array` and `fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array`, exported for the writer and for tests.

- [ ] **Step 1: Write `scripts/make-audio-fixtures.sh`**

  Bash, `set -euo pipefail`, uses ffmpeg to generate 5-second, mono, 44.1 kHz test tones (`-f lavfi -i sine=frequency=440:duration=5`) into a temp dir, then writes `test/fixtures/audio.ts` with one base64 export per file plus `fixtureBytes()` (decode with `atob`). Files:
  - `MOOV_FIRST_M4A`: `-c:a aac -b:a 64k -movflags +faststart`
  - `MOOV_LAST_M4A`: `-c:a aac -b:a 64k` (ffmpeg default puts `moov` last)
  - `CHAPTERS_M4A`: as MOOV_FIRST plus an ffmetadata input with two chapters (0–2 s, 2–5 s), `-map_metadata 1 -map_chapters 1`. After generating, the script must assert with `ffprobe -show_streams` (or a box dump) that the file has a second, non-audio track; if ffmpeg doesn't produce one, fail loudly so the builder knows.
  - `FRAGMENTED_M4A`: `-movflags frag_keyframe+empty_moov`
  - `ALAC_M4A`: `-c:a alac`
  - `ADTS_AAC`: `-c:a aac -b:a 64k -f adts`
  - `ADTS_AAC_ID3`: as ADTS with `-write_id3v2 1 -metadata title=fixture`
  The header comment says how to regenerate. Run it and commit the output.

- [ ] **Step 2: Write failing tests in `test/mp4.test.ts`**

  ```ts
  it("reads a 32-bit, a largesize, and a size-0 box header", ...)
    // hand-built bytes: size 0x10 'free'; size 1 + 64-bit 0x18 'mdat'; size 0 'mdat' with fileSize 100 at offset 40 → size 60
  it("parses the AAC track from a moov-first fixture", () => {
    // locate moov by walking top-level boxes of MOOV_FIRST_M4A
    const t = parseAudioTrack(moov);
    expect(t.codec).toBe("mp4a");
    expect(t.timescale).toBe(44100);
    expect(t.durationSeconds).toBeCloseTo(5, 0);
    expect(t.sampleCount).toBe(t.sizes.length);
    // every sample's offset+size falls inside the fixture's mdat payload
    // sum(sizes) === t.totalPayloadBytes
  });
  it("picks the soun track and ignores the chapter track", ...)   // CHAPTERS_M4A: codec mp4a, sample offsets inside mdat
  it("expands multi-entry stsc correctly", ...)                   // synthetic trak via box()/fullBox(): stsc [(1,3,1),(3,1,1)], stco [100,200,300] → offsets [100,100+s0,100+s0+s1,200,200+s3,...] per sizes
  it("reads co64 chunk offsets above 2^32", ...)                  // synthetic trak with co64 [5_000_000_000] → offsets[0] === 5_000_000_000
  it("handles uniform stsz (sample_size != 0)", ...)              // synthetic: sample_size 371, count 4 → sizes all 371
  it("rejects a fragmented file with AUDIO_UNSUPPORTED", ...)     // FRAGMENTED_M4A; message contains "fragmented"
  it("rejects ALAC naming the codec", ...)                        // ALAC_M4A; message contains "'alac'"
  it("rejects a moov with no soun track", ...)                    // synthetic moov with a 'vide' hdlr only
  ```

- [ ] **Step 3: Run `npm test -- test/mp4.test.ts`.** Expected: FAIL (module not found).

- [ ] **Step 4: Add `AUDIO_UNSUPPORTED`** to `ERROR_CODES`, `ERROR_MESSAGES` and `ERROR_HTTP_STATUS`.

- [ ] **Step 5: Implement the reader in `src/lib/mp4.ts`** with the signatures above. Sample-table expansion: walk `stsc` runs across chunk indices 1..N from `stco`/`co64`. Within a chunk, offset = chunk offset + running sum of sizes. Durations come from expanding `stts` `(count, delta)` pairs. Validate that `stts` total count, `stsz` count and the `stsc` expansion all agree; if not, throw `malformed`.

- [ ] **Step 6: Run `npm test -- test/mp4.test.ts`.** Expected: PASS.

- [ ] **Step 7: Commit** `Add MP4 sample-table reader, audio fixtures and AUDIO_UNSUPPORTED (#53)`.

---

### Task 2: Chunk planner and M4A writer

**Files:**
- Modify: `src/lib/mp4.ts`, `src/lib/audio.ts` (new constants)
- Test: `test/mp4.test.ts`

**Interfaces:**
- Consumes: `Mp4AudioTrack`, `parseAudioTrack`, `box`, `fullBox` (Task 1).
- Produces:
  - In `src/lib/audio.ts`: `MAX_CHUNK_SECONDS`, `CHUNK_OVERLAP_SECONDS`, `CONTAINER_PROBE_BYTES`, `MAX_MOOV_BYTES`, `RUN_COALESCE_GAP_BYTES` (values in Global Constraints).
  - `interface SampleChunk { firstSample: number; endSample: number /* exclusive */; overlapSamples: number; payloadBytes: number; newPayloadBytes: number; startSeconds: number; endSeconds: number; isFirst: boolean; isLast: boolean }`
  - `planSampleChunks(track: Pick<Mp4AudioTrack,"sizes"|"durations"|"timescale">, limits: { maxBytes: number; maxSeconds: number; overlapSeconds: number }): SampleChunk[]`
  - `interface ByteRun { start: number; end: number /* inclusive */ }`
  - `coalesceRuns(offsets: ArrayLike<number>, sizes: ArrayLike<number>, first: number, end: number, maxGap: number): ByteRun[]`
  - `writeM4a(input: { stsd: Uint8Array; timescale: number; language: number; sizes: ArrayLike<number>; durations: ArrayLike<number>; payload: Uint8Array }): Uint8Array`. Box layout exactly as the spec's section 2 diagram.

- [ ] **Step 1: Write failing tests**

  ```ts
  it("cuts on the byte limit", ...)        // 100 samples × 1000 B × 1024 ticks @ 44100; maxBytes 25_000, maxSeconds 1e9, overlap 0 → chunks of 25 samples; last isLast
  it("cuts on the duration limit first when bitrate is low", ...) // same samples, maxBytes 1e9, maxSeconds 0.5 → each chunk ≤ 0.5 s and ≥ 0.5 s − one sample
  it("overlaps by ~overlapSeconds of samples", ...) // overlap 0.1 s → chunk[i+1].firstSample === chunk[i].endSample - overlapSamples, overlapSamples = ceil(0.1*44100/1024) = 5; newPayloadBytes = payloadBytes - overlap bytes
  it("covers every sample exactly once outside overlaps", ...) // union of [firstSample+overlapSamples, endSample) is [0, n)
  it("never produces an empty or overlap-only chunk at the tail", ...)
  it("coalesces contiguous samples into one run", ...)
  it("splits runs across a gap larger than maxGap and merges smaller gaps", ...) // offsets with a 10-byte gap (merged) and a 2 MB gap (split)
  it("writeM4a round-trips through parseAudioTrack", () => {
    // take samples 10..40 from MOOV_FIRST_M4A's track, copy their bytes into payload, write, then:
    // walk top-level boxes: ftyp, moov, mdat in that order
    // parseAudioTrack(moov) → same sizes, same durations, codec mp4a, stsd byte-identical to the source
    // offsets[k] point at the k-th sample inside the written mdat
  });
  ```

- [ ] **Step 2: Run `npm test -- test/mp4.test.ts`.** Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the constants, `planSampleChunks`, `coalesceRuns` and `writeM4a`. Writer details: `ftyp` major `M4A `, minor 0, compatible `M4A `, `mp42`, `isom`. `mvhd` v0, rate 1.0, volume 1.0, unity matrix, next_track_ID 2. `tkhd` v0, flags 0x7, track_ID 1, volume 1.0. `hdlr` handler `soun`, name `SoundHandler\0`. `dref` with one `url ` entry, flags 1. `stts` run-length encoded. `stsc` one entry `(1, sampleCount, 1)`. `stco` one entry = `ftyp.size + moov.size + 8`.

- [ ] **Step 4: Run `npm test -- test/mp4.test.ts`.** Expected: PASS.

- [ ] **Step 5: Commit** `Add sample-boundary chunk planner and M4A writer (#53)`.

---

### Task 3: Range-fetch glue for MP4

**Files:**
- Create: `src/services/audio-containers.ts`, `test/audio-containers.test.ts`

**Interfaces:**
- Consumes: Task 1–2 exports.
- Produces:
  - `type FetchRange = (start: number, end: number /* inclusive */) => Promise<ArrayBuffer>`
  - `locateMoov(probe: Uint8Array, fileSize: number, fetchRange: FetchRange): Promise<{ moov: Uint8Array; layout: BoxHeader[]; moovAtEnd: boolean }>`. Walks top-level boxes from 0. Reads headers beyond the probe with 16-byte `fetchRange` calls. Throws `AUDIO_UNSUPPORTED` on: `moof` seen before `moov` (`fragmented file`), moov larger than `MAX_MOOV_BYTES`, a box running past `fileSize`, or no `moov` found (`"Unsupported MP4: no moov box"`).
  - `loadMp4Chunk(track: Mp4AudioTrack, chunk: SampleChunk, fetchRange: FetchRange): Promise<Uint8Array>`. Coalesces runs, fetches each, checks every response length equals `end - start + 1` (else `AppError(AUDIO_UNAVAILABLE, "Range request returned N bytes, expected M")`), copies samples into the payload in sample order, and returns `writeM4a(...)`.

- [ ] **Step 1: Write failing tests** using an in-memory `fetchRange` over fixture bytes that records its calls:

  ```ts
  it("finds moov inside the probe with no extra fetches", ...)            // MOOV_FIRST_M4A, probe = whole fixture → 0 fetchRange calls, moovAtEnd false
  it("finds moov after mdat with one header read and one moov read", ...) // MOOV_LAST_M4A, probe = first 64 bytes → moovAtEnd true, fetchRange calls ≤ 3
  it("skips free/uuid boxes before moov", ...)                            // splice a 'free' (100 B) and a 'uuid' box after ftyp in MOOV_LAST_M4A (adjust nothing else: mdat-relative offsets shift, so compare parsed track via loadMp4Chunk output instead)
  it("treats size-0 mdat as running to EOF", ...)                         // MOOV_FIRST with mdat size patched to 0 → layout last box size === fileSize - offset
  it("rejects fragmented files", ...)                                     // FRAGMENTED_M4A → AUDIO_UNSUPPORTED
  it("rejects an oversized moov", ...)                                    // fake header claiming moov size MAX_MOOV_BYTES + 1
  it("loadMp4Chunk output decodes to the same samples", ...)              // round-trip via parseAudioTrack, payload bytes equal the source sample bytes
  it("loadMp4Chunk uses one range request for an audio-only chunk", ...)
  it("loadMp4Chunk throws AUDIO_UNAVAILABLE when a range comes back the wrong length", ...) // fetchRange returns the whole file
  ```

  For the "skips free/uuid" case, building a valid file is fiddly because `stco` offsets move. The simplest valid approach is to insert the extra boxes *after* `moov` in MOOV_FIRST (no offsets move) **and** before `moov` in MOOV_LAST (mdat comes first, so its offsets don't move either). Do both.

- [ ] **Step 2: Run `npm test -- test/audio-containers.test.ts`.** Expected: FAIL.

- [ ] **Step 3: Implement `locateMoov` and `loadMp4Chunk`.**

- [ ] **Step 4: Run `npm test -- test/audio-containers.test.ts`.** Expected: PASS.

- [ ] **Step 5: Commit** `Add range-fetch glue for MP4 chunks (#53)`.

---

### Task 4: Local chunk check and the OpenAI acceptance gate

This is the spec's riskiest assumption: does OpenAI accept our hand-written `moov`? Nothing past this task gets built until it passes.

**Files:**
- Create: `scripts/check-mp4-chunks.ts`
- Modify: `package.json` (add `"check:chunks": "tsx scripts/check-mp4-chunks.ts"`), `.gitignore` (add `scripts/chunk-check-results/`)

**Interfaces:**
- Consumes: `locateMoov`, `parseAudioTrack`, `planSampleChunks`, `loadMp4Chunk`, `getProviderConfig`.
- Produces: CLI `npm run check:chunks -- <url-or-path> [--max-mb 15] [--max-seconds 900] [--limit N] [--transcribe]`.

- [ ] **Step 1: Write the script.** `fetchRange` uses HTTP Range for URLs (with `AUDIO_USER_AGENT`) or reads `fs` slices for local paths. It prints the `mp4_layout` summary and the chunk plan, writes each chunk (up to `--limit`) to `scripts/chunk-check-results/<name>-NN.m4a`, and runs `ffprobe -v error -show_entries format=duration -of csv=p=0` on each. It prints the expected vs decoded duration per chunk and exits non-zero if any chunk differs by more than 0.5 s. With `--transcribe`, it POSTs each chunk to OpenAI with the production model from `getProviderConfig()`, filename `audio.m4a`, MIME `audio/mp4`, using `OPENAI_API_KEY` read from `.dev.vars` the way `scripts/rescue-transcript.ts` does. It prints status, the first 120 characters of text, and exits non-zero on any non-200. No whisper-1 fallback here: this tests the primary model.

- [ ] **Step 2: Get the Deprecated Human audio URL** (`1895659651_1000800811355`) from prod KV: `npx wrangler kv key get --namespace-id=ee123158d5d54359b4257f8a1b678adf "episode:1895659651_1000800811355" --remote`. If no episode record exists (it failed, so it may not), take the enclosure URL from the show's RSS feed via Podcast Index or Apple. The issue gives the layout: `ftyp 28 B | moov 704 KB | mdat 65 MB`.

- [ ] **Step 3: Decode check.** `npm run check:chunks -- <url>`. Expected: 5 chunks (≈ 68 min at ~128 kbps under 15 MB / 15 min), every chunk decodes within 0.5 s of plan, exit 0.

- [ ] **Step 4: moov-at-end decode check.** Download the file once, run `ffmpeg -i in.m4a -c copy scripts/chunk-check-results/moov-last.m4a` (no faststart, so `moov` ends up last), confirm with the script's layout output that `moovAtEnd` is true, then run `npm run check:chunks -- scripts/chunk-check-results/moov-last.m4a`. Expected: exit 0.

- [ ] **Step 5: OpenAI gate.** `npm run check:chunks -- <url> --limit 2 --transcribe`. Expected: both chunks return 200 with plausible English text. Chunk 2 is the one that fails today.

- [ ] **Step 6: If Step 5 fails:** try one round of variations (copy the source `edts`/`udta` into the output `trak`/`moov`; change `ftyp` major brand to `isom`; match the box order of `ffmpeg -c copy` output for the same samples). If none pass, **stop and report to Rian** with the error bodies. Do not continue to Task 5.

- [ ] **Step 7: Commit** `Add local MP4 chunk check script (#53)`.

---

### Task 5: Wire MP4 into `transcribeWithChunking()`

**Files:**
- Modify: `src/services/transcription.ts`
- Test: `test/transcription.test.ts` (add new `describe` blocks only; do not edit existing tests)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `type AudioContainer = "mp3" | "mp4" | "adts" | "other"`
  - `export function detectContainer(probe: Uint8Array): AudioContainer`. Shares an extracted `id3Length(bytes: Uint8Array): number` helper with `detectAudioFormat()`. ADTS needs a second valid header at `frame_length`; if that can't be confirmed (probe too short, or a bad second header) the result is `"other"`, so MP3 is never misread as ADTS.
  - `TranscribeOptions.chunkLimits?: { maxBytes: number; maxSeconds: number }`, threaded through to `transcribeWithChunking`. Defaults are `TARGET_CHUNK_SIZE_BYTES` and `MAX_CHUNK_SECONDS`. Used by tests and the check script.
  - Internal: `interface PlannedChunk { index: number; isFirst: boolean; isLast: boolean; overlapBytes: number; newBytes: number; logFields: Record<string, unknown>; load(): Promise<ArrayBuffer> }` and `planChunks(...)` returning `{ container: AudioContainer; totalBytes: number; chunks: PlannedChunk[] }`.

- [ ] **Step 1: Write failing tests**

  ```ts
  describe("detectContainer", () => {
    it("mp4 for ftyp", ...); it("mp3 for ID3 + layer III", ...); it("adts for ADTS_AAC and ADTS_AAC_ID3", ...);
    it("other for zero-filled bytes", ...); it("other for a lone 0xFFF1 with no second header", ...);
  });
  describe("chunked MP4 transcription", () => {
    // fetch mock: HEAD → content-length 30MB, content-type audio/mp4;
    //   GET with Range → 206 with the matching slice of the fixture bytes (clamped to fixture length);
    //   POST to the OpenAI URL → records the uploaded Blob, returns {"text":"chunk N."}
    // transcribeAudio(url, { apiKey: "k", chunkLimits: { maxBytes: 1e9, maxSeconds: 2 } })
    it("uploads only self-contained M4A chunks", ...)   // MOOV_FIRST_M4A: 3 uploads (5 s / 2 s), each begins with ftyp, filename audio.m4a, parseAudioTrack(its moov) codec mp4a
    it("works when moov is at the end", ...)            // MOOV_LAST_M4A: same assertions
    it("stitches the chunk texts in order", ...)        // result.text contains "chunk 1", "chunk 2", "chunk 3" in order
    it("fails fast with AUDIO_UNSUPPORTED for a fragmented file and never calls OpenAI", ...)
    it("does not tail-skip an AUDIO_UNSUPPORTED error", ...) // make the parse fail; assert throws, not partial
    it("measures the #54 tail share on payload bytes", ...)  // final chunk rejected by both models: partial iff its newPayloadBytes / totalPayloadBytes ≤ 0.1
  });
  ```

- [ ] **Step 2: Run `npm test -- test/transcription.test.ts`.** Expected: the new tests FAIL and the existing tests PASS.

- [ ] **Step 3: Implement.** Replace the 512-byte header fetch with one `CONTAINER_PROBE_BYTES` probe. Log `container_detected`, then route:
  - `mp3`/`other`: today's byte ranges via `calculateChunkRanges()`, with the 512-byte header sliced from the probe and prepended to non-first chunks. The fetch sequence is the same as today, so existing tests keep passing.
  - `mp4`: `locateMoov` → `parseAudioTrack` → `planSampleChunks` (with `overlapSeconds: CHUNK_OVERLAP_SECONDS`). Log `mp4_layout` and `mp4_chunk_plan`. Each `load()` calls `loadMp4Chunk`, and `newBytes` is `newPayloadBytes`, so `totalBytes` is `track.totalPayloadBytes`.
  - `adts`: left for Task 6. Until then, route to the byte path.

  One loop then handles every container: sleep, `load()`, `callWhisperApi`, push, and the tail-skip rule using `newBytes / totalBytes`. Before the tail-skip check, rethrow any `AppError` with code `AUDIO_UNSUPPORTED`. `fetchRange` for the MP4 path is `(s, e) => fetchAudioChunk(audioUrl, s, e)`.

- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit** `Chunk MP4 audio on sample boundaries into self-contained M4As (#53)`.

---

### Task 6: ADTS support

**Files:**
- Create: `src/lib/adts.ts`, `test/adts.test.ts`
- Modify: `src/services/transcription.ts`
- Test: `test/transcription.test.ts` (new `describe` blocks only)

**Interfaces:**
- Consumes: `writeM4a`, `box`, `fullBox` (Task 1–2), `detectContainer`, `planChunks` (Task 5).
- Produces:
  - `interface AdtsConfig { objectType: number /* profile + 1 */; sampleRateIndex: number; sampleRate: number; channelConfig: number }`
  - `interface AdtsFrame { offset: number; headerSize: 7 | 9; length: number /* incl. header */ }`
  - `readAdtsHeader(bytes: Uint8Array, at: number): { config: AdtsConfig; headerSize: 7 | 9; length: number } | null`
  - `findAdtsSync(bytes: Uint8Array, from: number): number`. Returns the first offset at or after `from` where a header parses **and** a second header parses at `offset + length` (or `offset + length === bytes.length`). Returns -1 if there is none.
  - `parseAdtsFrames(bytes: Uint8Array): { config: AdtsConfig; frames: AdtsFrame[] }`. Starts at `findAdtsSync(bytes, id3Length(bytes))` and stops at the last complete frame. Throws `AUDIO_UNSUPPORTED` (`"Unsupported ADTS: stream parameters change mid-file"`) if any frame's config differs from the first.
  - `buildAacStsd(config: AdtsConfig): Uint8Array`. An `stsd` with one `mp4a` entry (channelcount from config, samplesize 16, samplerate `sampleRate << 16`) containing an `esds` (ES_Descriptor → DecoderConfigDescriptor objectTypeIndication 0x40, streamType 0x05 → DecoderSpecificInfo = 2-byte AudioSpecificConfig `(objectType << 11) | (sampleRateIndex << 7) | (channelConfig << 3)` → SLConfigDescriptor 0x02).
  - `adtsToM4a(bytes: Uint8Array): Uint8Array`. Timescale = sampleRate, every duration 1024, language `und`.
  - `export function prepareForUpload(buffer: ArrayBuffer): ArrayBuffer` in `transcription.ts`. ADTS → `adtsToM4a`; anything else is returned unchanged.

- [ ] **Step 1: Write failing tests in `test/adts.test.ts`**

  ```ts
  it("reads a 7-byte header from ADTS_AAC", ...)        // objectType 2 (AAC-LC), sampleRate 44100, channelConfig 1
  it("reads a 9-byte CRC header", ...)                  // synthetic: first frame of ADTS_AAC with protection_absent cleared and 2 CRC bytes inserted, frame_length + 2 → headerSize 9, payload identical
  it("skips ID3 and finds the first frame", ...)        // ADTS_AAC_ID3
  it("resyncs from a mid-frame offset", ...)            // findAdtsSync(bytes, 1000) lands on a real frame start
  it("drops a truncated final frame", ...)              // bytes sliced mid-frame → frames.length one fewer
  it("rejects a config change mid-stream", ...)         // patch frame 3's sampling index
  it("builds the AudioSpecificConfig 0x12 0x08 for AAC-LC 44.1 kHz mono", ...)
  it("adtsToM4a round-trips through parseAudioTrack", ...) // codec mp4a, sampleCount === frames.length, sizes === frame payload lengths
  ```

  And in `test/transcription.test.ts`:

  ```ts
  it("wraps a small ADTS file before upload", ...)       // HEAD 40KB audio/aac; upload begins with ftyp, filename audio.m4a
  it("leaves a small MP4 untouched", ...)                // MOOV_LAST_M4A under 25MB: uploaded bytes === fixture bytes
  it("chunks a large ADTS file into M4A chunks", ...)    // HEAD claims 30MB; chunkLimits { maxBytes: 16_000, maxSeconds: 900 }; each upload begins with ftyp and parses
  it("shrinks ADTS byte chunks to the duration cap", ...) // chunkLimits { maxBytes: 1e9, maxSeconds: 2 } on the 5 s fixture → ≥ 3 uploads
  ```

- [ ] **Step 2: Run `npm test -- test/adts.test.ts test/transcription.test.ts`.** Expected: new tests FAIL.

- [ ] **Step 3: Implement `src/lib/adts.ts`**, then in `transcription.ts`:
  - Small-file branch: `callWhisperApi(prepareForUpload(audioBuffer), …)`.
  - `adts` route in `planChunks`: estimate bytes/second from the probe's frames (`sum(length) / (frames × 1024 / sampleRate)`), set `maxChunkBytes = min(limits.maxBytes, floor(bytesPerSecond × limits.maxSeconds))`, plan with `calculateChunkRanges(contentLength, maxChunkBytes, CHUNK_OVERLAP_BYTES)`, and have each `load()` fetch the range and return `adtsToM4a` of it (`parseAdtsFrames` resyncs at the start and drops a partial tail). Log `adts_chunk_plan`. No 512-byte header prepend on this route.

- [ ] **Step 4: Run `npm test && npm run typecheck`.** Expected: PASS.

- [ ] **Step 5: Commit** `Wrap ADTS AAC in M4A for upload, at any size (#53)`.

---

### Task 7: Don't retry unsupported audio

**Files:**
- Modify: `src/queue/consumer.ts:222-224`
- Test: `test/consumer.test.ts`

**Interfaces:**
- Consumes: `ERROR_CODES.AUDIO_UNSUPPORTED`.

- [ ] **Step 1: Write the failing test:** with `transcribeAudio` throwing `new AppError(ERROR_CODES.AUDIO_UNSUPPORTED, "Unsupported MP4: audio codec 'alac' (only AAC is supported)")` on a message with `attempts: 1`, the job is marked `failed` with that exact message, `message.ack` is called, `message.retry` is not called, and an `episode_failed` activity entry is written. Follow the helper pattern at `test/consumer.test.ts:141-155`.

- [ ] **Step 2: Run `npm test -- test/consumer.test.ts`.** Expected: FAIL (retry is called).

- [ ] **Step 3: Implement.** `const isUnsupported = error instanceof AppError && error.code === ERROR_CODES.AUDIO_UNSUPPORTED;` and `const maxAttempts = isUnsupported ? 1 : isRateLimited ? 5 : 3;`.

- [ ] **Step 4: Run `npm test`.** Expected: PASS.

- [ ] **Step 5: Commit** `Fail unsupported audio formats on the first attempt (#53)`.

---

### Task 8: Docs and live acceptance

**Files:**
- Modify: `CLAUDE.md` (the audio-chunking bullet under Key Components, "Large audio files" under Common Issues, the `audio.ts` line in Project Structure, and new `mp4.ts`/`adts.ts`/`audio-containers.ts` lines; add the `check:chunks` command under Helpful Commands)

- [ ] **Step 1: Update `CLAUDE.md`.** Say the chunker is container-aware: MP3 by frame, MP4 by sample table (chunks rebuilt as self-contained M4As, `moov` at either end, chapter tracks ignored), ADTS wrapped in M4A at any size. Mention both limits (15 MB and 15 min, and why the duration cap exists). Say that fragmented MP4 and non-AAC codecs fail on the first attempt with `AUDIO_UNSUPPORTED`. Point to `npm run check:chunks` for debugging a format failure.

- [ ] **Step 2: Full suite.** Run `npm test && npm run typecheck`. Expected: all PASS. Report the test count.

- [ ] **Step 3: Live acceptance.** Run `npm run rescue -- 1895659651_1000800811355 --dry-run`. Expected:
  - the result is not `partial`
  - `model` is `gpt-transcribe` alone (no `+whisper-1`)
  - the logs show `container_detected` `mp4` and 5 chunks
  - the printed last 90 characters read as a sign-off, not mid-sentence

  If the episode has aged out of the feed, pass `--audio-url <url from Task 4>`.

- [ ] **Step 4: Commit** `Document container-aware chunking (#53)`.

After this, hand off to `superpowers:finishing-a-development-branch`. Per the spec's "Done means", Rian deploys and then re-runs the episode through the real queue.
