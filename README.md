# @weblabllc/pages-core

[![npm](https://img.shields.io/npm/v/@weblabllc/pages-core)](https://www.npmjs.com/package/@weblabllc/pages-core) [![ci](https://github.com/weblabllc/pages-core/actions/workflows/ci.yml/badge.svg)](https://github.com/weblabllc/pages-core/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@weblabllc/pages-core)](LICENSE)

A backend core for site content: pages, articles and blog posts. It does not depend on any web framework or ORM. It covers:

- content kinds with their own rules: categories, authors, reading time, comments;
- multi-language text and SEO fields;
- a publish lifecycle;
- folders with computed addresses, and redirects from old addresses;
- page roles (the offer, the privacy policy);
- moderated comments with ratings;
- portable export and import;
- sitemaps;
- stores for Postgres, MySQL and MongoDB with transactions.

Mount it behind Express, Nest, Next route handlers, Vendure plugins or anything else. The services hold every rule. The stores only read and write.

## Install

```bash
npm install @weblabllc/pages-core
# plus ONE driver only if you use the built-in stores:
npm install pg        # or mysql2, or mongodb
```

Installing the package pulls no database drivers, creates no tables and runs nothing implicitly. It needs Node 22.12+ and is ESM only.

## Content model

```ts
import { ContentModel, PAGE_KIND, ARTICLE_KIND, BLOG_KIND, DEFAULT_PAGE_ROLES } from '@weblabllc/pages-core'

const model = new ContentModel({
    kinds: { page: PAGE_KIND, blog: BLOG_KIND },
    langs: ['uk', 'en'],             // the first one is the primary language
    folders: true,
    roles: DEFAULT_PAGE_ROLES,
    publishedAt: 'first',            // or 'latest': republishing moves the date
    limits: { titleMlt: 500 },       // defaults: title 512, titleMlt 300, annotation 1000, seoTitle 300, seoDescription 1000
    defaultAuthor: 'editorial',
})
model.schemaFeatures()               // which tables and columns the store should create
```

A kind is a set of flags:

| flag | meaning |
| --- | --- |
| `taxonomy` | categories, pinned posts, a cover image |
| `categoryKind` | the category namespace (articles and the blog keep separate ones) |
| `categoryRequired` | a post cannot be saved without an enabled category |
| `authors` | an author is required once set; `defaultAuthor` fills new posts |
| `readingTime` | recomputed from the content on every save |
| `comments` | public, moderated comments with a 1–5 rating |
| `addressing`, `categoryInPath` | how the address is built (see Folders) |
| `reservedSlugs` | addresses the kind cannot use (`BLOG_KIND` reserves `category`, `author` and others) |
| `listing` | the default order and page size of public lists |
| `data` | the content format (see below) |

The presets are:

- `PAGE_KIND`: nested addresses;
- `ARTICLE_KIND`: categories are required and appear in the address; newest first, 9 per page;
- `BLOG_KIND`: flat addresses, categories, authors, reading time, comments; pinned posts first, 9 per page.

`articlesOnlyModel()`, `blogOnlyModel()` and `fullBlogModel()` are shortcuts.

### Content formats

`data` is validated by the kind's codec:

- `PUCK_DATA` (default): a [Puck](https://puckeditor.com) document. Every block needs `type` and `props.id`, and translation objects may only use the model's languages.
- `localizedBlocksData()`: `{ uk: { blocks: [...] }, en: { blocks: [...] } }` with simple blocks (heading, paragraph, quote, image, document, form markers). Each language is normalized.

A custom codec implements `validate`, `words` and, optionally, `meta` and `localize`.

## Storage

```ts
import { createPageStore } from '@weblabllc/pages-core'

const store = await createPageStore({ driver: 'postgres', url: process.env.DATABASE_URL, tablePrefix: 'cms_' })
await store.ensureSchema(model.schemaFeatures())
```

- `ensureSchema` is idempotent and only adds things. Turning a feature on later adds its columns and tables and keeps the existing rows. Several processes may run it at once: Postgres and MySQL take a lock named after the prefix.
- Pass your app's pool as `client:` to share connections. `tablePrefix` is at most 20 characters, so that index names fit.
- Pages are keyed by a stable `id` (UUIDv7). The address (`slug`) is unique per tenant and may change.
- Multi-tenancy works through `tenant`. Every service takes the tenant as its last constructor argument.

### Transactions

Every write of the services runs in `store.transaction(fn)`. A rename, the redirects it leaves, a role move and a folder rename with all its pages either all happen or none do.

| `clientMode` | behaviour |
| --- | --- |
| `'pool'` (default) | the store checks out a connection per transaction. The client you pass must be a pool: `pg.Pool`, a `mysql2` pool, a `MongoClient`. |
| `'bound'` | the client you pass is already inside your own transaction, for example a TypeORM query runner in a migration. The store never begins or commits; `transaction(fn)` just runs `fn`. |

Driver notes:

- **MySQL:** every `CREATE`/`ALTER` commits the open transaction implicitly. That is how MySQL works. In `'bound'` mode, `ensureSchema` therefore commits your transaction. Run it before your own data changes, or in a separate step.
- **MongoDB:** transactions need a replica set or a sharded cluster. With `mongoTransactions: 'auto'` (the default), a standalone server runs the same code without atomicity and warns once. `'require'` refuses instead. The driver may retry a transaction body after a transient error, so keep side effects (emails, HTTP calls) outside it.
- **Postgres:** a unique violation aborts the open transaction. The services therefore check addresses before writing, and treat the database index only as the final guard against races.

A unique violation becomes `StoreConflictError` with a `target` (`page_slug`, `page_role`, `folder_sibling`, `page_id`, `comment_id`). The services turn it into a `ContentError` such as `slug_conflict`.

### Search

`search` does a case-insensitive substring match on the title, the address and the chosen translations. `%` and `_` match literally. It scans rows and uses no index. For large tables on Postgres, add a trigram index yourself:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX cms_pages_title_trgm ON cms_pages USING gin (title gin_trgm_ops);
```

## Writing pages

```ts
import { PageService } from '@weblabllc/pages-core'

const pages = new PageService(store, model, { tenant })

const { page, changes } = await pages.create({ type: 'page', segment: 'about', titleMlt: { uk: 'Про нас', en: 'About' }, data }, { id: userId })
await pages.update(page.id, { segment: 'about-us', seoTitle: { uk: '...' } })
await pages.publish(page.id)
await pages.unpublish(page.id)
await pages.move(page.id, folderId)
await pages.delete(page.id)

const json = await pages.exportPortable(page.id)
await pages.importPortable(page.id, json)
```

Every write returns `{ page, changes }`, and only after the commit. `changes` lists every page whose public address or content changed:

```ts
{ id, slug, type, reason: 'created' | 'updated' | 'renamed' | 'moved' | 'published' | 'unpublished' | 'deleted' | 'role_released', previousSlug? }
```

Use it to revalidate caches. A rename also carries `previousSlug`.

The rules the service applies:

- A new page is a draft owned by `actor.id` (`createdBy`, never changed later).
- The type cannot change.
- Only the fields of the kind are kept. For example, a plain page gets no category.
- Categories and authors must exist and be enabled. An author cannot be removed from a post, only replaced.
- `pinned` must be a real boolean. `coverImage` must be an `http(s)` URL or an absolute path.
- Translations are cleaned: control characters are stripped and the length limits and model languages are enforced.
- When no plain `title` is given, it comes from the primary-language title.
- The reading time is recomputed on every save of `data`.
- Import takes content only: `status`, `type`, the address, the role and the folder are ignored.
- Deleting a page removes its redirects and comments too. A new page at the same address starts clean.

## Reading pages

```ts
import { PageQueries } from '@weblabllc/pages-core'

const queries = new PageQueries(store, model, tenant)

await queries.list('blog', req.query)               // published cards, with author and rating
await queries.adminList(req.query)                  // any status, for the admin
await queries.list('page', req.query, { projection: 'full' })   // with content; lists return cards by default
await queries.publishedPage('countries/eu/germany') // { page, meta: { folders, author, rating } } | { redirectTo } | null
await queries.publishedIndex()                      // light rows of everything published, for sitemaps
queries.localizedView(page, 'en')                   // { languageCode, title, annotation, seoTitle, seoDescription, data }
```

List parameters come straight from a query string. Invalid values are ignored:

- `page`, and `limit` or `pageSize`, capped at `maxPageSize` (100 by default);
- `sortBy`: `publishedAt`, `updatedAt`, `readingTime` or `title`. An explicit sort replaces the default order, so pinned posts lose priority;
- `sortOrder`: `asc` or `desc`;
- `status` (admin only), `category`, `hasCategory`, `author`, `pinned`;
- `folderId`, where `root` means pages outside folders;
- `search`.

Every order ends with the page id, so pages never repeat or go missing between pages of a list.

`localizedView` keeps a page in one language. It uses the requested language if the page has a title in it; otherwise it uses the primary language for every field.

Only kinds registered in the model are ever returned.

## Folders, addresses and redirects

```ts
import { PageAddressing } from '@weblabllc/pages-core'

const addressing = new PageAddressing(store, model, tenant)

const countries = await addressing.createFolder({ name: 'Countries', segment: 'countries' })
const europe = await addressing.createFolder({ name: 'Europe', segment: 'europe', parentId: countries.id })
await pages.create({ type: 'page', segment: 'germany', folderId: europe.id })   // countries/europe/germany

const { changes } = await addressing.updateFolder(europe.id, { segment: 'eu' })
// every page below moves in the same transaction; changes carry previousSlug

await addressing.resolve('countries/europe/germany')   // { redirectTo: 'countries/eu/germany' }
```

The address is `[category/] + folder path + segment`:

| kind | addressing | example |
| --- | --- | --- |
| page | nested | `countries/europe/germany` |
| article | nested, category in path | `guides/countries/europe/intro` |
| blog | flat | `hello-world` |

The rules:

- Folder segments are kebab-case and unique among siblings. The database enforces this too.
- Names are required, at most 255 characters. Translated names are at most 100 per language. `sortOrder` must be an integer.
- A folder cannot move into its own subtree. A folder with children or pages cannot be deleted.
- A former address redirects to the page that had it, as long as that page is published. A draft gives no redirect. A new page may claim a former address.

Redirect history works with folders off too: set `slugHistory: true` in the model.

## Page roles

A role marks the one page that plays a part the site links to on its own, for example the public offer, the privacy policy or the returns policy. Code asks for the role, not for an address, so renames never break the link.

```ts
import { PageRoles } from '@weblabllc/pages-core'

const roles = new PageRoles(store, model, tenant)
await pages.create({ type: 'page', segment: 'oferta', role: 'offer' })
await roles.assign(otherPage.id, 'offer')     // { released: <previous holder id>, changes }
await roles.links({ basePath: '' })           // { offer: { role, slug, title, path } } for published holders
```

A role belongs to one page per tenant. Giving it to another page takes it from the previous holder in the same transaction.

## Comments

```ts
import { PageComments } from '@weblabllc/pages-core'

const comments = new PageComments(store, model, tenant)

await comments.submit('first-post', body, { userId, ip })   // pending
await comments.queue({ status: 'pending', search: 'spam', sortBy: 'createdAt' })   // with page { id, slug, title }
await comments.moderate(id, 'approved', moderatorId)        // or 'rejected'
await comments.approved('first-post', { page: 1 })          // { rows, rating, pagination }, 20 per page
await comments.ratings([pageId])                             // { [pageId]: { avg, count } }
```

- Comments are accepted only on published pages whose kind has comments. The public list answers `not_found` otherwise.
- `authorName` is 1–120 characters and `content` 1–4000. `authorEmail` is optional (at most 255, valid format). `rating` is optional, an integer from 1 to 5; the database checks it too.
- The public list shows only `id`, `authorName`, `content`, `rating` and `createdAt`.
- Comments belong to the page id, so they follow renames and go away with the page.

Captcha and rate limiting stay in your app.

## Categories and authors

```ts
import { PageTaxonomy } from '@weblabllc/pages-core'

const taxonomy = new PageTaxonomy(store, model, tenant)
await taxonomy.saveCategory('blog', { slug: 'news', name: { uk: 'Новини' }, sortOrder: 1 })
await taxonomy.createAuthor({ slug: 'ivan', name: { uk: 'Іван' } })
await taxonomy.updateAuthor('ivan', { enabled: false })
await taxonomy.deleteCategory('blog', 'news')   // category_in_use while pages use it
await taxonomy.deleteAuthor('ivan')             // author_in_use while pages use it
```

## Sitemaps

```ts
import { contentSitemapEntries, renderSitemapXml } from '@weblabllc/pages-core'

const entries = contentSitemapEntries(await queries.publishedIndex(), { basePath: '/blog', categories: ['news'], includeAuthors: true })
const xml = renderSitemapXml(entries, 'https://example.com')
```

`sections` picks the parts and their order: `root`, `categories`, `pages`, `authors`.

## Errors

Services throw `ContentError` with a `code` and an HTTP `status`:

| code | status |
| --- | --- |
| `not_found` | 404 |
| `invalid_page`, `invalid_segment`, `invalid_folder`, `invalid_import`, `invalid_role`, `invalid_comment`, `type_immutable`, `folder_cycle` | 400 |
| `comments_disabled` | 403 |
| `slug_conflict`, `folder_conflict`, `folder_not_empty`, `role_conflict`, `category_in_use`, `author_in_use` | 409 |

`details.field` names the offending input field where there is one.

## Upgrading from 0.5

`ensureSchema` upgrades 0.5 tables in place:

1. It adds `id` to every page, stamped with the page's creation time, in batches of 500, each committed on its own.
2. It moves the primary key to `(tenant, id)` and keeps `(tenant, slug)` unique. On Postgres, the indexes are built `CONCURRENTLY` and `NOT NULL` is set through a validated check, so the table is only locked for the final swap. MySQL steps can be resumed after a crash.
3. It binds the redirect history to page ids. A redirect row older than the page now at its target address stays unbound and redirects nowhere.
4. It widens `title` to 512 characters.
5. It adds the author and category indexes, and a unique index on folder siblings. If duplicate sibling folders exist, it stops and lists them.

**Stop 0.5 writers during the upgrade.** A 0.5 process inserting a page without an id fails once the new key is in place.

Code changes:

- Services take ids instead of slugs: `update(id)`, `roles.assign(id, role)`, `resolveFormerSlug` returns an id.
- Create, update and delete pages through `PageService`, not the store.
- `listPages` takes `order`, `page` and `pageSize`; `search` is an object.
- `BLOG_KIND` and `ARTICLE_KIND` require a category.
- `applyPublish` and `applyUnpublish` take the publish policy.
- MySQL 8.0.16+ is required (CHECK constraints).

## Domain helpers

- `slugify`: Ukrainian transliteration.
- `sanitizeMlt` / `resolveMlt`.
- `computeReadingTime`: 200 words per minute. For multi-language text it counts the primary language.
- `paginationMeta`.
- `validateAuthorCreate` / `canDeleteAuthor`.
- `isValidImageUrl`: rejects protocol-relative URLs.
- `normalizeBlocks`.

## Test

```bash
npm test               # unit tests; store tests are skipped without databases
npm run test:stores    # starts Postgres, MySQL and MongoDB (a single-node replica set) in docker and runs the store and service suites
```

To run the store suites against your own databases, set `PAGES_PG_URL`, `PAGES_MYSQL_URL` and `PAGES_MONGO_URL`.

## License

MIT
