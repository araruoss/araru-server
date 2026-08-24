import { query, markPostgresInitialized } from './postgres.js';

// Fundação idempotente do schema PostgreSQL para instalações novas.
export async function migratePostgres() {
  await query(`
    CREATE EXTENSION IF NOT EXISTS unaccent;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      profile_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#0891B2',
      is_default BOOLEAN NOT NULL DEFAULT FALSE, preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO profiles (id, name, color, is_default) VALUES ('default', 'Principal', '#0891B2', TRUE)
      ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS library_files (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, relative_path TEXT,
      filename TEXT NOT NULL, extension TEXT NOT NULL, format TEXT NOT NULL, size BIGINT NOT NULL DEFAULT 0,
      mtime TIMESTAMPTZ, fingerprint TEXT NOT NULL, category_path JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'active', payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cover_source TEXT, cover_width INTEGER, cover_height INTEGER, cover_aspect_ratio REAL,
      cover_pipeline_version INTEGER NOT NULL DEFAULT 1, cover_quality_status TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE IF NOT EXISTS livros (
      id TEXT PRIMARY KEY, drive_id TEXT UNIQUE, nome TEXT, categoria TEXT, subcategorias JSONB NOT NULL DEFAULT '[]'::jsonb,
      autor JSONB NOT NULL DEFAULT '[]'::jsonb, editora TEXT, ano INTEGER, isbn TEXT, isbn10 TEXT, isbn13 TEXT,
      descricao TEXT, capa_url TEXT, capa_cor TEXT, avaliacao REAL, numero_paginas INTEGER, idioma TEXT,
      link_drive TEXT, preview_url TEXT, fonte TEXT, file_path TEXT, data_adicao TIMESTAMPTZ,
      ultima_leitura TIMESTAMPTZ, favorito BOOLEAN NOT NULL DEFAULT FALSE, tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadados_completos JSONB NOT NULL DEFAULT '{}'::jsonb, normalized_title TEXT, normalized_author TEXT,
      metadata_status TEXT NOT NULL DEFAULT 'pending', metadata_confidence REAL NOT NULL DEFAULT 0, metadata_source TEXT,
      metadata_provenance JSONB NOT NULL DEFAULT '{}'::jsonb, metadata_last_checked TIMESTAMPTZ, cover_source TEXT,
      original_filename TEXT, manual_fields JSONB NOT NULL DEFAULT '[]'::jsonb, needs_review BOOLEAN NOT NULL DEFAULT FALSE,
      enrichment_attempts INTEGER NOT NULL DEFAULT 0, enrichment_error TEXT, candidate_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
      file_size BIGINT, file_mtime TEXT, file_fingerprint TEXT, cover_path TEXT, cover_generated_at TIMESTAMPTZ,
      cover_fingerprint TEXT, category_path JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_livros_categoria ON livros(categoria);
    CREATE INDEX IF NOT EXISTS idx_livros_isbn ON livros(isbn);
    CREATE INDEX IF NOT EXISTS idx_livros_review ON livros(needs_review, metadata_status);
    CREATE TABLE IF NOT EXISTS categorias (
      id BIGSERIAL PRIMARY KEY, nome TEXT NOT NULL UNIQUE, icone TEXT, cor TEXT
    );
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS search_vector tsvector;
    CREATE INDEX IF NOT EXISTS idx_library_files_search_vector ON library_files USING GIN(search_vector);
    CREATE OR REPLACE FUNCTION araru_library_files_search_vector() RETURNS trigger AS $function$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('simple', unaccent(coalesce(NEW.filename, ''))), 'A') ||
        setweight(to_tsvector('simple', unaccent(coalesce(NEW.relative_path, ''))), 'B') ||
        setweight(to_tsvector('simple', unaccent(coalesce(NEW.category_path::text, ''))), 'B');
      RETURN NEW;
    END;
    $function$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_library_files_search_vector ON library_files;
    CREATE TRIGGER trg_library_files_search_vector
      BEFORE INSERT OR UPDATE OF filename, relative_path, category_path ON library_files
      FOR EACH ROW EXECUTE FUNCTION araru_library_files_search_vector();
    UPDATE library_files SET search_vector =
      setweight(to_tsvector('simple', unaccent(coalesce(filename, ''))), 'A') ||
      setweight(to_tsvector('simple', unaccent(coalesce(relative_path, ''))), 'B') ||
      setweight(to_tsvector('simple', unaccent(coalesce(category_path::text, ''))), 'B');
    CREATE INDEX IF NOT EXISTS idx_library_files_source ON library_files (source, source_id);
    CREATE INDEX IF NOT EXISTS idx_library_files_status ON library_files (status, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_library_files_fingerprint ON library_files (fingerprint);
    CREATE TABLE IF NOT EXISTS reading_state (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      favorites JSONB NOT NULL DEFAULT '[]'::jsonb, history JSONB NOT NULL DEFAULT '[]'::jsonb,
      progress JSONB NOT NULL DEFAULT '{}'::jsonb, stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      client_updated_at BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, dedupe_key TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3, timeout_ms INTEGER NOT NULL DEFAULT 120000,
      error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_queue ON background_jobs(status, priority DESC, created_at ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_active_dedupe ON background_jobs(dedupe_key) WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS secure_credentials (
      provider TEXT PRIMARY KEY, encrypted_payload TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS source_sync_state (
      source TEXT PRIMARY KEY, cursor TEXT, mode TEXT NOT NULL DEFAULT 'full', last_sync_at TIMESTAMPTZ,
      last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY, canonical_title TEXT NOT NULL, authors JSONB NOT NULL DEFAULT '[]'::jsonb,
      isbn10 TEXT, isbn13 TEXT, publisher TEXT, description TEXT, cover_file_id TEXT,
      series_name TEXT, series_volume REAL, series_sequence REAL, series_confidence REAL, series_source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_isbn13 ON works(isbn13) WHERE isbn13 IS NOT NULL AND isbn13 <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_works_isbn10 ON works(isbn10) WHERE isbn10 IS NOT NULL AND isbn10 <> '';
    CREATE TABLE IF NOT EXISTS work_files (
      work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, file_id TEXT PRIMARY KEY,
      format TEXT, source TEXT, is_primary BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_work_files_work ON work_files(work_id, is_primary DESC);
    CREATE TABLE IF NOT EXISTS saved_views (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL, query_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS book_preferences (
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, work_id TEXT NOT NULL,
      preferences JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(profile_id, work_id)
    );
    CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
      cover_work_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS work_series (
      work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE, series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      volume REAL, sequence REAL, confidence REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE TABLE IF NOT EXISTS offline_items (
      file_id TEXT PRIMARY KEY, work_id TEXT, format TEXT, size BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'available', fingerprint TEXT, downloaded_at TIMESTAMPTZ,
      last_accessed_at TIMESTAMPTZ, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY, cache_type TEXT NOT NULL, path TEXT, size BIGINT NOT NULL DEFAULT 0,
      fingerprint TEXT, version INTEGER NOT NULL DEFAULT 1, last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS integrity_reports (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, dry_run BOOLEAN NOT NULL DEFAULT TRUE,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb, findings JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS reader_metrics (
      id BIGSERIAL PRIMARY KEY, profile_id TEXT, work_id TEXT, file_id TEXT,
      engine TEXT NOT NULL, event TEXT NOT NULL, duration_ms REAL, detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS feature_flags (
      name TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE, config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO feature_flags(name, enabled) VALUES
      ('adaptivePrefetch', TRUE), ('offlineDownload', TRUE), ('experimentalMobi', FALSE), ('newReaderAnimation', FALSE)
      ON CONFLICT (name) DO NOTHING;
    CREATE TABLE IF NOT EXISTS duplicate_decisions (
      id TEXT PRIMARY KEY, work_a_id TEXT NOT NULL, work_b_id TEXT NOT NULL, decision TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS backup_history (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, checksum TEXT NOT NULL, size BIGINT NOT NULL,
      schema_version INTEGER NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO schema_migrations (version, name, checksum) VALUES (1, 'postgres-foundation', 'araru-postgres-foundation-v1')
      ON CONFLICT (version) DO NOTHING;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email)) WHERE email IS NOT NULL;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'pt-BR';
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'system';
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, profile_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_profiles_profile ON user_profiles(profile_id);
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
    INSERT INTO user_profiles(user_id, profile_id, is_default)
      SELECT id, COALESCE(profile_id, 'default'), TRUE FROM users
      ON CONFLICT (user_id, profile_id) DO NOTHING;
    INSERT INTO system_settings(key, value)
      SELECT 'setup.completed', 'true'::jsonb WHERE EXISTS (SELECT 1 FROM users)
      ON CONFLICT (key) DO NOTHING;
    INSERT INTO schema_migrations (version, name, checksum) VALUES (2, 'setup-users-profiles-sessions', 'araru-identity-v2')
      ON CONFLICT (version) DO NOTHING;

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_user_id, created_at DESC);
    INSERT INTO schema_migrations (version, name, checksum) VALUES (3, 'admin-audit-log', 'araru-admin-audit-v3')
      ON CONFLICT (version) DO NOTHING;
  `);
  markPostgresInitialized();
}
