import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    BLOG_KIND,
    ContentModel,
    createPageStore,
    PAGE_KIND,
    PageAddressing,
    PageComments,
    PageQueries,
    PageRoles,
    PageService,
    PageStore,
    PageStoreOptions,
    PageTaxonomy,
    StoredPage,
} from '../../src/index.js';

const targets: Array<[string, PageStoreOptions | null]> = [
    ['postgres', process.env.PAGES_PG_URL ? { driver: 'postgres', url: process.env.PAGES_PG_URL } : null],
    ['mysql', process.env.PAGES_MYSQL_URL ? { driver: 'mysql', url: process.env.PAGES_MYSQL_URL } : null],
    ['mongodb', process.env.PAGES_MONGO_URL ? { driver: 'mongodb', url: process.env.PAGES_MONGO_URL, database: 'pages_core_test' } : null],
];

const model = new ContentModel({
    kinds: { page: PAGE_KIND, blog: BLOG_KIND },
    folders: true,
    roles: ['offer', 'privacy'],
    langs: ['en', 'uk'],
    defaultAuthor: 'staff',
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const puck = (text: string) => ({ root: { props: {} }, content: [{ type: 'Text', props: { id: 't', text } }] });

const code = async (work: Promise<unknown>) => {
    try {
        await work;
        return 'ok';
    } catch (error) {
        return (error as { code?: string }).code ?? (error as Error).message;
    }
};

function failingOn(store: PageStore, method: keyof PageStore, call: number): PageStore {
    let calls = 0;
    const wrap = (target: PageStore): PageStore =>
        new Proxy(target, {
            get(obj, prop, receiver) {
                const value = Reflect.get(obj, prop, receiver);
                if (typeof value !== 'function') return value;
                if (prop === 'transaction') {
                    return (fn: (tx: PageStore) => Promise<unknown>) => obj.transaction(tx => fn(wrap(tx)));
                }
                if (prop === method) {
                    return (...args: unknown[]) => {
                        calls += 1;
                        if (calls === call) throw new Error('injected failure');
                        return value.apply(obj, args);
                    };
                }
                return value.bind(obj);
            },
        });
    return wrap(store);
}

for (const [name, options] of targets) {
    describe.skipIf(!options)(`${name} services`, () => {
        let store: PageStore;
        let pages: PageService;
        let queries: PageQueries;
        let addressing: PageAddressing;
        let roles: PageRoles;
        let comments: PageComments;
        let taxonomy: PageTaxonomy;

        beforeAll(async () => {
            const tablePrefix = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_`;
            store = await createPageStore({ ...options!, tablePrefix });
            await store.ensureSchema(model.schemaFeatures());
            pages = new PageService(store, model);
            queries = new PageQueries(store, model);
            addressing = new PageAddressing(store, model);
            roles = new PageRoles(store, model);
            comments = new PageComments(store, model);
            taxonomy = new PageTaxonomy(store, model);
            await taxonomy.createAuthor({ slug: 'staff', name: { en: 'Staff', uk: 'Редакція' } });
            await taxonomy.createAuthor({ slug: 'ivan', name: { en: 'Ivan', uk: 'Іван' } });
            await taxonomy.createAuthor({ slug: 'gone', name: { en: 'Gone' } });
            await taxonomy.updateAuthor('gone', { enabled: false });
            await taxonomy.saveCategory('blog', { slug: 'news', name: { en: 'News' } });
            await taxonomy.saveCategory('blog', { slug: 'old', name: { en: 'Old' }, enabled: false });
        });

        afterAll(async () => {
            await store?.close();
        });

        describe('page lifecycle', () => {
            it('creates a draft owned by the actor and reports the change', async () => {
                const { page, changes } = await pages.create(
                    { type: 'page', segment: 'about', titleMlt: { en: 'About', uk: 'Про нас' }, data: puck('hello world') },
                    { id: 'admin-1' },
                );
                expect(page).toMatchObject({ slug: 'about', status: 'draft', createdBy: 'admin-1', title: 'About', publishedAt: null });
                expect(changes).toEqual([{ id: page!.id, slug: 'about', type: 'page', reason: 'created' }]);
            });

            it('refuses a second page at a taken address and a type change', async () => {
                expect(await code(pages.create({ type: 'page', segment: 'about' }))).toBe('slug_conflict');
                const about = await queries.getBySlug('about');
                expect(await code(pages.update(about!.id, { type: 'blog' }))).toBe('type_immutable');
                expect(await code(pages.update('missing', { titleMlt: { en: 'x' } }))).toBe('not_found');
            });

            it('keeps the first publication date by default', async () => {
                const about = (await queries.getBySlug('about'))!;
                const first = await pages.publish(about.id);
                expect(first.page?.status).toBe('published');
                expect(first.changes).toEqual([{ id: about.id, slug: 'about', type: 'page', reason: 'published' }]);
                const firstDate = first.page!.publishedAt!.getTime();
                await pages.unpublish(about.id);
                const again = await pages.publish(about.id);
                expect(again.page!.publishedAt!.getTime()).toBe(firstDate);
            });

            it('gives each language its own view, falling back to the primary one', async () => {
                const about = (await queries.getBySlug('about'))!;
                expect(queries.localizedView(about, 'uk')).toMatchObject({ languageCode: 'uk', title: 'Про нас' });
                expect(queries.localizedView(about, 'de')).toMatchObject({ languageCode: 'en', title: 'About' });
            });

            it('settles ten parallel creates at one address with a single winner', async () => {
                const results = await Promise.all(Array.from({ length: 10 }, () => code(pages.create({ type: 'page', segment: 'race' }))));
                expect(results.filter(r => r === 'ok')).toHaveLength(1);
                expect(results.filter(r => r === 'slug_conflict')).toHaveLength(9);
            });
        });

        describe('blog rules', () => {
            it('requires an enabled category and an enabled author, and fills the default author', async () => {
                const base = { type: 'blog', segment: 'first-post', titleMlt: { en: 'First' }, data: puck(words(450)) };
                expect(await code(pages.create(base))).toBe('invalid_page');
                expect(await code(pages.create({ ...base, category: 'old' }))).toBe('invalid_page');
                expect(await code(pages.create({ ...base, category: 'missing' }))).toBe('invalid_page');
                expect(await code(pages.create({ ...base, category: 'news', authorSlug: 'gone' }))).toBe('invalid_page');
                expect(await code(pages.create({ ...base, segment: 'authors', category: 'news' }))).toBe('invalid_page');
                const { page } = await pages.create({ ...base, category: 'news' });
                expect(page).toMatchObject({ authorSlug: 'staff', category: 'news', readingTime: 3 });
            });

            it('recomputes reading time on every content save and never lets the author go', async () => {
                const post = (await queries.getBySlug('first-post'))!;
                const { page } = await pages.update(post.id, { data: puck(words(50)) });
                expect(page!.readingTime).toBe(1);
                expect(await code(pages.update(post.id, { authorSlug: null }))).toBe('invalid_page');
            });
        });

        describe('renames and redirects', () => {
            it('redirects a former address only to a published page', async () => {
                const { page } = await pages.create({ type: 'page', segment: 'guide' });
                const renamed = await pages.update(page!.id, { segment: 'guide-v2' });
                expect(renamed.changes).toEqual([{ id: page!.id, slug: 'guide-v2', type: 'page', reason: 'renamed', previousSlug: 'guide' }]);
                expect(await addressing.resolve('guide')).toBeNull();
                await pages.publish(page!.id);
                expect(await addressing.resolve('guide')).toEqual({ redirectTo: 'guide-v2' });
                expect(await queries.publishedPage('guide')).toEqual({ redirectTo: 'guide-v2' });
            });

            it('lets a new page claim a former address', async () => {
                const { page } = await pages.create({ type: 'page', segment: 'guide' });
                await pages.publish(page!.id);
                const resolved = await addressing.resolve('guide');
                expect(resolved && 'page' in resolved ? resolved.page.id : null).toBe(page!.id);
            });
        });

        describe('deletion', () => {
            it('removes history and comments with the page, so a newcomer at the address starts clean', async () => {
                const { page } = await pages.create({ type: 'blog', segment: 'post-a', category: 'news', data: puck('x') });
                await pages.publish(page!.id);
                const comment = await comments.submit('post-a', { authorName: 'A', content: 'Great', rating: 5 });
                await comments.moderate(comment.id, 'approved', 'mod');
                await pages.update(page!.id, { segment: 'post-b' });
                const removed = await pages.delete(page!.id);
                expect(removed.changes).toEqual([{ id: page!.id, slug: 'post-b', type: 'blog', reason: 'deleted' }]);
                expect(await addressing.resolve('post-a')).toBeNull();
                const fresh = await pages.create({ type: 'blog', segment: 'post-b', category: 'news', data: puck('y') });
                await pages.publish(fresh.page!.id);
                expect(await comments.approved('post-b')).toMatchObject({ rows: [], rating: null });
                expect(await code(pages.delete(page!.id))).toBe('not_found');
            });
        });

        describe('roles', () => {
            it('moves a role to its new holder inside one write and reports the released page', async () => {
                const a = (await pages.create({ type: 'page', segment: 'terms', role: 'offer' })).page!;
                const b = (await pages.create({ type: 'page', segment: 'terms-2' })).page!;
                const moved = await pages.update(b.id, { role: 'offer' });
                expect(moved.changes).toContainEqual({ id: a.id, slug: 'terms', type: 'page', reason: 'role_released' });
                expect((await store.findPageByRole('offer'))?.id).toBe(b.id);
                const back = await roles.assign(a.id, 'offer');
                expect(back.released).toBe(b.id);
                expect((await store.getPageById(b.id))?.role ?? null).toBeNull();
                expect(await code(roles.assign(a.id, 'boss'))).toBe('invalid_role');
            });
        });

        describe('folders', () => {
            it('validates folders and moves pages with their addresses', async () => {
                expect(await code(addressing.createFolder({ name: '  ', segment: 'x' }))).toBe('invalid_folder');
                expect(await code(addressing.createFolder({ name: 'X', segment: 'x', sortOrder: 1.5 }))).toBe('invalid_folder');
                const docs = await addressing.createFolder({ name: 'Docs', segment: 'docs' });
                expect(await code(addressing.createFolder({ name: 'Docs again', segment: 'docs' }))).toBe('folder_conflict');
                const intro = (await pages.create({ type: 'page', segment: 'intro', folderId: docs.id })).page!;
                expect(intro.slug).toBe('docs/intro');
                const loose = (await pages.create({ type: 'page', segment: 'intro' })).page!;
                expect(await code(pages.move(loose.id, docs.id))).toBe('slug_conflict');
                expect((await store.getPageById(loose.id))?.slug).toBe('intro');
                const setup = (await pages.create({ type: 'page', segment: 'setup' })).page!;
                const moved = await pages.move(setup.id, docs.id);
                expect(moved.changes).toEqual([{ id: setup.id, slug: 'docs/setup', type: 'page', reason: 'moved', previousSlug: 'setup' }]);
            });

            it('renames a folder and all its pages in one transaction', async () => {
                const docs = (await addressing.tree()).find(f => f.segment === 'docs')!;
                const broken = new PageAddressing(failingOn(store, 'updatePage', 2), model);
                expect(await code(broken.updateFolder(docs.id, { segment: 'manual' }))).toBe('injected failure');
                expect((await addressing.tree()).find(f => f.id === docs.id)?.segment).toBe('docs');
                expect((await queries.getBySlug('docs/intro'))?.slug).toBe('docs/intro');
                expect((await queries.getBySlug('docs/setup'))?.slug).toBe('docs/setup');
                const { changes } = await addressing.updateFolder(docs.id, { segment: 'manual' });
                expect(changes.map(c => [c.previousSlug, c.slug]).sort()).toEqual([
                    ['docs/intro', 'manual/intro'],
                    ['docs/setup', 'manual/setup'],
                ]);
            });
        });

        describe('reading', () => {
            let post: StoredPage;

            beforeAll(async () => {
                post = (await pages.create({ type: 'blog', segment: 'post-c', category: 'news', authorSlug: 'ivan', data: puck('x') })).page!;
                await pages.publish(post.id);
                const c = await comments.submit('post-c', { authorName: 'B', content: 'Nice', rating: 4 });
                await comments.moderate(c.id, 'approved', 'mod');
                await comments.submit('post-c', { authorName: 'Spammer', content: 'buy spam now', rating: null });
            });

            it('serves a published page with its author, rating and folders', async () => {
                const view = await queries.publishedPage('post-c');
                expect(view && 'page' in view ? view.meta : null).toMatchObject({
                    folders: [],
                    author: { slug: 'ivan' },
                    rating: { avg: 4, count: 1 },
                });
                const nested = await queries.publishedPage('manual/intro');
                expect(nested).toBeNull();
                const intro = (await queries.getBySlug('manual/intro'))!;
                await pages.publish(intro.id);
                const shown = await queries.publishedPage('manual/intro');
                expect(shown && 'page' in shown ? shown.meta.folders.map(f => f.segment) : null).toEqual(['manual']);
            });

            it('lists published cards of a kind with authors and ratings, and drafts only for admins', async () => {
                const list = await queries.list('blog', {});
                expect(list.rows.every(r => r.status === 'published')).toBe(true);
                const card = list.rows.find(r => r.slug === 'post-c')!;
                expect(card).toMatchObject({ author: { slug: 'ivan' }, rating: { avg: 4, count: 1 } });
                expect(card.data ?? null).toBeNull();
                const drafts = await queries.adminList({ type: 'blog', status: 'draft' });
                expect(drafts.rows.map(r => r.slug)).toContain('first-post');
                expect((await queries.list('blog', { limit: 1000 })).pagination.page_size).toBe(model.maxPageSize());
            });

            it('builds a light index of everything published', async () => {
                const index = await queries.publishedIndex();
                expect(index.map(p => p.slug)).toEqual(expect.arrayContaining(['about', 'post-c', 'manual/intro']));
                expect(index.every(p => p.status === 'published')).toBe(true);
            });
        });

        describe('comments', () => {
            it('accepts comments only on published pages of kinds that have them', async () => {
                expect(await code(comments.submit('first-post', { authorName: 'A', content: 'x', rating: null }))).toBe('not_found');
                expect(await code(comments.submit('about', { authorName: 'A', content: 'x', rating: null }))).toBe('comments_disabled');
                expect(await code(comments.approved('about'))).toBe('not_found');
                expect(await code(comments.approved('first-post'))).toBe('not_found');
            });

            it('searches the moderation queue and names the page of each comment', async () => {
                const queue = await comments.queue({ search: 'spam', status: 'pending' });
                expect(queue.rows).toHaveLength(1);
                expect(queue.rows[0]).toMatchObject({ authorName: 'Spammer', page: { slug: 'post-c' } });
                const ratings = await comments.ratings([(await queries.getBySlug('post-c'))!.id]);
                expect(Object.values(ratings)).toEqual([{ avg: 4, count: 1 }]);
            });
        });

        describe('taxonomy', () => {
            it('refuses to delete a category or an author still in use', async () => {
                expect(await code(taxonomy.deleteCategory('blog', 'news'))).toBe('category_in_use');
                expect(await code(taxonomy.deleteAuthor('ivan'))).toBe('author_in_use');
                await taxonomy.saveCategory('blog', { slug: 'empty', name: { en: 'Empty' } });
                await taxonomy.deleteCategory('blog', 'empty');
                expect(await store.getCategory('blog', 'empty')).toBeNull();
            });
        });

        describe('portable import', () => {
            it('imports content only and recomputes the address fields and reading time', async () => {
                const post = (await queries.getBySlug('first-post'))!;
                const exported = await pages.exportPortable(post.id);
                const { page } = await pages.importPortable(post.id, { ...exported, status: 'published', role: 'offer', data: puck(words(700)) });
                expect(page).toMatchObject({ status: 'draft', slug: 'first-post', readingTime: 4 });
                expect(page!.role ?? null).toBeNull();
                expect(await code(pages.importPortable(post.id, { ...exported, slug: 'other' }))).toBe('invalid_import');
            });
        });
    });
}
