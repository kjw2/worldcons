alter table site_events
  drop constraint if exists site_events_event_type_check;

alter table site_events
  add constraint site_events_event_type_check check (
    event_type in (
      'page_view',
      'article_view',
      'search',
      'tag_click',
      'tag_view',
      'source_view',
      'article_click',
      'external_link_click',
      'security_event',
      'admin_action',
      'admin_review_action'
    )
  );
