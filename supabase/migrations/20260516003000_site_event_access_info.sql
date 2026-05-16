alter table site_events add column if not exists client_ip text;
alter table site_events add column if not exists client_ip_hash text;
alter table site_events add column if not exists user_agent text;
alter table site_events add column if not exists accept_language text;
alter table site_events add column if not exists client_country text;
alter table site_events add column if not exists client_region text;
alter table site_events add column if not exists client_city text;
alter table site_events add column if not exists is_bot boolean not null default false;

create index if not exists site_events_client_ip_hash_idx on site_events (client_ip_hash);
create index if not exists site_events_is_bot_idx on site_events (is_bot);
create index if not exists site_events_client_country_idx on site_events (client_country);
