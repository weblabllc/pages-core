# Changelog

## 0.6.0 — 2026-09-24

Pages get a stable id, and every rule moves into services that write inside a transaction.

**Breaking**

- `StoredPage.id` (UUIDv7) is required. Tables are keyed by `(tenant, id)` with a unique `(tenant, slug)`. `ensureSchema` upgrades 0.5 tables in place (see README, "Upgrading from 0.5"). Stop 0.5 writers during the upgrade.
- Store port:
  - `getPage` becomes `getPageById` / `getPageBySlug`;
  - `updatePage`, `deletePage` and `setRole` take an id;
  - `renamePage`, `listPagesInFolders` and `listApprovedRatings` are gone;
  - `resolveFormerSlug` returns a page id;
  - `transaction(fn)` is required;
  - `listPages` requires `order`, `page` and `pageSize`, and `search` is an object;
  - `updatePage` never writes `type`, `role`, `createdBy` or `id`.
- `PageAddressing`, `PageRoles` and `PageComments` work by page id. `resolve` redirects only to published pages. `prepareNew` and `place` are replaced by `PageService`.
- `validatePortablePage` returns content fields only.
- `BLOG_KIND` and `ARTICLE_KIND` require a category.
- `applyPublish` / `applyUnpublish` take a publish policy.
- MySQL 8.0.16+ is required.

**New**

- `PageService`: create, update, move, publish, unpublish, delete, export, import. Each write runs in one transaction and returns `{ page, changes }` for cache revalidation.
- `PageQueries`:
  - public lists (cards with author and rating) and admin lists from raw query params;
  - `publishedPage` with breadcrumbs, author and rating;
  - `publishedIndex` for sitemaps;
  - `localizedView`.
- `PageTaxonomy`: categories and authors, with deletion refused while pages use them.
- `ContentModel` settings:
  - languages and a primary language;
  - length limits;
  - `publishedAt: 'first' | 'latest'`;
  - `slugHistory` without folders;
  - `maxPageSize`;
  - `defaultAuthor`.
- Kind settings: data codecs (`PUCK_DATA`, `localizedBlocksData()`), `categoryRequired`, `reservedSlugs`, per-kind `listing`, `comments`.
- Page input rules in one place (`validatePageInput`). List parameters parsed in one place (`parseListParams`, `parseCommentListParams`).
- Stores:
  - `transaction` with `clientMode: 'pool' | 'bound'`;
  - `StoreConflictError`;
  - `card` and `index` projections;
  - filters by several types, category presence, folder sets and ids;
  - multi-language search that matches `%` and `_` literally;
  - a stable order with an id tiebreaker.
- Comments are keyed by page id, with database checks on rating and status, database-side rating totals, and queue search and sort.
- Folder siblings are unique in the database.
- MySQL identity columns use `utf8mb4_bin`.
- `tablePrefix` is limited to 20 characters.
- Sitemap `sections` option.

## 0.5.0 — 2026-09-24

- SEO: every page has `seoTitle` and `seoDescription` (multi-language). `ensureSchema` adds the columns to existing tables; export and import carry them and validate their translations.
- Page roles: the rule "a role belongs to one page, assigning it elsewhere releases the old holder" lives only in `PageRoles.assign`. **Breaking for custom stores:** `PageStore.assignRole` is replaced by the plain `findPageByRole(role)` and `setRole(slug, role)`.

## 0.4.0 — 2026-09-23

- Page roles: `ContentModel({ roles })`, `DEFAULT_PAGE_ROLES` (`offer`, `privacy`, `returns`), `PageRoles.assign()` moves a role to its new page, `PageRoles.links()` and `roleLinks()` build links for published holders.
- Stores: `ensureSchema({ roles: true })` adds a `role` column with a unique `(tenant, role)` index (partial in Postgres and MongoDB); `assignRole()` and `listPagesWithRole()` on all three adapters, covered by the contract suite.
- `ContentError` gains the `invalid_role` code (400).

## 0.3.0 — 2026-09-23

- Content blocks: `image` and `document` carry a `url` (a relative `/assets/...` path or an `http(s)` URL; anything else, including protocol-relative `//host`, becomes an empty string), `contact-form` and `manuscript-form` mark where a page renders its forms.
- `blocksToPlainText` skips blocks with empty text, so form blocks do not add blank paragraphs.

## 0.2.1 — 2026-09-22

- README badges: npm version, CI status, license.
- Published from GitHub Actions via npm trusted publishing with provenance.

## 0.2.0 — 2026-09-22

- Package renamed to `@weblabllc/pages-core`.
- Folders: `PageAddressing` service with a folder tree, computed slugs (`[category/] + folder path + segment`) for nested kinds, flat addressing for the blog, sibling/cycle/depth guards and `ContentError` codes mapped to HTTP statuses.
- Slug history: renaming a folder or moving a page keeps the old address as a redirect; chains collapse to the current slug and a new page may claim a former slug.
- Portable export/import: `exportPortablePage` and `validatePortablePage` (block ids, zones, translation objects, immutable slug and type).
- Sitemaps: `contentSitemapEntries` and `renderSitemapXml`.
- Stores: `ensureSchema({ folders: true })` adds `folder_id`/`segment` columns to an existing pages table and creates the folder and slug history tables; all adapters are covered by one contract suite running against real Postgres, MySQL and MongoDB.


## 0.1.0 — 2026-09-01

Initial release, extracted and hardened from production projects.
