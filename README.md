# @risklight/pages-core

Transport- and ORM-agnostic backend core for Puck-edited content. Ported from a battle-tested production backend: publish lifecycle, immutable content kinds, MultiLangText, reading time, shp-compatible pagination, authors and per-kind categories — plus optional storage adapters for Postgres, MySQL and MongoDB.

## Install

```bash
npm install @risklight/pages-core
# plus ONE driver only if you use the built-in stores:
npm install pg        # or mysql2, or mongodb
```

Installing the package pulls no DB drivers, creates no tables and runs nothing implicitly.

## Content kinds are features

```ts
import { ContentModel, PAGE_KIND, ARTICLE_KIND, BLOG_KIND,
         articlesOnlyModel, blogOnlyModel, fullBlogModel } from '@risklight/pages-core'

const model = articlesOnlyModel()          // page + article, no blog
model.assertKind('blog')                   // throws: not enabled
model.schemaFeatures()                     // → which tables the store may create
```

Each kind is a flag set: `taxonomy` (categories/pinned/cover), `authors`, `readingTime`, `categoryKind` (articles and blog keep separate category namespaces). Any custom kind works: `new ContentModel({ kinds: { news: { taxonomy: true, categoryKind: 'news' } } })`.

## Storage (opt-in)

```ts
import { createPageStore } from '@risklight/pages-core'

const store = await createPageStore({ driver: 'postgres', url: process.env.DATABASE_URL, tablePrefix: 'cms_' })
await store.ensureSchema(model.schemaFeatures())   // explicit; creates ONLY enabled feature tables

await store.createPage({ slug: 'first', tenant: '', type: 'article', status: 'draft', /* ... */ })
await store.listPages({ type: 'article', category: 'news', page: 1, pageSize: 25 })
```

All three adapters share one `PageStore` port; pass your own pool/client via `client:` to reuse app connections. Multi-tenant via the `tenant` column. Schema is create-only — migrations between versions are yours.

## Domain helpers

`slugify` (ukrainian transliteration), `applyPublish`/`applyUnpublish` (first `publishedAt` survives republishing), `sanitizeMlt`/`resolveMlt`, `computeReadingTime` (200 wpm, MLT counts the primary language), `paginationMeta`, `validateAuthorCreate`/`canDeleteAuthor`, `isValidImageUrl` (blocks protocol-relative URLs), `normalizeBlocks`.

## Test

```bash
npm test
```

Integration smoke against live Postgres/MySQL/MongoDB lives in the consuming repo (`scripts/packages-smoke.js`).
