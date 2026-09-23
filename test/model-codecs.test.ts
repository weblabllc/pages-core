import { describe, expect, it } from 'vitest';
import {
    ARTICLE_KIND,
    BLOG_KIND,
    ContentError,
    ContentModel,
    DEFAULT_RESERVED_BLOG_SLUGS,
    localizedBlocksData,
    PAGE_KIND,
    PAGE_LIMITS,
    PUCK_DATA,
} from '../src/index.js';

const errorCode = (fn: () => unknown) => {
    try {
        fn();
    } catch (error) {
        return error instanceof ContentError ? error.code : 'other';
    }
    return 'ok';
};

describe('ContentModel settings', () => {
    it('has safe defaults', () => {
        const model = new ContentModel({ kinds: { page: PAGE_KIND } });
        expect(model.langs()).toEqual(['en']);
        expect(model.primaryLang()).toBe('en');
        expect(model.limits()).toEqual(PAGE_LIMITS);
        expect(model.publishPolicy()).toBe('first');
        expect(model.usesSlugHistory()).toBe(false);
        expect(model.maxPageSize()).toBe(100);
        expect(model.defaultAuthor()).toBeNull();
    });

    it('takes languages, primary language, limits and policies', () => {
        const model = new ContentModel({
            kinds: { page: PAGE_KIND },
            langs: ['uk', 'en'],
            limits: { annotation: 5000 },
            publishedAt: 'latest',
            slugHistory: true,
            maxPageSize: 50,
            defaultAuthor: 'team',
        });
        expect(model.primaryLang()).toBe('uk');
        expect(model.limits()).toEqual({ ...PAGE_LIMITS, annotation: 5000 });
        expect(model.publishPolicy()).toBe('latest');
        expect(model.usesSlugHistory()).toBe(true);
        expect(model.schemaFeatures().slugHistory).toBe(true);
        expect(model.maxPageSize()).toBe(50);
        expect(model.defaultAuthor()).toBe('team');
    });

    it('follows folders for slug history unless set explicitly', () => {
        expect(new ContentModel({ kinds: { page: PAGE_KIND }, folders: true }).usesSlugHistory()).toBe(true);
        expect(new ContentModel({ kinds: { page: PAGE_KIND }, folders: true, slugHistory: false }).usesSlugHistory()).toBe(false);
    });

    it('rejects bad languages and a primary language outside the list', () => {
        expect(() => new ContentModel({ kinds: { page: PAGE_KIND }, langs: ['UK'] })).toThrow(/language/);
        expect(() => new ContentModel({ kinds: { page: PAGE_KIND }, langs: [] })).toThrow(/language/);
        expect(() => new ContentModel({ kinds: { page: PAGE_KIND }, langs: ['uk'], primaryLang: 'en' })).toThrow(/primary/);
        expect(new ContentModel({ kinds: { page: PAGE_KIND }, langs: ['pt-br', 'uk'] }).langs()).toEqual(['pt-br', 'uk']);
    });

    it('gives kind presets their shp rules and listings', () => {
        const model = new ContentModel({ kinds: { page: PAGE_KIND, article: ARTICLE_KIND, blog: BLOG_KIND } });
        expect(model.kindConfig('blog').categoryRequired).toBe(true);
        expect(model.kindConfig('blog').reservedSlugs).toEqual(DEFAULT_RESERVED_BLOG_SLUGS);
        expect(model.listing('blog')).toEqual({ order: [{ field: 'pinned', direction: 'desc' }, { field: 'publishedAt', direction: 'desc' }], pageSize: 9 });
        expect(model.kindConfig('article').categoryRequired).toBe(true);
        expect(model.listing('article')).toEqual({ order: [{ field: 'publishedAt', direction: 'desc' }], pageSize: 9 });
        expect(model.kindConfig('page').categoryRequired ?? false).toBe(false);
        expect(model.listing('page')).toEqual({ order: [{ field: 'updatedAt', direction: 'desc' }], pageSize: 25 });
        expect(model.dataCodec('page')).toBe(PUCK_DATA);
    });
});

describe('PUCK_DATA codec', () => {
    const langs = ['en', 'ua'];
    const valid = { root: { props: { title: 'Hi', slug: 'hi' } }, content: [{ type: 'Text', props: { id: 't1', text: { en: 'one two', ua: 'раз два три' } } }] };

    it('accepts valid Puck data and counts primary-language words', () => {
        expect(PUCK_DATA.validate(valid, langs)).toEqual(valid);
        expect(PUCK_DATA.words(valid, 'ua', langs)).toBe(3);
        expect(PUCK_DATA.meta!(valid)).toEqual({ title: 'Hi', segment: 'hi' });
    });

    it('rejects broken structure and translations as invalid_page', () => {
        expect(errorCode(() => PUCK_DATA.validate({ content: [] }, langs))).toBe('invalid_page');
        expect(errorCode(() => PUCK_DATA.validate({ root: {}, content: [{ type: 'X', props: {} }] }, langs))).toBe('invalid_page');
        expect(errorCode(() => PUCK_DATA.validate({ root: { props: { t: { en: 'a', xx: 'b' } } }, content: [] }, langs))).toBe('invalid_page');
    });
});

describe('localizedBlocksData codec', () => {
    const codec = localizedBlocksData();
    const langs = ['uk', 'en'];

    it('normalizes blocks per language and counts primary-language words', () => {
        const value = codec.validate({ uk: { blocks: [{ type: 'paragraph', text: 'один два три' }, { type: 'bogus', text: 'чотири' }] } }, langs);
        expect(value).toEqual({ uk: { blocks: [{ type: 'paragraph', text: 'один два три' }, { type: 'paragraph', text: 'чотири' }] } });
        expect(codec.words(value, 'uk', langs)).toBe(4);
        expect(codec.words(value, 'en', langs)).toBe(0);
    });

    it('rejects unknown languages and non-objects', () => {
        expect(errorCode(() => codec.validate({ de: { blocks: [] } }, langs))).toBe('invalid_page');
        expect(errorCode(() => codec.validate([], langs))).toBe('invalid_page');
        expect(codec.validate({}, langs)).toEqual({});
    });
});
