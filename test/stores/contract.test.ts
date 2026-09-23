import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPageStore, PageStore, PageStoreOptions, StoreConflictError, StoredComment, StoredPage, uuidv7 } from '../../src/index.js';

const targets: Array<[string, PageStoreOptions | null]> = [
    ['postgres', process.env.PAGES_PG_URL ? { driver: 'postgres', url: process.env.PAGES_PG_URL } : null],
    ['mysql', process.env.PAGES_MYSQL_URL ? { driver: 'mysql', url: process.env.PAGES_MYSQL_URL } : null],
    ['mongodb', process.env.PAGES_MONGO_URL ? { driver: 'mongodb', url: process.env.PAGES_MONGO_URL, database: 'pages_core_test' } : null],
];

const ALL = { pages: true, authors: true, categories: true, folders: true, roles: true, comments: true, slugHistory: true };

let seq = 0;
const page = (slug: string, extra: Partial<StoredPage> = {}): StoredPage => ({
    id: uuidv7(Date.now() + seq++),
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

const comment = (pageId: string, extra: Partial<StoredComment> = {}): StoredComment => ({
    id: uuidv7(Date.now() + seq++),
    tenant: '',
    pageId,
    userId: null,
    authorName: 'Іван',
    authorEmail: null,
    content: 'text',
    rating: null,
    status: 'pending',
    moderatedBy: null,
    moderatedAt: null,
    ip: null,
    createdAt: new Date(),
    ...extra,
});

const conflict = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof StoreConflictError) return error.target;
        throw error;
    }
    return 'none';
};

const all = { page: 1, pageSize: 100, order: [{ field: 'id' as const, direction: 'asc' as const }] };

