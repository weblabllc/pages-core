# Changelog

## 0.2.0 — 2026-09-22

- Package renamed to `@weblabllc/pages-core`.
- Folders: `PageAddressing` service with a folder tree, computed slugs (`[category/] + folder path + segment`) for nested kinds, flat addressing for the blog, sibling/cycle/depth guards and `ContentError` codes mapped to HTTP statuses.
- Slug history: renaming a folder or moving a page keeps the old address as a redirect; chains collapse to the current slug and a new page may claim a former slug.
- Portable export/import: `exportPortablePage` and `validatePortablePage` (block ids, zones, translation objects, immutable slug and type).
- Sitemaps: `contentSitemapEntries` and `renderSitemapXml`.
- Stores: `ensureSchema({ folders: true })` adds `folder_id`/`segment` columns to an existing pages table and creates the folder and slug history tables; all adapters are covered by one contract suite running against real Postgres, MySQL and MongoDB.


## 0.1.0 — 2026-09-01

Initial release, extracted and hardened from production projects.
