import { describe, expect, it } from 'vitest';
import { createPageStore, PageStoreOptions, StoreConflictError, StoredPage, uuidv7 } from '../../src/index.js';

const targets: Array<[string, PageStoreOptions | null]> = [
    ['postgres', process.env.PAGES_PG_URL ? { driver: 'postgres', url: process.env.PAGES_PG_URL } : null],
    ['mysql', process.env.PAGES_MYSQL_URL ? { driver: 'mysql', url: process.env.PAGES_MYSQL_URL } : null],
    ['mongodb', process.env.PAGES_MONGO_URL ? { driver: 'mongodb', url: process.env.PAGES_MONGO_URL, database: 'pages_core_test' } : null],
];

const ALL = { pages: true, authors: true, categories: true, folders: true, roles: true, comments: true, slugHistory: true };

const page = (slug: string): StoredPage => ({
    id: uuidv7(),
    slug,
    tenant: '',
    type: 'page',
    status: 'draft',
    title: slug,
    titleMlt: { en: slug },
    annotation: null,
    data: null,
    category: null,
    pinned: false,
    authorSlug: null,
    coverImage: null,
    readingTime: null,
    publishedAt: null,
});

for (const [name, options] of targets) {
    describe.skipIf(!options)(`${name} concurrency`, () => {
        it('lets three processes prepare the schema at once, then settles a slug race at the database', async () => {
            const tablePrefix = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_`;
            const stores = await Promise.all([1, 2, 3].map(() => createPageStore({ ...options!, tablePrefix })));
            try {
                await Promise.all(stores.map(s => s.ensureSchema(ALL)));
                const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => stores[i % 3].createPage(page('race'))));
                const won = results.filter(r => r.status === 'fulfilled');
                const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
                expect(won).toHaveLength(1);
                expect(lost).toHaveLength(9);
                for (const r of lost) {
                    expect(r.reason).toBeInstanceOf(StoreConflictError);
                    expect(r.reason.target).toBe('page_slug');
                }
            } finally {
                await Promise.all(stores.map(s => s.close()));
            }
        });

        it('keeps a delete and an update of the same page consistent', async () => {
            const tablePrefix = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_`;
            const store = await createPageStore({ ...options!, tablePrefix });
            try {
                await store.ensureSchema(ALL);
                const p = await store.createPage(page('contested'));
                const [updated, deleted] = await Promise.all([store.updatePage(p.id, { title: 'changed' }), store.deletePage(p.id)]);
                expect(deleted).toBe(true);
                expect(updated === null || updated.title === 'changed').toBe(true);
                expect(await store.getPageById(p.id)).toBeNull();
            } finally {
                await store.close();
            }
        });
    });
}