for (const [name, options] of targets) {
    describe.skipIf(!options)(`${name} store`, () => {
        const prefix = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_`;
        let store: PageStore;

        beforeAll(async () => {
            store = await createPageStore({ ...options!, tablePrefix: prefix });
            await store.ensureSchema(ALL);
            await store.ensureSchema(ALL);
        });

        afterAll(async () => {
            await store?.close();
        });

        it('refuses table prefixes that would overflow identifiers', async () => {
            await expect(createPageStore({ ...options!, tablePrefix: 'x'.repeat(21) })).rejects.toThrow(/prefix/);
        });

        describe('pages', () => {
            it('round-trips by id and slug, keeping given timestamps', async () => {
                const created = new Date('2026-01-02T03:04:05Z');
                const p = page('about', { createdAt: created, updatedAt: created, seoTitle: { en: 'About — Shop' }, createdBy: 'admin-1', role: null });
                await store.createPage(p);
                const byId = await store.getPageById(p.id);
                expect(byId).toMatchObject({ id: p.id, slug: 'about', seoTitle: { en: 'About — Shop' }, createdBy: 'admin-1' });
                expect(byId?.createdAt?.toISOString()).toBe(created.toISOString());
                expect((await store.getPageBySlug('about'))?.id).toBe(p.id);
                expect(await store.getPageById('missing')).toBeNull();
            });

            it('rejects a second page on the same slug as a slug conflict', async () => {
                expect(await conflict(store.createPage(page('about')))).toBe('page_slug');
            });

            it('patches by id and never writes type, role, author or id', async () => {
                const p = await store.getPageBySlug('about');
                const updated = await store.updatePage(p!.id, { status: 'published', slug: 'about-us', type: 'blog', role: 'offer', createdBy: 'hacker', id: 'x' } as never);
                expect(updated).toMatchObject({ id: p!.id, slug: 'about-us', status: 'published', type: 'page', createdBy: 'admin-1' });
                expect(updated?.role ?? null).toBeNull();
                expect(await store.updatePage('missing', { title: 'x' })).toBeNull();
            });

            it('rolls back every write when the transaction fails', async () => {
                const a = page('tx-a');
                await expect(
                    store.transaction(async tx => {
                        await tx.createPage(a);
                        await tx.updatePage(a.id, { title: 'changed' });
                        throw new Error('boom');
                    }),
                ).rejects.toThrow('boom');
                expect(await store.getPageById(a.id)).toBeNull();
                const b = page('tx-b');
                const result = await store.transaction(async tx => {
                    await tx.createPage(b);
                    return (await tx.getPageById(b.id))?.slug;
                });
                expect(result).toBe('tx-b');
                expect(await store.getPageById(b.id)).not.toBeNull();
            });

            it('deletes by id', async () => {
                const b = await store.getPageBySlug('tx-b');
                expect(await store.deletePage(b!.id)).toBe(true);
                expect(await store.deletePage(b!.id)).toBe(false);
            });
        });

        describe('listing', () => {
            const tenant = 'list';
            const sameDate = new Date('2026-05-05T10:00:00Z');

            beforeAll(async () => {
                for (let i = 0; i < 30; i++) {
                    await store.createPage(page(`same-${i}`, { tenant, type: 'blog', status: 'published', publishedAt: sameDate, category: i % 3 ? 'news' : null, pinned: i === 7, authorSlug: i % 2 ? 'ivan' : null }));
                }
                await store.createPage(page('draft-null', { tenant, type: 'blog', publishedAt: null, folderId: 'f1' }));
                await store.createPage(page('kyiv', { tenant, type: 'article', status: 'published', publishedAt: new Date('2026-06-01'), title: 'Київ 50% off', titleMlt: { en: 'Kyiv', ua: 'Столиця КИЇВ' }, annotation: { ua: 'Про місто' } }));
            });

            it('pages through equal sort keys without duplicates or gaps', async () => {
                const seen: string[] = [];
                for (let p = 1; p <= 5; p++) {
                    const res = await store.listPages({ tenant, types: ['blog'], status: 'published', page: p, pageSize: 7, order: [{ field: 'publishedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] });
                    seen.push(...res.rows.map(r => r.slug));
                    expect(res.pagination.total_count).toBe(30);
                }
                expect(new Set(seen).size).toBe(30);
            });

            it('puts nulls last on descending and first on ascending order', async () => {
                const desc = await store.listPages({ tenant, page: 1, pageSize: 100, order: [{ field: 'publishedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] });
                expect(desc.rows[0].slug).toBe('kyiv');
                expect(desc.rows[desc.rows.length - 1].slug).toBe('draft-null');
                const asc = await store.listPages({ tenant, page: 1, pageSize: 100, order: [{ field: 'publishedAt', direction: 'asc' }, { field: 'id', direction: 'asc' }] });
                expect(asc.rows[0].slug).toBe('draft-null');
            });

            it('filters by type, category presence, author, pinned, folder and ids', async () => {
                const count = (f: object) => store.countPages({ tenant, ...f });
                expect(await count({ types: ['article'] })).toBe(1);
                expect(await count({ types: ['blog'], hasCategory: true })).toBe(20);
                expect(await count({ types: ['blog'], hasCategory: false })).toBe(11);
                expect(await count({ category: 'news' })).toBe(20);
                expect(await count({ authorSlug: 'ivan' })).toBe(15);
                expect(await count({ pinned: true })).toBe(1);
                expect(await count({ folderId: 'f1' })).toBe(1);
                expect(await count({ folderId: null })).toBe(31);
                expect(await count({ folderIds: ['f1', null] })).toBe(32);
                const kyiv = await store.getPageBySlug('kyiv', tenant);
                expect(await count({ ids: [kyiv!.id, 'missing'] })).toBe(1);
            });

            it('searches plain and multi-language text case-insensitively, with % taken literally', async () => {
                const search = (term: string, mlt: Array<'titleMlt' | 'annotation'> = ['titleMlt', 'annotation']) =>
                    store.listPages({ ...all, tenant, search: { term, columns: ['title', 'slug'], mlt, langs: ['en', 'ua'] } }).then(r => r.rows.map(p => p.slug));
                expect(await search('київ')).toEqual(['kyiv']);
                expect(await search('місто')).toEqual(['kyiv']);
                expect(await search('місто', ['titleMlt'])).toEqual([]);
                expect(await search('50%')).toEqual(['kyiv']);
                expect(await search('5_%')).toEqual([]);
                expect(await search('same-1')).toHaveLength(11);
            });

            it('returns cards without content and a light index', async () => {
                const card = await store.listPages({ ...all, tenant, projection: 'card', ids: [(await store.getPageBySlug('kyiv', tenant))!.id] });
                expect(card.rows[0].data ?? null).toBeNull();
                expect(card.rows[0].titleMlt).toEqual({ en: 'Kyiv', ua: 'Столиця КИЇВ' });
                const index = await store.listPages({ ...all, tenant, projection: 'index', types: ['article'] });
                expect(index.rows[0]).toMatchObject({ slug: 'kyiv', type: 'article', status: 'published' });
                expect(index.rows[0].annotation ?? null).toBeNull();
            });
        });

        describe('taxonomy lookups', () => {
            it('reads authors by slugs and a category by kind', async () => {
                await store.upsertAuthor({ slug: 'ivan', tenant: '', name: { en: 'Ivan' }, photo: null, role: null, enabled: true });
                await store.upsertAuthor({ slug: 'olena', tenant: '', name: { en: 'Olena' }, photo: null, role: null, enabled: false });
                expect((await store.getAuthorsBySlugs(['olena', 'ivan', 'nobody'])).map(a => a.slug).sort()).toEqual(['ivan', 'olena']);
                await store.upsertCategory({ slug: 'news', tenant: '', kind: 'blog', name: { en: 'News' }, sortOrder: 1, enabled: true });
                expect((await store.getCategory('blog', 'news'))?.enabled).toBe(true);
                expect(await store.getCategory('article', 'news')).toBeNull();
            });
        });

        describe('folders', () => {
            it('refuses sibling folders with the same segment, including at the root', async () => {
                const folder = (id: string, parentId: string | null, segment: string) => ({ id, tenant: '', parentId, name: segment, nameMlt: null, segment, sortOrder: 0 });
                await store.saveFolder(folder('r1', null, 'guides'));
                expect(await conflict(store.saveFolder(folder('r2', null, 'guides')))).toBe('folder_sibling');
                await store.saveFolder(folder('c1', 'r1', 'intro'));
                expect(await conflict(store.saveFolder(folder('c2', 'r1', 'intro')))).toBe('folder_sibling');
                await store.saveFolder(folder('c3', 'r1', 'setup'));
                expect((await store.listFolders()).length).toBe(3);
            });
        });

        describe('slug history', () => {
            it('maps former slugs to a page id and forgets them on delete', async () => {
                const p = page('guide-new');
                await store.createPage(p);
                await store.recordFormerSlug('guide-old', p.id);
                await store.recordFormerSlug('guide-older', p.id);
                expect(await store.resolveFormerSlug('guide-old')).toBe(p.id);
                await store.releaseFormerSlug('guide-older');
                expect(await store.resolveFormerSlug('guide-older')).toBeNull();
                await store.deleteSlugHistory(p.id);
                expect(await store.resolveFormerSlug('guide-old')).toBeNull();
            });
        });

        describe('roles', () => {
            it('sets roles by id and refuses a second holder', async () => {
                const a = page('offer-a');
                const b = page('offer-b');
                await store.createPage(a);
                await store.createPage(b);
                await store.setRole(a.id, 'offer');
                expect((await store.findPageByRole('offer'))?.id).toBe(a.id);
                expect(await conflict(store.setRole(b.id, 'offer'))).toBe('page_role');
                await store.setRole(a.id, null);
                await store.setRole(b.id, 'offer');
                expect((await store.listPagesWithRole()).map(p => p.slug)).toEqual(['offer-b']);
            });
        });

        describe('comments', () => {
            let postId: string;

            beforeAll(async () => {
                const post = page('post', { type: 'blog', status: 'published' });
                postId = post.id;
                await store.createPage(post);
            });

            it('rejects ratings and statuses the schema does not allow', async () => {
                for (const rating of [0, 6]) {
                    await expect(store.createComment(comment(postId, { rating }))).rejects.toThrow();
                }
                await expect(store.createComment(comment(postId, { status: 'spam' as never }))).rejects.toThrow();
            });

            it('filters, searches and sorts the queue', async () => {
                await store.createComment(comment(postId, { authorName: 'Олена', content: 'Чудово', rating: 5, status: 'approved' }));
                await store.createComment(comment(postId, { authorName: 'Петро', content: 'Нормально', rating: 3, status: 'approved' }));
                await store.createComment(comment(postId, { authorName: 'Spam 100%', authorEmail: 'bot@spam.io', content: 'buy', status: 'pending' }));
                const list = (q: object) => store.listComments({ page: 1, pageSize: 50, order: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }], ...q });
                expect((await list({ pageId: postId, status: 'approved' })).rows.map(c => c.authorName)).toEqual(['Петро', 'Олена']);
                expect((await list({ rating: 5 })).rows.map(c => c.authorName)).toEqual(['Олена']);
                expect((await list({ search: 'spam.io' })).rows).toHaveLength(1);
                expect((await list({ search: '100%' })).rows).toHaveLength(1);
                expect((await list({ search: 'ЧУДОВО' })).rows).toHaveLength(1);
                const byRating = await store.listComments({ page: 1, pageSize: 50, status: 'approved', order: [{ field: 'rating', direction: 'asc' }, { field: 'id', direction: 'asc' }] });
                expect(byRating.rows.map(c => c.rating)).toEqual([3, 5]);
            });

            it('aggregates approved ratings per page and deletes comments of a page', async () => {
                expect(await store.aggregateApprovedRatings([postId, 'other'])).toEqual([{ pageId: postId, count: 2, sum: 8 }]);
                expect(await store.deleteCommentsByPage(postId)).toBe(3);
                expect((await store.listComments({ pageId: postId, page: 1, pageSize: 10, order: [{ field: 'id', direction: 'desc' }] })).rows).toHaveLength(0);
            });
        });
    });
}
