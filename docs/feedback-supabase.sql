-- legadoQ 匿名建议中转：在 Supabase SQL Editor 执行一次。
-- 不采集 ip / user_agent / device_id / email；contact 由用户自愿填写。

create table public.feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  app_id text not null check (app_id ~ '^[a-zA-Z0-9_-]{1,32}$'),
  category text not null default 'general'
    check (category in ('bug','feature','general','question')),
  content text not null check (char_length(content) between 1 and 2000),
  contact text check (char_length(contact) <= 200),
  app_version text check (char_length(app_version) <= 32),
  user_token_hash text not null check (char_length(user_token_hash) = 64),
  metadata jsonb not null default '{}'::jsonb
    check (pg_column_size(metadata) <= 2048)
);

create index idx_feedback_app_id on public.feedback (app_id);
create index idx_feedback_token on public.feedback (user_token_hash);

alter table public.feedback enable row level security;

-- 零注册：任何人都能插入，表约束负责字段与长度校验。
create policy "anon insert"
on public.feedback for insert to anon with check (true);

-- 查询只放行 token 哈希匹配的行；不带 header 或哈希错误时返回空数组。
create policy "select own only"
on public.feedback for select to anon
using (
  user_token_hash = current_setting('request.headers', true)::json->>'x-feedback-token'
);

-- RLS 控制哪些行可见，表级权限控制允许哪些操作；匿名角色只保留插入与查询。
revoke all on table public.feedback from anon;
grant insert, select on table public.feedback to anon;
