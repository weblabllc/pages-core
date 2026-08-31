import { describe, expect, it } from 'vitest';
import { applyPublish, applyUnpublish, assertTypeImmutable, isValidSlug, slugify } from '../src/domain.js';

describe('slugify', () => {
    it('transliterates ukrainian', () => {
        expect(slugify('Як ми обираємо книжки')).toBe('iak-my-obyraiemo-knyzhky');
        expect(slugify("П'ять історій про щось")).toBe('piat-istorii-pro-shchos');
    });
    it('produces valid slugs', () => {
        expect(isValidSlug(slugify('Hello, World!'))).toBe(true);
        expect(isValidSlug('Кривий')).toBe(false);
        expect(isValidSlug('ok-slug-9')).toBe(true);
    });
});

describe('publish lifecycle', () => {
    it('keeps first publishedAt across republish', () => {
        const page = applyPublish({ status: 'draft' as const, publishedAt: null });
        const first = page.publishedAt;
        applyUnpublish(page);
        expect(page.status).toBe('draft');
        expect(page.publishedAt).toBe(first);
        applyPublish(page);
        expect(page.publishedAt).toBe(first);
    });
});

describe('type immutability', () => {
    it('rejects kind change after creation', () => {
        expect(() => assertTypeImmutable('blog', 'page')).toThrow(/immutable/);
        expect(() => assertTypeImmutable('blog', 'blog')).not.toThrow();
        expect(() => assertTypeImmutable('blog', undefined)).not.toThrow();
    });
});
