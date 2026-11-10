# Container-aware audio chunking (MP4 and ADTS)

Issue: [#53](https://github.com/rianvdm/tldl/issues/53)

## Why

Every MP4-container episode (`.m4a`, `audio/mp4`) over 25 MB fails transcription, every time. `transcribeWithChunking()` splits the file by raw byte range and prepends the first 512 bytes of the file to chunks 2+. That works for MP3, whose frames resynchronise on their own. It can't work for MP4: the audio bytes in `mdat` are only decodable with the sample table in `moov`, and 512 bytes is a sliver of a `moov` that can run to hundreds of KB. Chunk 1 decodes (when `moov` is at the front); chunk 2 onwards decodes to zero samples, both models reject it, and queue retries repeat the same failure.

Seen on `1895659651_1000800811355` (Deprecated Human, 66 MB, 68 min, Anchor CDN, layout `ftyp 28 B | moov 704 KB | mdat 65 MB`).

A probe on 2026-11-09 also showed OpenAI rejects raw ADTS AAC under every name and model. `detectAudioFormat()` labels ADTS streams `m4a`, so ADTS episodes of any size are probably failing too.

The goal, in Rian's words: this should always work.

## Goals

1. Any MP4/M4A episode whose audio track is AAC transcribes, at any size the pipeline already accepts (up to `MAX_TOTAL_SIZE_BYTES`, 300 MB), whether `moov` sits before or after `mdat`.
2. Any raw ADTS AAC episode transcribes, at any size.
3. Each chunk sent to OpenAI is a self-contained, valid MP4 holding a contiguous run of whole AAC frames.
4. Formats we can't handle fail on the first attempt with a message that names the reason (fragmented MP4, non-AAC codec, no audio track), rather than three identical retries ending in "corrupted or unsupported".
5. MP3 behaviour is unchanged.

## Non-goals

- Transcoding. No ffmpeg, WASM decoders, Containers, or external services. Everything is box parsing and byte copying in the Worker.
- Video enclosures. `validateAudioUrl()` rejects `video/*` content types today; that stays.
- Fragmented MP4 (`moof`/`mvex`). Podcast hosts serve progressive files; a fragmented file fails loudly (goal 4). Revisit if one ever turns up.
- Non-AAC codecs inside MP4 (ALAC, Opus, AC-3). Fail loudly.
- Changing how OGG, WAV, FLAC or WebM files over 25 MB are chunked. They keep today's byte-range path.
- The admin audio-URL override path (`skipValidation`). It downloads the whole file before discovering it needs chunking (`size_mismatch_chunking`), so a very large override file is held in memory. That's true for MP3 today too. The new chunker still runs on that path and fixes MP4 correctness there; the memory issue stays as it is.
- The per-chunk transcript cache (#48) and the rate-limit work (#52).

## Anti-goals

- A regression for MP3, which is nearly every episode. The MP3 path must not change behaviour, and the existing MP3 tests must pass unmodified.
- Holding a whole file in memory. A 300 MB file has to stay within the Worker's 128 MB, so we keep today's one-chunk-at-a-time pattern.
- Silent partial transcripts. The #54 tail-skip rule (drop a failed final chunk only if it holds ≤10% of the audio) still applies, measured on audio bytes, not file bytes.

## Constraints

- Cloudflare Workers runtime: 128 MB memory, 15-minute queue-consumer wall clock, no filesystem.
- OpenAI accepts `m4a`/`mp4`; per-file limit 25 MB. Chunks keep today's ~15 MB target (`TARGET_CHUNK_SIZE_BYTES`).
- Tests run in `@cloudflare/vitest-pool-workers`, which has no filesystem access, so binary fixtures must be importable modules.
- Audio CDNs rate-limit. The new path must not add more than a handful of extra range requests per episode, and every audio fetch goes through the existing `fetchAudioChunk()` retry wrapper.

## Design

### 1. Sniff the container once, up front

When chunking is needed, `transcribeWithChunking()` currently fetches the first 512 bytes. Replace that with a probe of the first 64 KB and classify the container:

- **MP3** (ID3 and/or MPEG Layer III sync): existing byte-range path, unchanged. It keeps prepending a 512-byte header taken from the probe.
- **MP4** (`ftyp` at offset 4): MP4 path (section 2).
- **ADTS** (optional ID3, then a 0xFFF sync with layer bits `00`, confirmed by a second valid ADTS header at `frame_length` bytes on): ADTS path (section 3).
- **Anything else**: existing byte-range path, unchanged.

Classification sits next to `detectAudioFormat()` and shares its ID3-skipping logic, so the two can't drift apart. Log a `container_detected` event with the result.

### 2. MP4 path

**Find `moov`.** Walk top-level boxes from offset 0, handling 32-bit sizes, `size == 1` (64-bit largesize) and `size == 0` (box runs to EOF). Box headers that lie past the probe are read with small range fetches. Most files put `moov` first, in which case the walk ends inside the probe; a file with `moov` after `mdat` takes one 16-byte header read plus one `moov` read. Once located, `moov` is range-fetched in full if it isn't already inside the probe. Cap `moov` at 32 MB (an hour of AAC has a table of a few hundred KB) and fail loudly above that. Seeing a `moof` box, or an `mvex` box inside `moov`, means a fragmented file: fail loudly.

**Parse the audio track.** Pick the first `trak` whose `hdlr` handler type is `soun`; ignore the others (chapter text tracks are common in podcast M4As, and their samples are interleaved with the audio in `mdat`). From that track, read:

- `mdhd` timescale and language
- `stsd` (kept as raw bytes and copied verbatim into every output chunk; its `mp4a` entry carries the `esds` with the AudioSpecificConfig). If the sample entry isn't `mp4a`, fail loudly naming the four-character code.
- `stts` (sample durations), `stsz` (sample sizes, including the uniform `sample_size` form), `stsc` plus `stco` or `co64` (chunk offsets). Expand these into a per-sample table of `{fileOffset, size, duration}`.

No `soun` track means fail loudly.

**Plan output chunks on sample boundaries.** Walk the sample table and cut a new chunk once the running payload reaches `TARGET_CHUNK_SIZE_BYTES` **or** the running duration reaches 15 minutes, whichever comes first. The duration cap matters because bytes were never the model's real limit: the chunk size went from 20 MB to 15 MB in `4eac6ac` because `gpt-transcribe`'s audio token budget (`input_too_large`) scales with duration. 15 MB of 128 kbps audio is ~16 minutes, which is known to work; 15 MB of 64 kbps AAC, a common podcast bitrate, is ~33 minutes, which would push every chunk onto the slow whisper-1 fallback. Overlap moves from bytes to time: each chunk after the first starts about 2 seconds (computed from `stts`) before the previous chunk ended, so `stitchTranscripts()` keeps working as it does now. At 128 kbps this gives the same ~15 MB chunks as today, cut cleanly between AAC frames.

**Fetch a chunk's samples.** A chunk's samples are mostly contiguous, broken only by interleaved samples from other tracks. Coalesce the chunk's samples into byte runs, merging runs separated by gaps under 1 MB, then range-fetch each run through `fetchAudioChunk()`. For an audio-only file that is one request per chunk, the same as today. Copy the sample bytes in order into one payload buffer.

**Write a self-contained MP4 per chunk.** Box layout:

```
ftyp  major 'M4A ', compatible 'M4A ', 'mp42', 'isom'
moov
  mvhd   timescale = mdhd timescale, duration = sum of chunk sample durations
  trak
    tkhd   enabled, track_ID 1, duration
    mdia
      mdhd   source timescale and language, chunk duration
      hdlr   'soun'
      minf
        smhd
        dinf > dref > 'url ' (self-contained flag)
        stbl
          stsd   copied verbatim from the source
          stts   run-length encoded from this chunk's durations
          stsc   one entry: first_chunk 1, all samples, description 1
          stsz   this chunk's sample sizes
          stco   one offset: start of mdat payload
mdat  the payload
```

`moov` goes before `mdat`, so the `stco` offset is known once `moov` is sized. Use 32-bit sizes and `stco`; a chunk is ~15 MB, well clear of the 4 GB limit. Drop edit lists: the AAC priming delay at the start of the file only shifts timing by ~20 ms. Send the result as `audio.m4a` with MIME `audio/mp4`. That's what `detectAudioFormat()` already produces for an `ftyp` buffer, so `callWhisperApi()` stays as it is.

The writer is a pure function of `(stsd bytes, timescale, language, samples, payload)` so the ADTS path can reuse it.

### 3. ADTS path

ADTS frames resynchronise on their own, like MP3. So:

- **Chunked (over 25 MB):** plan byte ranges with the existing `calculateChunkRanges()`, shrunk if needed so a chunk holds at most 15 minutes (estimate bytes-per-second from the bitrate implied by the first frames' `frame_length` and sample rate), then within each fetched range, skip to the first valid ADTS header (sync plus a second header confirmed at `frame_length`), parse frames up to the last complete one, strip the 7- or 9-byte headers, and wrap the raw frames in the section 2 writer. The overlap between chunks is in bytes, as for MP3.
- **Small files (under 25 MB):** wrap the whole stream the same way before sending, because raw ADTS is rejected at any size. Do this in one place, a `prepareForUpload(buffer, contentType)` step called by both `transcribeAudio()`'s small-file branch and the chunked path, so the two can't diverge.

MP4 files under 25 MB keep going to OpenAI untouched, as today: they already work, and running them through the new checks could turn an ALAC or fragmented file OpenAI currently accepts into an `AUDIO_UNSUPPORTED` failure. `prepareForUpload()` only rewrites ADTS. Goal 4 therefore applies to files that need chunking.

The writer needs an `stsd` built from the first frame's header: an `mp4a` sample entry with an `esds` whose DecoderSpecificInfo is the 2-byte AudioSpecificConfig (object type = ADTS profile + 1, sampling-frequency index, channel configuration). Timescale = sample rate; every frame lasts 1024 samples. If a later frame's profile, rate or channel config differs from the first, fail loudly.

### 4. Failure handling

Add an `AUDIO_UNSUPPORTED` error code. Thrown for fragmented MP4, non-AAC MP4, no audio track, an oversized `moov`, a malformed box tree, or ADTS parameters that change mid-stream. The message names the specific reason, for example `Unsupported MP4: audio codec 'alac' (only AAC is supported)`. It reaches the Discord alert and the activity log through `AppError.userMessage`.

The consumer treats `AUDIO_UNSUPPORTED` as final: ack on the first attempt, mark the job failed, and notify, without the three retries. The file won't change between attempts.

The #54 tail-skip check keeps its meaning: the share of audio lost is computed from the chunk's payload bytes over the track's total payload bytes (MP4) or the file size (ADTS and MP3, as now).

### 5. Observability

New structured events, following the repo's `console.log(JSON.stringify({event, ...}))` convention:

- `container_detected`: `{container, contentType, id3Bytes}`
- `mp4_layout`: top-level boxes as `[{type, offset, size}]`, `moovAtEnd`, track count, chosen track's codec, timescale, sample count, duration in seconds
- `mp4_chunk_plan` / `adts_chunk_plan`: chunk count, per-chunk sample count, payload bytes, start/end seconds, and the number of range requests per chunk

`chunk_processing` keeps firing per chunk so existing log queries still work.

### 6. Tests

- **Fixtures.** A committed script (`scripts/make-audio-fixtures.sh` or similar) uses local ffmpeg to generate small, few-second AAC files and writes them as base64 TypeScript modules under `test/fixtures/`, since the Workers test pool can't read files. Cases: `moov` first (`-movflags +faststart`), `moov` last (the ffmpeg default), M4A with a chapter text track, a 64-bit `co64` table if ffmpeg can be made to emit one (otherwise a synthetic unit test), fragmented MP4, ALAC-in-MP4, ADTS, and ADTS with an ID3 prefix.
- **Unit tests** for the box walker, sample-table expansion (including the uniform-size `stsz` and multi-entry `stsc`), the chunk planner (sample boundaries, time overlap, chunk sizes), the writer (round-trip: parse our own output and get the same samples back), ADTS parsing and AudioSpecificConfig construction, and each fail-loudly case.
- **Integration test** through `transcribeAudio()` with `fetch` mocked to serve a fixture with real Range semantics, forced into the chunked path by a small chunk size: assert every upload is a well-formed MP4 and the stitched text comes back.
- **Decode check outside the Worker.** A dev script runs the real chunker locally over a URL or file, writes each chunk to disk, and confirms with `ffprobe` that each one decodes to the expected duration. Run it against the Deprecated Human file and one `moov`-at-end file.
- **If OpenAI rejects our MP4s in the spike**, try one round of cheap variations (keep the source `edts`/`udta`, change `ftyp` brands, match ffmpeg's box order), then stop and report back before building anything else.
- **Live acceptance.** `npm run rescue -- 1895659651_1000800811355 --dry-run` produces a complete transcript that ends on the episode's sign-off, with every chunk accepted by `gpt-transcribe` (no whisper-1 fallbacks). This is the test that matters. Run a cheap version first, with one or two chunks of the real file, before building out the rest, since the riskiest assumption is that OpenAI accepts our hand-written `moov`.

### 7. Docs

Update the tldl `CLAUDE.md`: the audio-chunking bullet, the "Large audio files" common issue, and the project-structure entry, which should say the chunker is container-aware (MP3 by frame, MP4 by sample table, ADTS by frame) and name the new module(s).

## Done means

1. Merged to `main` with all tests passing and the live acceptance run above clean.
2. Rian deploys (`npm run deploy`; tldl does not auto-deploy on merge).
3. `1895659651_1000800811355` is re-run through the real queue and completes, which is what proves the 128 MB memory and 15-minute wall-clock limits hold.

Hunting through past failures for other MP4 or ADTS episodes to resubmit is a separate follow-up, not part of this work.

## Left to the builder

- Module layout. A reasonable split is `src/lib/mp4.ts` (box reader, sample table, writer), `src/lib/adts.ts`, with the routing staying in `transcription.ts`, but follow whatever reads cleanest.
- Exact names, log field names beyond those listed, and how the planner's types relate to the existing `AudioChunk`.
- The precise probe size (64 KB is a starting point) and the gap threshold for coalescing runs.
- Whether ADTS chunk boundaries reuse `calculateChunkRanges()` directly or get a thin wrapper.

## Calls made without Rian

- Pure TypeScript remux in the Worker, rather than transcoding elsewhere.
- Fragmented MP4 and non-AAC codecs fail loudly rather than being supported.
- ADTS support is in scope, including small files, because the probe showed it's broken at every size and the writer is shared.
- `AUDIO_UNSUPPORTED` skips queue retries.
- Overlap for MP4 chunks becomes ~2 seconds of audio instead of 32 KB.
- Edit lists are dropped from output chunks.
- Chunks are capped at 15 minutes as well as 15 MB.
- Small MP4s are sent untouched; only ADTS is rewritten below 25 MB.
- The URL-override memory issue stays out of scope.
- If the spike fails: one round of variations, then stop and report.
