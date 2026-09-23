import { describe, expect, it } from 'vitest';
import { contentSitemapEntries, ContentError, exportPortablePage, findMltError, renderSitemapXml, validatePortablePage } from '../src/index.js';

const langs = ['en', 'ua'];
const good = {
    slug: 'about',
    type: 'page',
    data: {
        root: { props: { title: { en: 'About', ua: 'Про нас' } } },
        content: [{ type: 'Hero', props: { id: 'h1', text: { en: 'Hi', ua: 'Привіт' } } }],
        zones: { 'h1:side': [{ type: 'Text', props: { id: 't1', text: 'plain' } }] },
    },
    titleMlt: { en: 'About' },
};

describe('validatePortablePage', () => {
    it('accepts a well-formed export and drops slug and type', () => {
        const value = validatePortablePage(good, { slug: 'about', type: 'page', langs });
        expect(value).not.toHaveProperty('slug');
        expect(value.data.content).toHaveLength(1);
    });

    const cases: Array<[string, unknown, RegExp]> = [
        ['non-object body', [], /JSON object/],
        ['slug mismatch', { ...good, slug: 'other' }, /slug mismatch/],
        ['type change', { ...good, type: 'blog' }, /immutable/],
        ['missing root', { ...good, data: { content: [] } }, /data.root/],
        ['content not array', { ...good, data: { root: {}, content: {} } }, /data.content must be an array/],
        ['block without id', { ...good, data: { root: {}, content: [{ type: 'X', props: {} }] } }, /props.id/],
        ['zone block without type', { ...good, data: { root: {}, content: [], zones: { z: [{ props: { id: 'a' } }] } } }, /zones.z\[0\].type/],
        ['unknown language', { ...good, data: { root: { props: { t: { en: 'a', xx: 'b' } } }, content: [] } }, /unexpected keys/],
        ['non-string translation', { ...good, titleMlt: { en: 5 } }, /must be a string/],
        ['bad seo translation', { ...good, seoDescription: { en: 'x', xx: 'y' } }, /seoDescription: unexpected keys/],
    ];
    for (const [name, body, message] of cases) {
        it(`rejects ${name}`, () => {
            expect(() => validatePortablePage(body, { slug: 'about', type: 'page', langs })).toThrowError(message);
            try { validatePortablePage(body, { slug: 'about', type: 'page', langs }); } catch (e) {
                expect(e).toBeInstanceOf(ContentError);
                expect((e as ContentError).status).toBe(400);
            }
        });
    }

    it('round-trips an exported page', () => {
        const exported = exportPortablePage({
            slug: 'about', tenant: '', type: 'page', status: 'published', title: 'About', titleMlt: null, annotation: null,
            data: good.data, category: null, pinned: false, authorSlug: null, coverImage: null, readingTime: 1, publishedAt: new Date(), seoTitle: { en: 'About — Shop' },
        });
        const imported = validatePortablePage(JSON.parse(JSON.stringify(exported)), { slug: 'about', type: 'page', langs });
        expect(imported.title).toBe('About');
        expect(imported.seoTitle).toEqual({ en: 'About — Shop' });
    });

    it('reports the path of a bad translation', () => {
        expect(findMltError({ a: [{ b: { en: 'x', zz: 'y' } }] }, langs)).toBe('data.a[0].b: unexpected keys in a translation object: zz');
    });
});

describe('sitemap', () => {
    const pages = [
        { slug: 'one', category: 'news', authorSlug: 'ivan', updatedAt: '2026-09-01T00:00:00Z' },
        { slug: 'two', category: 'news', authorSlug: null, updatedAt: '2026-09-10T00:00:00Z' },
        { slug: 'deep/three', category: 'tips', authorSlug: 'ivan', updatedAt: null },
    ];

    it('builds listing, category, page and author entries with latest lastmod', () => {
        const entries = contentSitemapEntries(pages, { basePath: '/blog/', categories: ['news', 'tips', 'empty'], includeAuthors: true });
        expect(entries[0]).toEqual({ path: '/blog', lastmod: '2026-09-10T00:00:00.000Z' });
        expect(entries.find(e => e.path === '/blog/category/news')?.lastmod).toBe('2026-09-10T00:00:00.000Z');
        expect(entries.find(e => e.path === '/blog/category/empty')?.lastmod).toBeNull();
        expect(entries.find(e => e.path === '/blog/deep/three')?.lastmod).toBeNull();
        expect(entries.find(e => e.path === '/blog/author/ivan')?.lastmod).toBe('2026-09-01T00:00:00.000Z');
    });

    it('renders escaped absolute urls', () => {
        const xml = renderSitemapXml([{ path: '/a&b/Ωmega', lastmod: null }], 'https://ex.com/');
        expect(xml).toContain('<loc>https://ex.com/a&amp;b/%CE%A9mega</loc>');
        expect(xml.startsWith('<?xml')).toBe(true);
    });
});
