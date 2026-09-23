import { describe, expect, it } from 'vitest';
import {
    applyPublish,
    applyUnpublish,
    ARTICLE_KIND,
    BLOG_KIND,
    ContentError,
    ContentModel,
    contentSitemapEntries,
    localizedBlocksData,
    PAGE_KIND,
    parseCommentListParams,
    parseListParams,
    StoredPage,
    validatePageInput,
    validatePortablePage,
} from '../src/index.js';

const model = new ContentModel({
    langs: ['en', 'ua'],
    kinds: { page: PAGE_KIND, article: ARTICLE_KIND, blog: BLOG_KIND, notes: { ...PAGE_KIND, data: localizedBlocksData() } },
});

const current = (extra: Partial<StoredPage> = {}): StoredPage => ({
    id: 'p1', slug: 'hello', tenant: '', type: 'blog', status: 'draft', title: 'Hello', titleMlt: { en: 'Hello' }, annotation: null,
    data: { root: { props: {} }, content: [] }, category: 'news', pinned: false, authorSlug: 'ivan', coverImage: null, readingTime: 1,
    publishedAt: null, ...extra,
} as StoredPage);

const fail = (fn: () => unknown) => {
    try {
        fn();
    } catch (error) {
        if (error instanceof ContentError) return `${error.code}:${String(error.details.field ?? '')}`;
        throw error;
    }
    return 'ok';
};

describe('validatePageInput', () => {
    it('requires a registered type on create and forbids changing it later', () => {
        expect(fail(() => validatePageInput({ segment: 'a' }, { model, mode: 'create' }))).toBe('invalid_page:type');
        expect(fail(() => validatePageInput({ type: 'poem', segment: 'a' }, { model, mode: 'create' }))).toBe('invalid_page:type');
        expect(fail(() => validatePageInput({ type: 'page' }, { model, mode: 'update', current: current() }))).toBe('type_immutable:type');
        expect(fail(() => validatePageInput({ type: 'blog', title: 'x' }, { model, mode: 'update', current: current() }))).toBe('ok');
    });

    it('checks the segment format and reserved blog slugs', () => {
        expect(fail(() => validatePageInput({ type: 'page', segment: 'a/b' }, { model, mode: 'create' }))).toBe('invalid_page:segment');
        expect(fail(() => validatePageInput({ type: 'blog', segment: 'category' }, { model, mode: 'create' }))).toBe('invalid_page:segment');
        expect(fail(() => validatePageInput({ type: 'page', segment: 'category' }, { model, mode: 'create' }))).toBe('ok');
    });

    it('accepts only real booleans for pinned and safe cover images', () => {
        expect(fail(() => validatePageInput({ pinned: 'true' }, { model, mode: 'update', current: current() }))).toBe('invalid_page:pinned');
        expect(fail(() => validatePageInput({ coverImage: '//evil/x.png' }, { model, mode: 'update', current: current() }))).toBe('invalid_page:coverImage');
        expect(validatePageInput({ coverImage: null, pinned: true }, { model, mode: 'update', current: current() })).toMatchObject({ coverImage: null, pinned: true });
    });

    it('enforces multi-language limits and languages', () => {
        expect(fail(() => validatePageInput({ titleMlt: { en: 'x'.repeat(301) } }, { model, mode: 'update', current: current() }))).toBe('invalid_page:titleMlt');
        expect(fail(() => validatePageInput({ annotation: { en: 'x'.repeat(1001) } }, { model, mode: 'update', current: current() }))).toBe('invalid_page:annotation');
        expect(fail(() => validatePageInput({ seoDescription: { de: 'x' } }, { model, mode: 'update', current: current() }))).toBe('invalid_page:seoDescription');
        const draft = validatePageInput({ titleMlt: { en: ' Hi\u0000 ', ua: 'Привіт' } }, { model, mode: 'update', current: current() });
        expect(draft.titleMlt).toEqual({ en: 'Hi', ua: 'Привіт' });
        expect(draft.title).toBe('Hi');
    });

    it('does not let an author be removed from a blog post', () => {
        expect(fail(() => validatePageInput({ authorSlug: null }, { model, mode: 'update', current: current() }))).toBe('invalid_page:authorSlug');
    });

    it('drops taxonomy fields a kind does not use', () => {
        const draft = validatePageInput({ type: 'page', segment: 'about', category: 'news', pinned: true, authorSlug: 'ivan' }, { model, mode: 'create' });
        expect(draft).toMatchObject({ category: null, pinned: false, authorSlug: null });
    });

    it('validates data with the kind codec and takes the title from it when missing', () => {
        expect(fail(() => validatePageInput({ data: { content: [] } }, { model, mode: 'update', current: current() }))).toBe('invalid_page:data');
        const puck = validatePageInput({ type: 'page', segment: 'x', data: { root: { props: { title: 'From root' } }, content: [] } }, { model, mode: 'create' });
        expect(puck.title).toBe('From root');
        const notes = validatePageInput({ type: 'notes', segment: 'n', data: { ua: { blocks: [{ type: 'paragraph', text: 'Текст' }] } } }, { model, mode: 'create' });
        expect(notes.data).toEqual({ ua: { blocks: [{ type: 'paragraph', text: 'Текст' }] } });
    });

    it('keeps only content fields on import', () => {
        const draft = validatePageInput(
            { status: 'published', publishedAt: '2020-01-01', type: 'blog', folderId: 'f', readingTime: 99, role: 'offer', createdBy: 'x', pinned: true, titleMlt: { en: 'T' } },
            { model, mode: 'import', current: current() },
        );
        expect(Object.keys(draft).sort()).toEqual(['title', 'titleMlt']);
    });
});

