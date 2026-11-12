package io.legado.data.db

import io.legado.data.Database
import java.sql.Connection

/**
 * 建表 SQL：从 `Database.kt.initialize()` 拆出。
 *
 * 职责：只负责首次启动时的建表与索引/触发器创建，不负责旧库迁移。
 * 迁移见 `Migration.kt`。
 */
object Schema {

    /** 执行所有建表语句。必须在写事务内调用，且此时只有写连接（无其他读连接）。 */
    fun createTables(db: Connection) {
        db.createStatement().use { statement ->
            statement.execute("pragma journal_mode = wal")
            statement.executeUpdate("""
                create table if not exists source (
                  id text primary key, name text not null, source_url text not null,
                  source_group text, enabled integer not null, is_js integer not null,
                  payload text not null, version integer not null, updated_at integer not null,
                  has_login integer not null default 0, sort_order integer,
                  has_rules integer not null default 1
                );
                create index if not exists source_name_idx on source(name);
                create index if not exists idx_source_name_nocase on source(name collate nocase);

                create table if not exists app_meta (
                  key text primary key, value text not null
                );
                insert or ignore into app_meta(key, value) values ('source_revision', '0');

                create trigger if not exists source_revision_insert after insert on source begin
                  update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision';
                end;
                create trigger if not exists source_revision_update after update on source begin
                  update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision';
                end;
                create trigger if not exists source_revision_delete after delete on source begin
                  update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision';
                end;

                create table if not exists reading_progress (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  chapter_index integer not null, updated_at integer not null,
                  primary key (source_id, book_url)
                );

                create table if not exists cover_cache (
                  cache_key text primary key, content_type text not null
                );

                create table if not exists book_shelf (
                  source_id text not null, book_url text not null, name text not null,
                  author text, toc_url text not null, cover_url text, cover_key text,
                  last_read_at integer not null, completed integer not null default 0,
                  alternate_sources text, group_id integer not null default 0,
                  primary key (source_id, book_url)
                );
                create index if not exists book_shelf_last_read_idx on book_shelf(last_read_at desc);

                -- 用户主动删书的墓碑：备份导入是"合并"，合并不能盖掉"我已经删了它"这个决定。
                -- 记 (source_id, book_url) + 时间；重新手动加回同一本书时由 saveBookshelf/switchBookshelf 清掉。
                create table if not exists book_shelf_tombstone (
                  source_id text not null, book_url text not null, deleted_at integer not null,
                  primary key (source_id, book_url)
                );

                create table if not exists book_group (
                  group_id integer primary key, name text not null, sort_order integer not null default 0, created_at integer not null
                );

                create table if not exists book_content_cache (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  chapter_index integer not null default 0,
                  title text, content text not null, cached_at integer not null,
                  primary key (source_id, book_url, chapter_url)
                );
                create index if not exists book_content_cache_book_idx on book_content_cache(source_id, book_url);

                create table if not exists book_content_process (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  kind text not null, original text not null, processed text not null, updated_at integer not null,
                  primary key (source_id, book_url, chapter_url, kind)
                );

                create table if not exists book_cache_status (
                  source_id text not null, book_url text not null, total_chapters integer not null default 0,
                  cached_chapters integer not null default 0, state text not null default 'idle',
                  last_error text, updated_at integer not null,
                  primary key (source_id, book_url)
                );

                create table if not exists source_subscription (
                  id integer primary key autoincrement, url text not null unique,
                  enabled integer not null, created_at integer not null, updated_at integer not null,
                  last_success_at integer, last_attempt_at integer, last_error text,
                  last_imported integer not null default 0, content_hash text
                );
                create index if not exists source_subscription_enabled_idx on source_subscription(enabled);

                create table if not exists rss_source (
                  source_url text primary key, name text not null, source_group text, source_icon text,
                  enabled integer not null, has_list_rule integer not null, payload text not null, updated_at integer not null
                );
                create index if not exists rss_source_group_idx on rss_source(source_group);

                create table if not exists book_toc_cache (
                  source_id text not null, toc_url text not null, chapters_json text not null, updated_at integer not null,
                  primary key (source_id, toc_url)
                );

                create table if not exists source_login_state (
                  source_id text primary key,
                  login_info text,
                  login_header text,
                  source_variable text,
                  source_kv text,
                  cookie_jar text,
                  updated_at integer not null
                );

                create table if not exists cookie (
                  url text primary key,
                  cookie text not null,
                  updated_at integer not null
                );

                create table if not exists replace_rule (
                  id text primary key,
                  name text not null,
                  group_name text,
                  pattern text not null,
                  replacement text not null default '',
                  is_regex integer not null default 1,
                  scope text,
                  exclude_scope text,
                  scope_title integer not null default 0,
                  scope_content integer not null default 1,
                  is_enabled integer not null default 1,
                  sort_order integer not null default 0,
                  timeout_ms integer not null default 3000,
                  created_at integer not null,
                  updated_at integer not null
                );
                create index if not exists idx_replace_rule_enabled on replace_rule(is_enabled, sort_order asc);
                create index if not exists idx_replace_rule_group on replace_rule(group_name);

                create table if not exists log_entry (
                  id integer primary key autoincrement, ts integer not null,
                  category text not null, level text not null, message text not null,
                  context text, stack_trace text
                );
                create index if not exists idx_log_entry_ts on log_entry(ts desc);
                create index if not exists idx_log_entry_category on log_entry(category);

                create table if not exists reading_log (
                  day text not null, source_id text not null, book_url text not null,
                  book_name text, chapter_index integer not null default 0,
                  seconds integer not null default 0, updated_at integer not null,
                  primary key (day, source_id, book_url)
                );
                create index if not exists idx_reading_log_day on reading_log(day desc);

                create table if not exists book_note (
                  id integer primary key autoincrement,
                  source_id text not null, book_url text not null, book_name text,
                  chapter_url text, chapter_index integer not null default 0,
                  start_offset integer not null, end_offset integer not null,
                  excerpt text not null, note text not null default '',
                  bookmark integer not null default 0,
                  created_at integer not null, updated_at integer not null
                );
                create index if not exists idx_book_note_book on book_note(source_id, book_url, chapter_index);

                create table if not exists source_health (
                  source_id text primary key,
                  name text not null default '',
                  ok integer not null default 0,
                  latency_ms integer not null default 0,
                  status_category text not null default '',
                  error text,
                  checked_at integer not null default 0
                );
                create index if not exists idx_source_health_rank on source_health(ok desc, latency_ms asc);

                create table if not exists script_cache (
                  source_id text not null, key text not null, value text not null,
                  deadline integer not null default 0, updated_at integer not null,
                  primary key (source_id, key)
                );
                create index if not exists idx_script_cache_deadline on script_cache(deadline);
            """.trimIndent())

            // 不再有账号与会话：这台服务不设身份（写操作只留 Guard.kt 的同源闸门）。
            // 老库里的这两张表是死重量，启动时收掉。
            statement.executeUpdate("drop table if exists app_user")
            statement.executeUpdate("drop table if exists session")
        }
    }
}
