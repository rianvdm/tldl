# Clear Failed Jobs from Recent Activity

**Issue:** [rianvdm/tldl#18](https://github.com/rianvdm/tldl/issues/18)
**Date:** 2026-03-31

## Summary

Add an inline clear button to failed job entries in the Recent Activity section on `/admin`. Clicking it deletes the underlying job (DO + KV) and removes the activity log entry.

## Changes

### 1. New KV helper: `removeActivityEvent`

In `src/lib/kv.ts`, add a function that reads the `activity:log` array, splices out the entry matching the given `episodeId`, and writes it back. Match on `event.type === "episode_failed" && event.episodeId === episodeId`.

### 2. New endpoint: `DELETE /admin/activity/:episodeId`

In `src/routes/admin.ts`, add a route that:
1. Looks up the job by episode ID (the existing job key is `job:{jobId}`, but jobs store `episodeId` — need to find the matching job)
2. Deletes the job via the existing DO + KV deletion logic (reuse from `DELETE /admin/jobs/:jobId`)
3. Calls `removeActivityEvent(kv, episodeId)` to clean the activity log
4. Returns `{ success: true }`

If no matching job is found, still remove the activity log entry (the job may have already expired via TTL).

### 3. UI: Clear button on failed activity items

In the activity log HTML builder (lines 263-286 of `admin.ts`), for events where `type === "episode_failed"`, add a small `✕` button after the timestamp. The button:
- Is styled compact (no background, just an icon) to fit inline
- Calls a JS handler that `fetch`es `DELETE /admin/activity/:episodeId`
- On success, removes the `.activity-item` element from the DOM (no page reload)
- On failure, shows a brief inline error

### 4. CSS

Add minimal styling for the clear button: muted color by default, red on hover, vertically centered in the activity row.

## Out of scope

- Retry functionality (separate feature)
- Clearing non-failed activity entries (completed, monitor checks)
- Bulk clear from Recent Activity (existing Admin Tools button handles this)
