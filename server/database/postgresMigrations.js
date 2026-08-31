import { query, withTransaction, markPostgresInitialized } from './postgres.js';
import { env } from '../config/drive.js';

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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
    UPDATE users SET password_changed_at = COALESCE(password_changed_at, created_at);
    CREATE TABLE IF NOT EXISTS user_password_history (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_password_history_user ON user_password_history(user_id, created_at DESC);
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
      storage_provider TEXT, storage_key TEXT, provider_file_id TEXT, mime_type TEXT, etag TEXT, checksum TEXT,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cover_source TEXT, cover_width INTEGER, cover_height INTEGER, cover_aspect_ratio REAL,
      cover_pipeline_version INTEGER NOT NULL DEFAULT 1, cover_quality_status TEXT NOT NULL DEFAULT 'unknown'
    );
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS storage_provider TEXT;
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS storage_key TEXT;
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS provider_file_id TEXT;
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS mime_type TEXT;
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS etag TEXT;
    ALTER TABLE library_files ADD COLUMN IF NOT EXISTS checksum TEXT;
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
      state_version INTEGER NOT NULL DEFAULT 0,
      client_updated_at BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE reading_state ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, dedupe_key TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3, timeout_ms INTEGER NOT NULL DEFAULT 120000,
      error TEXT, worker_id TEXT, lease_until TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS worker_id TEXT;
    ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
    ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_background_jobs_queue ON background_jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_lease ON background_jobs(status, lease_until);
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
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';
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
    CREATE TABLE IF NOT EXISTS libraries (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      location TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_libraries_provider ON libraries(provider, enabled);
    CREATE TABLE IF NOT EXISTS storage_provider_settings (
      provider TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT INTO schema_migrations (version, name, checksum) VALUES (4, 'libraries-and-provider-settings', 'araru-libraries-v4')
      ON CONFLICT (version) DO NOTHING;
  `);
  await withTransaction(async (client) => {
    await client.query(`
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS content_hash TEXT;
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS hash_algorithm TEXT NOT NULL DEFAULT 'sha256';
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS pipeline_status TEXT NOT NULL DEFAULT 'discovered';
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS pipeline_stage TEXT NOT NULL DEFAULT 'discovery';
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS pipeline_error_code TEXT;
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS pipeline_error TEXT;
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS manifest JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS manifest_version INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS idx_library_files_content_hash ON library_files(content_hash) WHERE content_hash IS NOT NULL AND content_hash <> '';
      CREATE INDEX IF NOT EXISTS idx_library_files_pipeline ON library_files(pipeline_status, pipeline_stage);

      ALTER TABLE works ADD COLUMN IF NOT EXISTS original_title TEXT;
      ALTER TABLE works ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE works ADD COLUMN IF NOT EXISTS volume_number REAL;
      ALTER TABLE works ADD COLUMN IF NOT EXISTS chapter_count INTEGER;
      ALTER TABLE works ADD COLUMN IF NOT EXISTS search_vector tsvector;
      CREATE INDEX IF NOT EXISTS idx_works_search_vector ON works USING GIN(search_vector);
      CREATE OR REPLACE FUNCTION araru_works_search_vector() RETURNS trigger AS $function$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.canonical_title, ''))), 'A') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.original_title, ''))), 'A') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.authors::text, ''))), 'B') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.publisher, ''))), 'B') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.series_name, ''))), 'B') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.description, ''))), 'C') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.tags::text, ''))), 'C') ||
          setweight(to_tsvector('simple', unaccent(coalesce(NEW.isbn10, '') || ' ' || coalesce(NEW.isbn13, ''))), 'A');
        RETURN NEW;
      END;
      $function$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_works_search_vector ON works;
      CREATE TRIGGER trg_works_search_vector BEFORE INSERT OR UPDATE OF canonical_title,original_title,authors,publisher,series_name,description,tags,isbn10,isbn13 ON works FOR EACH ROW EXECUTE FUNCTION araru_works_search_vector();
      UPDATE works SET search_vector =
        setweight(to_tsvector('simple', unaccent(coalesce(canonical_title, ''))), 'A') ||
        setweight(to_tsvector('simple', unaccent(coalesce(original_title, ''))), 'A') ||
        setweight(to_tsvector('simple', unaccent(coalesce(authors::text, ''))), 'B') ||
        setweight(to_tsvector('simple', unaccent(coalesce(publisher, ''))), 'B') ||
        setweight(to_tsvector('simple', unaccent(coalesce(series_name, ''))), 'B') ||
        setweight(to_tsvector('simple', unaccent(coalesce(description, ''))), 'C') ||
        setweight(to_tsvector('simple', unaccent(coalesce(tags::text, ''))), 'C') ||
        setweight(to_tsvector('simple', unaccent(coalesce(isbn10, '') || ' ' || coalesce(isbn13, ''))), 'A');

      CREATE TABLE IF NOT EXISTS creators (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'author', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(normalized_name, kind)
      );
      CREATE TABLE IF NOT EXISTS work_creators (
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'author', position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(work_id, creator_id, role)
      );
      CREATE INDEX IF NOT EXISTS idx_work_creators_creator ON work_creators(creator_id, role);

      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '', cover_work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS collection_works (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        position REAL NOT NULL DEFAULT 0, PRIMARY KEY(collection_id, work_id)
      );
      CREATE INDEX IF NOT EXISTS idx_collection_works_position ON collection_works(collection_id, position, work_id);

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        file_id TEXT REFERENCES library_files(id) ON DELETE SET NULL,
        number REAL, title TEXT NOT NULL DEFAULT '', sort_order REAL NOT NULL DEFAULT 0,
        resource_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(work_id, file_id, number, title)
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_work_order ON chapters(work_id, sort_order, id);

      CREATE TABLE IF NOT EXISTS cover_variants (
        file_id TEXT NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
        variant TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
        size BIGINT NOT NULL DEFAULT 0, fingerprint TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1, etag TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(file_id, variant)
      );
      CREATE INDEX IF NOT EXISTS idx_cover_variants_version ON cover_variants(file_id, version);

      INSERT INTO schema_migrations (version, name, checksum)
      VALUES (5, 'catalog-content-pipeline-model', 'araru-catalog-pipeline-v5')
      ON CONFLICT (version) DO NOTHING;
    `);
  });
  await withTransaction(async (client) => {
    await client.query("ALTER TABLE profiles ALTER COLUMN language SET DEFAULT 'en'; UPDATE profiles SET language='en' WHERE id='default' AND NOT EXISTS (SELECT 1 FROM users);");
    await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (6, 'english-default-language', 'araru-language-default-en-v6') ON CONFLICT (version) DO NOTHING");
  });
  await withTransaction(async (client) => {
    await client.query("ALTER TABLE profiles ALTER COLUMN theme SET DEFAULT 'dark'; UPDATE profiles SET theme='dark' WHERE id='default' AND NOT EXISTS (SELECT 1 FROM users);");
    await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (7, 'dark-default-theme', 'araru-theme-default-dark-v7') ON CONFLICT (version) DO NOTHING");
  });
  const localLibraryMigration = await query("SELECT 1 FROM schema_migrations WHERE version=8");
  if (!localLibraryMigration.rowCount) {
    await withTransaction(async (client) => {
      const localLibrary = await client.query("SELECT 1 FROM libraries WHERE provider='local' LIMIT 1");
      if (!localLibrary.rowCount) {
        await client.query('INSERT INTO libraries(id,name,provider,location,enabled,settings) VALUES($1,$2,$3,$4,TRUE,\'{}\'::jsonb)', ['library-local', 'Local library', 'local', env.localLibraryDir]);
      }
      await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (8, 'default-local-library', 'araru-local-library-v8')");
    });
  }
  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id BIGSERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        value_type TEXT NOT NULL,
        category TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        default_value JSONB,
        is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
        is_runtime BOOLEAN NOT NULL DEFAULT FALSE,
        restart_required BOOLEAN NOT NULL DEFAULT FALSE,
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT app_settings_scope_check CHECK (scope IN ('global', 'user', 'profile'))
      );
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_key_scope ON app_settings(key, scope, scope_id);
      CREATE INDEX IF NOT EXISTS idx_app_settings_category_scope ON app_settings(category, scope, scope_id);
      INSERT INTO schema_migrations (version, name, checksum)
      VALUES (9, 'typed-app-settings', 'araru-app-settings-v9')
      ON CONFLICT (version) DO NOTHING;
    `);
  });
  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_definitions (
        type TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE, default_priority INTEGER NOT NULL DEFAULT 2,
        default_timeout_ms INTEGER NOT NULL DEFAULT 120000, supports_pause BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS job_schedules (
        id TEXT PRIMARY KEY, job_type TEXT NOT NULL REFERENCES job_definitions(type) ON DELETE CASCADE,
        name TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC',
        enabled BOOLEAN NOT NULL DEFAULT TRUE, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ, last_error TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_job_schedules_due ON job_schedules(enabled,next_run_at);
      CREATE TABLE IF NOT EXISTS job_logs (
        id BIGSERIAL PRIMARY KEY, job_id TEXT NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS pause_requested BOOLEAN NOT NULL DEFAULT FALSE;
      INSERT INTO schema_migrations (version,name,checksum) VALUES (10,'job-center','araru-job-center-v10') ON CONFLICT (version) DO NOTHING;
    `);
  });
  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_connections (id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT TRUE,config JSONB NOT NULL DEFAULT '{}'::jsonb,encrypted_credentials JSONB,encryption_version INTEGER,encryption_key_id TEXT,status TEXT NOT NULL DEFAULT 'unknown',last_tested_at TIMESTAMPTZ,last_error_code TEXT,last_error_message TEXT,created_by TEXT REFERENCES users(id) ON DELETE SET NULL,updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS library_sources (id TEXT PRIMARY KEY,library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,connection_id TEXT NOT NULL REFERENCES storage_connections(id) ON DELETE RESTRICT,name TEXT NOT NULL,path_or_prefix TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT TRUE,scan_mode TEXT NOT NULL DEFAULT 'incremental',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_library_sources_library ON library_sources(library_id,enabled);
      INSERT INTO schema_migrations(version,name,checksum) VALUES (11,'storage-connections','araru-storage-connections-v11') ON CONFLICT(version) DO NOTHING;
    `);
  });
  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',is_system BOOLEAN NOT NULL DEFAULT FALSE,enabled BOOLEAN NOT NULL DEFAULT TRUE,version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS role_permissions (role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,permission TEXT NOT NULL,PRIMARY KEY(role_id,permission));
      CREATE TABLE IF NOT EXISTS role_library_access (role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,access_level TEXT NOT NULL DEFAULT 'read',PRIMARY KEY(role_id,library_id),CHECK(access_level IN ('none','read','manage')));
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id TEXT REFERENCES roles(id) ON DELETE RESTRICT;
      INSERT INTO roles(id,name,description,is_system) VALUES ('role-administrator','Administrator','Full system access.',TRUE),('role-reader','Reader','No administrative access; library access is granted explicitly.',TRUE) ON CONFLICT(id) DO NOTHING;
      UPDATE users SET role_id=CASE WHEN role='admin' THEN 'role-administrator' ELSE 'role-reader' END WHERE role_id IS NULL;
      ALTER TABLE users ALTER COLUMN role_id SET NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);
      INSERT INTO schema_migrations(version,name,checksum) VALUES (12,'roles-and-rbac','araru-roles-rbac-v12') ON CONFLICT(version) DO NOTHING;
    `);
  });
  await withTransaction(async (client) => {
    await client.query(`
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL;
      ALTER TABLE library_files ADD COLUMN IF NOT EXISTS library_source_id TEXT REFERENCES library_sources(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_library_files_library_status ON library_files(library_id,status);
      CREATE INDEX IF NOT EXISTS idx_library_files_library_source ON library_files(library_source_id,status);
    `);

    const bindings = [
      { provider: 'local', libraryId: 'library-local', libraryName: 'Local library', libraryProvider: 'local', connectionId: 'connection-local', sourceId: 'source-local', sourceName: 'Local source', path: env.localLibraryDir, config: { path: env.localLibraryDir } },
      { provider: 'drive', libraryId: 'library-drive', libraryName: 'Google Drive library', libraryProvider: 'drive', connectionId: 'connection-drive', sourceId: 'source-drive', sourceName: 'Google Drive source', path: env.driveFolderId || '', config: {} },
      { provider: 'r2', libraryId: 'library-r2', libraryName: 'Cloudflare R2 library', libraryProvider: 'r2', connectionId: 'connection-r2', sourceId: 'source-r2', sourceName: 'Cloudflare R2 source', path: env.r2.prefix || '', config: {} }
    ];

    for (const binding of bindings) {
      await client.query('INSERT INTO libraries(id,name,provider,location,enabled,settings) VALUES($1,$2,$3,$4,TRUE,\'{}\'::jsonb) ON CONFLICT(id) DO NOTHING', [binding.libraryId, binding.libraryName, binding.libraryProvider, binding.path || null]);
      await client.query('INSERT INTO storage_connections(id,name,provider,enabled,config) VALUES($1,$2,$3,TRUE,$4::jsonb) ON CONFLICT(id) DO NOTHING', [binding.connectionId, binding.sourceName, binding.provider === 'drive' ? 'google_drive' : binding.provider === 'r2' ? 'cloudflare_r2' : 'local', JSON.stringify(binding.config)]);
      await client.query('INSERT INTO library_sources(id,library_id,connection_id,name,path_or_prefix,enabled,scan_mode) VALUES($1,$2,$3,$4,$5,TRUE,\'incremental\') ON CONFLICT(id) DO NOTHING', [binding.sourceId, binding.libraryId, binding.connectionId, binding.sourceName, binding.path]);
      await client.query(`UPDATE library_files
        SET library_id=$1::text,library_source_id=$2::text,
            payload=payload || jsonb_build_object('libraryId',$1::text,'librarySourceId',$2::text)
        WHERE library_id IS NULL AND (
          COALESCE(storage_provider,source)=$3::text
          OR ($3::text='drive' AND COALESCE(storage_provider,source)='google_drive')
          OR ($3::text='r2' AND COALESCE(storage_provider,source)='cloudflare_r2')
        )`, [binding.libraryId, binding.sourceId, binding.provider]);
    }

    await client.query("INSERT INTO schema_migrations(version,name,checksum) VALUES (13, 'explicit-library-source-links', 'araru-library-source-links-v13') ON CONFLICT(version) DO NOTHING");
  });
  markPostgresInitialized();
}
