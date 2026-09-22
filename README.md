# @weblabllc/pages-core

[![npm](https://img.shields.io/npm/v/@weblabllc/pages-core)](https://www.npmjs.com/package/@weblabllc/pages-core) [![ci](https://github.com/weblabllc/pages-core/actions/workflows/ci.yml/badge.svg)](https://github.com/weblabllc/pages-core/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@weblabllc/pages-core)](LICENSE)

Transport- and ORM-agnostic backend core for content edited with [Puck](https://puckeditor.com). It covers:

- publish lifecycle and immutable content kinds;
- multi-language text;
- reading time and pagination;
- authors and per-kind categories;
- folders with computed slugs and redirects;
- portable export/import;
- sitemaps;
- optional storage adapters for Postgres, MySQL and MongoDB.

It has no web framework or ORM of its own. Mount it behind Express, Nest, Next route handlers, Vendure plugins or anything else.

## Install

```bash
npm install @weblabllc/pages-core
# plus ONE driver only if you use the built-in stores:
npm install pg        # or mysql2, or mongodb
```

Installing the package pulls no DB drivers, creates no tables and runs nothing implicitly. Node 22.12+, ESM only.

## Content kinds are features

```ts
import { ContentModel, PAGE_KIND, ARTICLE_KIND, BLOG_KIND,
         articlesOnlyModel, blogOnlyModel, fullBlogModel } from '@weblabllc/pages-core'

const model = articlesOnlyModel()          // page + article, no blog
model.assertKind('blog')                   // throws: not enabled
model.schemaFeatures()                     // → which tables the store may create
```

Each kind is a set of flags:

- `taxonomy`: categories, pinned posts and a cover image;
- `authors`;
- `readingTime`;
- `categoryKind`: articles and the blog keep separate category namespaces;
- `addressing` and `categoryInPath`: see Folders below.

Custom kinds work too: `new ContentModel({ kinds: { news: { taxonomy: true, categoryKind: 'news' } } })`.

## Storage (opt-in)

```ts
import { createPageStore } from '@weblabllc/pages-core'

const store = await createPageStore({ driver: 'postgres', url: process.env.DATABASE_URL, tablePrefix: 'cms_' })
await store.ensureSchema(model.schemaFeatures())   // explicit; creates ONLY enabled feature tables

await store.createPage({ slug: 'first', tenant: '', type: 'article', status: 'draft', /* ... */ })
await store.listPages({ type: 'article', category: 'news', page: 1, pageSize: 25 })
```

All three adapters share one `PageStore` port. To reuse your app's connections, pass your own pool or client via `client:`. Multi-tenancy works through the `tenant` column.

`ensureSchema` is idempotent and only adds things. Turning a feature on later, for example `folders`, adds the missing columns and tables and keeps the existing rows. It never drops or rewrites anything.

## Folders, computed slugs and redirects

Turn folders on in the model to get `/countries/europe/germany` style addresses:

```ts
import { fullBlogModel, PageAddressing } from '@weblabllc/pages-core'

const model = fullBlogModel({ folders: true })
await store.ensureSchema(model.schemaFeatures())
const addressing = new PageAddressing(store, model, tenant)

const countries = await addressing.createFolder({ name: 'Countries', segment: 'countries' })
const europe = await addressing.createFolder({ name: 'Europe', segment: 'europe', parentId: countries.id })

const placed = await addressing.prepareNew({ type: 'page', folderId: europe.id, segment: 'germany' })
await store.createPage({ ...draft, ...placed })            // slug: countries/europe/germany

const { renamedPages } = await addressing.updateFolder(europe.id, { segment: 'eu' })
// renamedPages: [{ from: 'countries/europe/germany', to: 'countries/eu/germany' }]

await addressing.resolve('countries/europe/germany')      // { redirectTo: 'countries/eu/germany' }
```

The slug is computed as `[category/] + folder path + segment`:

| kind | addressing | example |
| --- | --- | --- |
| page | nested | `countries/europe/germany` |
| article | nested, category in path | `guides/countries/europe/intro` |
| blog | flat | `hello-world` |

The service enforces these rules:

- Folder segments are kebab-case. Folder names must be unique among siblings.
- A folder cannot be moved into its own subtree.
- Deleting a folder that still has children or pages is refused.
- Old slugs stay in a history table, so every former address answers with a redirect to the current one. Chains collapse, and a new page may claim a former slug.

Failures throw a `ContentError` with a `code` and an HTTP `status`:

| code | status |
| --- | --- |
| `not_found` | 404 |
| `invalid_segment` | 400 |
| `slug_conflict` | 409 |
| `folder_conflict` | 409 |
| `folder_cycle` | 400 |
| `folder_not_empty` | 409 |
| `invalid_import` | 400 |

With folders off, every kind stays flat and nothing changes for existing data.

## Export / import

```ts
import { exportPortablePage, validatePortablePage } from '@weblabllc/pages-core'

const json = exportPortablePage(page)
const patch = validatePortablePage(body, { slug: page.slug, type: page.type, langs: ['en', 'ua'] })
await store.updatePage(page.slug, patch)
```

The validator rejects these imports:

- the slug differs from the target page;
- the type differs (types are immutable);
- blocks lack a `type` or `props.id`, including blocks in zones;
- a translation object has unknown languages or non-string values.

## Sitemaps

```ts
import { contentSitemapEntries, renderSitemapXml } from '@weblabllc/pages-core'

const entries = contentSitemapEntries(publishedPosts, { basePath: '/blog', categories: ['news', 'tips'], includeAuthors: true })
const xml = renderSitemapXml(entries, 'https://example.com')
```

The listing page, each category page and each author page get the latest `lastmod` of their pages.

## Domain helpers

- `slugify`: Ukrainian transliteration.
- `applyPublish` / `applyUnpublish`: the first `publishedAt` survives republishing.
- `sanitizeMlt` / `resolveMlt`.
- `computeReadingTime`: 200 wpm; for multi-language text it counts the primary language.
- `paginationMeta`.
- `validateAuthorCreate` / `canDeleteAuthor`.
- `isValidImageUrl`: blocks protocol-relative URLs.
- `normalizeBlocks`.

## Test

```bash
npm test               # unit tests; store tests are skipped without databases
npm run test:stores    # starts Postgres, MySQL and MongoDB in docker and runs the store contract suite
```

To run the store suite against your own databases, set `PAGES_PG_URL`, `PAGES_MYSQL_URL` and `PAGES_MONGO_URL`.

## License

MIT
