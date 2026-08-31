import { describe, expect, it } from 'vitest';
import { articlesOnlyModel, blogOnlyModel, ContentModel, fullBlogModel, PAGE_KIND } from '../src/content-model.js';

describe('ContentModel', () => {
    it('gates kinds to the configured set', () => {
        const model = articlesOnlyModel();
        expect(model.hasKind('article')).toBe(true);
        expect(() => model.assertKind('blog')).toThrow(/not enabled/);
    });

    it('derives schema features from enabled kinds', () => {
        expect(articlesOnlyModel().schemaFeatures()).toEqual({ pages: true, authors: false, categories: true });
        expect(blogOnlyModel().schemaFeatures()).toEqual({ pages: true, authors: true, categories: true });
        expect(new ContentModel({ kinds: { page: PAGE_KIND } }).schemaFeatures()).toEqual({ pages: true, authors: false, categories: false });
    });

    it('keeps article and blog categories in separate namespaces', () => {
        const model = fullBlogModel();
        expect(model.categoryKind('article')).toBe('article');
        expect(model.categoryKind('blog')).toBe('blog');
    });

    it('strips taxonomy fields for kinds without taxonomy', () => {
        const model = fullBlogModel();
        const stripped = model.taxonomyFieldsFor('page', { category: 'x', pinned: true, authorSlug: 'a' });
        expect(stripped).toEqual({ category: null, pinned: false, authorSlug: null, coverImage: null });
        const article = model.taxonomyFieldsFor('article', { category: 'news', authorSlug: 'a' });
        expect(article.category).toBe('news');
        expect(article.authorSlug).toBeNull();
    });
});
