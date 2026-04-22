CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    confirmed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS subscriptions (
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    podcast_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (subscriber_id, podcast_id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_podcast ON subscriptions(podcast_id);

CREATE TABLE IF NOT EXISTS pending_confirmations (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    podcast_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_email ON pending_confirmations(email);
