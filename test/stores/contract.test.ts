import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentError, createPageStore, fullBlogModel, PageAddressing, PageStore, PageStoreOptions, StoredPage } from '../../src/index.js';

const targets: Array<[string, PageStoreOptions | null]> = [
    ['postgres', process.env.PAGES_PG_URL ? { driver: 'postgres', url: process.env.PAGES_PG_URL } : null],
    ['mysql', process.env.PAGES_MYSQL_URL ? { driver: 'mysql', url: process.env.PAGES_MYSQL_URL } : null],
    ['mongodb', process.env.PAGES_MONGO_URL ? { driver: 'mongodb', url: process.env.PAGES_MONGO_URL, database: 'pages_core_test' } : null],
];

const page = (slug: string, extra: Partial<StoredPage> = {}): StoredPage => ({
    slug,
    tenant: '',
    type: 'page',
    status: 'draft',
    title: slug,
    titleMlt: { en: slug, ua: slug },
    annotation: null,
    data: { root: { props: {} }, content: [] },
    category: null,
    pinned: false,
    authorSlug: null,
    coverImage: null,
    readingTime: null,
    publishedAt: null,
    ...extra,
});

const code = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof ContentError) return error.code;
        throw error;
    }
    return 'ok';
};

for (const [name, options] of targets) {
    describe.skipIf(!options)(`${name} store`, () => {
        const prefix = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_`;
        let store: PageStore;

        beforeAll(async () => {
            store = await createPageStore({ ...options!, tablePrefix: prefix });
            await store.ensureSchema({ pages: true, authors: true, categories: true });
            await store.createPage(page('legacy'));
            await store.ensureSchema({ pages: true, authors: true, categories: true, folders: true });
            await store.ensureSchema({ pages: true, authors: true, categories: true, folders: true });
        });

        afterAll(async () => {
            await store?.close();
        });

        it('upgrades an existing schema without losing pages', async () => {
            const legacy = await store.getPage('legacy');
            expect(legacy?.title).toBe('legacy');
            expect(legacy?.folderId ?? null).toBeNull();
        });

        it('round-trips pages with json fields and patches', async () => {
            await store.createPage(page('about', { titleMlt: { en: 'About', ua: 'Про нас' }, data: { root: { props: { a: 1 } }, content: [{ type: 'X', props: { id: 'x' } }] } }));
            const updated = await store.updatePage('about', { status: 'published', publishedAt: new Date('2026-09-01T10:00:00Z') });
            expect(updated?.status).toBe('published');
            expect(updated?.titleMlt).toEqual({ en: 'About', ua: 'Про нас' });
            expect((updated?.data as { content: unknown[] }).content).toHaveLength(1);
            expect(updated?.publishedAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
            expect(await store.updatePage('missing', { title: 'x' })).toBeNull();
        });

        it('lists with filters, search and pagination', async () => {
            for (let i = 0; i < 5; i++) {
                await store.createPage(page(`post-${i}`, { type: 'blog', category: i % 2 ? 'news' : 'tips', title: `Post ${i}` }));
            }
            const all = await store.listPages({ type: 'blog', pageSize: 2, page: 2 });
            expect(all.pagination.total_count).toBe(5);
            expect(all.rows).toHaveLength(2);
            expect(all.pagination).toMatchObject({ total_pages: 3, current_page: 2, has_next_page: true, has_prev_page: true });
            expect((await store.listPages({ type: 'blog', category: 'news' })).pagination.total_count).toBe(2);
            expect((await store.listPages({ type: 'blog', search: 'Post 3' })).rows.map(r => r.slug)).toEqual(['post-3']);
        });

        it('keeps tenants apart', async () => {
            await store.createPage(page('about', { tenant: 'other', title: 'Other' }));
            expect((await store.getPage('about', 'other'))?.title).toBe('Other');
            expect((await store.getPage('about'))?.title).toBe('about');
            expect(await store.deletePage('about', 'other')).toBe(true);
            expect(await store.getPage('about')).not.toBeNull();
        });

        it('stores authors and categories', async () => {
            await store.upsertAuthor({ slug: 'ivan', tenant: '', name: { en: 'Ivan' }, photo: null, role: null, enabled: true });
            await store.upsertAuthor({ slug: 'ivan', tenant: '', name: { en: 'Ivan P.' }, photo: null, role: 'editor', enabled: false });
            expect((await store.getAuthor('ivan'))?.enabled).toBe(false);
            expect(await store.listAuthors({ enabledOnly: true })).toHaveLength(0);
            await store.updatePage('post-1', { authorSlug: 'ivan' });
            expect(await store.countPagesByAuthor('ivan')).toBe(1);
            await store.upsertCategory({ slug: 'news', tenant: '', kind: 'blog', name: { en: 'News' }, sortOrder: 2, enabled: true });
            await store.upsertCategory({ slug: 'tips', tenant: '', kind: 'blog', name: { en: 'Tips' }, sortOrder: 1, enabled: true });
            expect((await store.listCategories('blog')).map(c => c.slug)).toEqual(['tips', 'news']);
            expect(await store.deleteCategory('blog', 'tips')).toBe(true);
        });

        describe('addressing', () => {
            let addressing: PageAddressing;
            let countries: string;
            let europe: string;

            beforeAll(async () => {
                addressing = new PageAddressing(store, fullBlogModel({ folders: true }));
                countries = (await addressing.createFolder({ name: 'Countries', segment: 'countries' })).id;
                europe = (await addressing.createFolder({ name: 'Europe', segment: 'europe', parentId: countries })).id;
            });

            it('composes slugs from folders and rejects conflicts', async () => {
                const placed = await addressing.prepareNew({ type: 'page', folderId: europe, segment: 'germany' });
                expect(placed.slug).toBe('countries/europe/germany');
                await store.createPage(page(placed.slug, placed));
                expect(await code(addressing.prepareNew({ type: 'page', folderId: europe, segment: 'germany' }))).toBe('slug_conflict');
                expect(await code(addressing.createFolder({ name: 'Dup', segment: 'europe', parentId: countries }))).toBe('folder_conflict');
                expect(await code(addressing.createFolder({ name: 'Bad', segment: 'Bad Name' }))).toBe('invalid_segment');
                expect((await addressing.tree())[0].children[0].segment).toBe('europe');
            });

            it('renames the subtree and redirects old slugs', async () => {
                const { renamedPages } = await addressing.updateFolder(europe, { segment: 'eu' });
                expect(renamedPages).toEqual([{ from: 'countries/europe/germany', to: 'countries/eu/germany' }]);
                expect(await addressing.resolve('countries/europe/germany')).toEqual({ redirectTo: 'countries/eu/germany' });

                await addressing.updateFolder(countries, { segment: 'world' });
                expect(await addressing.resolve('countries/europe/germany')).toEqual({ redirectTo: 'world/eu/germany' });
                expect(await addressing.resolve('countries/eu/germany')).toEqual({ redirectTo: 'world/eu/germany' });
                expect(await addressing.resolve('world/eu/germany')).toMatchObject({ page: { slug: 'world/eu/germany' } });
                expect(await addressing.resolve('nowhere')).toBeNull();
            });

            it('moves a page back to an old address and drops the loop', async () => {
                await addressing.updateFolder(countries, { segment: 'countries' });
                expect(await addressing.resolve('countries/eu/germany')).toMatchObject({ page: { slug: 'countries/eu/germany' } });
                expect(await addressing.resolve('world/eu/germany')).toEqual({ redirectTo: 'countries/eu/germany' });
                const moved = await addressing.movePage('countries/eu/germany', null);
                expect(moved).toBe('germany');
                expect(await addressing.resolve('countries/europe/germany')).toEqual({ redirectTo: 'germany' });
            });

            it('lets a new page claim a former slug', async () => {
                const placed = await addressing.prepareNew({ type: 'page', folderId: europe, segment: 'germany' });
                await store.createPage(page(placed.slug, placed));
                expect(await addressing.resolve('countries/eu/germany')).toMatchObject({ page: { slug: 'countries/eu/germany' } });
            });

            it('refuses cycles and deleting non-empty folders', async () => {
                expect(await code(addressing.updateFolder(countries, { parentId: europe }))).toBe('folder_cycle');
                expect(await code(addressing.deleteFolder(countries))).toBe('folder_not_empty');
                const empty = await addressing.createFolder({ name: 'Empty', segment: 'empty' });
                expect(await code(addressing.deleteFolder(empty.id))).toBe('ok');
                expect(await code(addressing.deleteFolder(empty.id))).toBe('not_found');
            });

            it('keeps blog posts flat regardless of folders', async () => {
                expect(await addressing.slugFor({ type: 'blog', category: 'news', folderId: europe, segment: 'hello' })).toBe('hello');
                expect(await addressing.slugFor({ type: 'article', category: 'guides', folderId: europe, segment: 'intro' })).toBe('guides/countries/eu/intro');
            });
        });
    });
}
