export const protocolSchemaSql = `
CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('base', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  selector_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sqlite',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_protocols_enabled_priority
  ON protocols(enabled, priority DESC);
`;

