-- Optional Postgres checkpoint schema for payout holder snapshots.
-- The worker defaults to file checkpoints under MANIFEST_DIR/checkpoints/ when DATABASE_URL is unset.
-- Snapshots are round-scoped: balances are recomputed from Transfer logs between checkpoints.

CREATE TABLE IF NOT EXISTS token_checkpoints (
  token_address CHAR(42) PRIMARY KEY,
  snapshot_block BIGINT NOT NULL,
  last_log_index INTEGER,
  last_tx_hash CHAR(66),
  holder_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_checkpoint_balances (
  token_address CHAR(42) NOT NULL REFERENCES token_checkpoints(token_address) ON DELETE CASCADE,
  account CHAR(42) NOT NULL,
  balance NUMERIC(78, 0) NOT NULL CHECK (balance > 0),
  PRIMARY KEY (token_address, account)
);

CREATE INDEX IF NOT EXISTS token_checkpoint_balances_token_idx
  ON token_checkpoint_balances (token_address);

-- Round audit trail (optional): one row per published community manifest attempt.
CREATE TABLE IF NOT EXISTS snapshot_runs (
  id BIGSERIAL PRIMARY KEY,
  member_token CHAR(42) NOT NULL,
  snapshot_block BIGINT NOT NULL,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  holder_count INTEGER NOT NULL DEFAULT 0,
  manifest_hash CHAR(66),
  manifest_uri TEXT,
  merkle_root CHAR(66),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS snapshot_runs_token_block_idx
  ON snapshot_runs (member_token, snapshot_block DESC);
