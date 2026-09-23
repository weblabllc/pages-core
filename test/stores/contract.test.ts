import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentError, ContentModel, createPageStore, DEFAULT_PAGE_ROLES, fullBlogModel, PAGE_KIND, PageAddressing, PageComments, PageRoles, PageStore, PageStoreOptions, StoredPage } from '../../src/index.js';

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
            await store.ensureSchema({ pages: true, authors: true, categories: true, folders: true, roles: true, comments: true });
            await store.ensureSchema({ pages: true, authors: true, categories: true, folders: true, roles: true, comments: true });
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

        it('stores seo title and description in every language', async () => {
            await store.createPage(page('seo-page', { seoTitle: { en: 'About us — Shop', ua: 'Про нас — Магазин' }, seoDescription: null }));
            const created = await store.getPage('seo-page');
            expect(created?.seoTitle).toEqual({ en: 'About us — Shop', ua: 'Про нас — Магазин' });
            expect(created?.seoDescription ?? null).toBeNull();
            const updated = await store.updatePage('seo-page', { seoDescription: { en: 'Who we are', ua: 'Хто ми' } });
            expect(updated?.seoDescription).toEqual({ en: 'Who we are', ua: 'Хто ми' });
            expect(updated?.seoTitle).toEqual({ en: 'About us — Shop', ua: 'Про нас — Магазин' });
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

        it('remembers who created a page', async () => {
            await store.createPage(page('authored', { createdBy: 'admin-7' }));
            expect((await store.getPage('authored'))?.createdBy).toBe('admin-7');
        });

        describe('comments', () => {
            const comments = () => new PageComments(store, fullBlogModel({ folders: true }));

            beforeAll(async () => {
                await store.createPage(page('post-with-comments', { type: 'blog', status: 'published' }));
                await store.createPage(page('post-draft', { type: 'blog', status: 'draft' }));
                await store.createPage(page('plain-page', { type: 'page', status: 'published' }));
            });

            it('accepts comments on published posts as pending and refuses others', async () => {
                const first = await comments().submit('post-with-comments', { authorName: 'Іван', content: 'Перший', rating: 5 }, { ip: '203.0.113.1' });
                expect(first).toMatchObject({ status: 'pending', pageSlug: 'post-with-comments', rating: 5, ip: '203.0.113.1', moderatedBy: null });
                expect(await code(comments().submit('post-draft', { authorName: 'A', content: 'x' }))).toBe('not_found');
                expect(await code(comments().submit('plain-page', { authorName: 'A', content: 'x' }))).toBe('comments_disabled');
                expect(await code(comments().submit('post-with-comments', { authorName: '', content: 'x' }))).toBe('invalid_comment');
            });

            it('moderates, lists approved newest first and aggregates ratings', async () => {
                const second = await comments().submit('post-with-comments', { authorName: 'Олена', content: 'Другий', rating: 4 });
                const third = await comments().submit('post-with-comments', { authorName: 'Спам', content: 'Купи' });
                const queue = await comments().queue({ status: 'pending' });
                expect(queue.rows.length).toBe(3);
                for (const c of queue.rows.filter(r => r.authorName !== 'Спам')) {
                    const approved = await comments().moderate(c.id, 'approved', 'moderator-1');
                    expect(approved).toMatchObject({ status: 'approved', moderatedBy: 'moderator-1' });
                    expect(approved.moderatedAt).toBeInstanceOf(Date);
                }
                await comments().moderate(third.id, 'rejected', 'moderator-1');
                const visible = await comments().approved('post-with-comments');
                expect(visible.rows.map(c => c.authorName)).toEqual(['Олена', 'Іван']);
                expect(Object.keys(visible.rows[0]).sort()).toEqual(['authorName', 'content', 'createdAt', 'id', 'rating']);
                expect(await comments().ratings(['post-with-comments', 'post-draft'])).toEqual({ 'post-with-comments': { avg: 4.5, count: 2 } });
                expect(second.id < third.id).toBe(true);
                await comments().remove(third.id);
                expect(await code(comments().remove(third.id))).toBe('not_found');
                expect(await code(comments().moderate('missing', 'approved', null))).toBe('not_found');
            });

            it('follows the page when it is renamed', async () => {
                await store.renamePage('post-with-comments', 'post-renamed');
                expect((await comments().approved('post-renamed')).rows).toHaveLength(2);
                expect((await comments().approved('post-with-comments')).rows).toHaveLength(0);
            });
        });

        describe('page roles', () => {
            const roles = () => new PageRoles(store, new ContentModel({ kinds: { page: PAGE_KIND }, roles: DEFAULT_PAGE_ROLES }));

            beforeAll(async () => {
                for (const slug of ['oferta', 'oferta-v2', 'privacy', 'plain-1', 'plain-2']) {
                    await store.createPage(page(slug, { status: slug === 'privacy' ? 'draft' : 'published' }));
                }
            });

            it('assigns roles and moves a role to its new page', async () => {
                expect(await roles().assign('oferta', 'offer')).toEqual({ released: null });
                await roles().assign('privacy', 'privacy');
                expect(await roles().assign('oferta-v2', 'offer')).toEqual({ released: 'oferta' });
                expect((await store.getPage('oferta'))?.role ?? null).toBeNull();
                expect((await store.getPage('oferta-v2'))?.role).toBe('offer');
                expect((await store.listPagesWithRole()).map(p => [p.slug, p.role])).toEqual([['oferta-v2', 'offer'], ['privacy', 'privacy']]);
            });

            it('exposes only published pages as links', async () => {
                expect(Object.keys(await roles().links())).toEqual(['offer']);
                expect(Object.keys(await roles().links({ publishedOnly: false })).sort()).toEqual(['offer', 'privacy']);
            });

            it('keeps many pages without a role and refuses unknown roles', async () => {
                expect((await store.getPage('plain-1'))?.role ?? null).toBeNull();
                expect((await store.getPage('plain-2'))?.role ?? null).toBeNull();
                expect(await code(roles().assign('plain-1', 'about'))).toBe('invalid_role');
                expect(await code(roles().assign('missing', 'offer'))).toBe('not_found');
            });

            it('clears a role', async () => {
                await roles().assign('oferta-v2', null);
                expect((await store.listPagesWithRole()).map(p => p.slug)).toEqual(['privacy']);
            });

            it('refuses two holders of one role at the storage level', async () => {
                await store.setRole('plain-1', 'returns');
                await expect(store.createPage(page('dup-returns', { role: 'returns' }))).rejects.toThrow();
            });
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