describe('validatePortablePage', () => {
    it('returns content fields only', () => {
        const value = validatePortablePage(
            { slug: 'hello', type: 'blog', status: 'published', publishedAt: 'x', folderId: 'f', readingTime: 9, role: 'offer', createdBy: 'me', pinned: true, data: { root: {}, content: [] }, titleMlt: { en: 'T' } },
            { slug: 'hello', type: 'blog', langs: ['en'] },
        );
        expect(Object.keys(value).sort()).toEqual(['data', 'titleMlt']);
    });
});

describe('parseListParams', () => {
    const blog = model.listing('blog');

    it('uses the kind listing and always adds an id tiebreaker', () => {
        expect(parseListParams({}, blog, model)).toMatchObject({
            page: 1,
            pageSize: 9,
            order: [{ field: 'pinned', direction: 'desc' }, { field: 'publishedAt', direction: 'desc' }, { field: 'id', direction: 'desc' }],
        });
    });

    it('replaces the default order on explicit sort, dropping pinned priority', () => {
        expect(parseListParams({ sortBy: 'title', sortOrder: 'asc' }, blog, model).order).toEqual([
            { field: 'title', direction: 'asc' },
            { field: 'id', direction: 'asc' },
        ]);
        expect(parseListParams({ sortBy: 'nonsense' }, blog, model).order[0]).toEqual({ field: 'pinned', direction: 'desc' });
    });

    it('clamps paging and parses filters tolerantly', () => {
        const parsed = parseListParams({ page: '3', limit: '500', folderId: 'root', hasCategory: 'true', pinned: 'false', status: 'published', search: '  Київ ', category: 'news', author: 'ivan' }, blog, model);
        expect(parsed).toMatchObject({ page: 3, pageSize: 100 });
        expect(parsed.filter).toEqual({ folderId: null, hasCategory: true, pinned: false, status: 'published', search: 'Київ', category: 'news', authorSlug: 'ivan' });
        expect(parseListParams({ page: '-2', limit: 'x', status: 'deleted' }, blog, model)).toMatchObject({ page: 1, pageSize: 9, filter: {} });
    });
});

describe('parseCommentListParams', () => {
    it('supports shp sort fields, filters and defaults', () => {
        expect(parseCommentListParams({}, model)).toMatchObject({ page: 1, pageSize: 25, order: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }], filter: {} });
        expect(parseCommentListParams({ sortBy: 'rating', sortOrder: 'asc', status: 'pending', rating: '5', pageId: 'p1', search: ' spam ' }, model)).toMatchObject({
            order: [{ field: 'rating', direction: 'asc' }, { field: 'id', direction: 'asc' }],
            filter: { status: 'pending', rating: 5, pageId: 'p1', search: 'spam' },
        });
        expect(parseCommentListParams({ rating: '7', status: 'weird' }, model).filter).toEqual({});
    });
});

describe('publish policy', () => {
    it('keeps the first date by default and bumps and clears on latest', () => {
        const first = new Date('2026-01-01');
        const later = new Date('2026-06-01');
        expect(applyPublish({ status: 'draft', publishedAt: first }, later).publishedAt).toBe(first);
        expect(applyUnpublish({ status: 'published', publishedAt: first }).publishedAt).toBe(first);
        expect(applyPublish({ status: 'draft', publishedAt: first }, later, 'latest').publishedAt).toBe(later);
        expect(applyUnpublish({ status: 'published', publishedAt: first }, 'latest').publishedAt).toBeNull();
    });
});

describe('sitemap sections', () => {
    it('follows the requested section order', () => {
        const pages = [{ slug: 'one', category: 'news', authorSlug: 'ivan', updatedAt: '2026-09-01T00:00:00Z' }];
        const paths = contentSitemapEntries(pages, { basePath: '/blog', categories: ['news'], includeAuthors: true, sections: ['root', 'pages', 'categories', 'authors'] }).map(e => e.path);
        expect(paths).toEqual(['/blog', '/blog/one', '/blog/category/news', '/blog/author/ivan']);
    });
});
