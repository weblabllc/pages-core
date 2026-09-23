import { describe, expect, it } from 'vitest';
import { roleLinks, StoredPage } from '../src/index.js';

const page = (slug: string, role: string | null, status: 'draft' | 'published' = 'published', extra: Partial<StoredPage> = {}): StoredPage => ({
    slug, tenant: '', type: 'page', status, title: slug, titleMlt: null, annotation: null, data: {}, category: null,
    pinned: false, authorSlug: null, coverImage: null, readingTime: null, publishedAt: null, role, ...extra,
});

describe('roleLinks', () => {
    it('maps published pages with a role to links', () => {
        const links = roleLinks([page('publichna-oferta', 'offer'), page('about', null), page('privacy-draft', 'privacy', 'draft')], { basePath: '/info/' });
        expect(links).toEqual({ offer: { role: 'offer', slug: 'publichna-oferta', title: 'publichna-oferta', path: '/info/publichna-oferta' } });
    });

    it('can include drafts for admin previews', () => {
        expect(Object.keys(roleLinks([page('p', 'privacy', 'draft')], { publishedOnly: false }))).toEqual(['privacy']);
    });

    it('uses the localized title when asked', () => {
        const links = roleLinks([page('oferta', 'offer', 'published', { title: 'Оферта', titleMlt: { en: 'Public offer', ua: 'Оферта' } })], { lang: 'en' });
        expect(links.offer.title).toBe('Public offer');
        expect(links.offer.path).toBe('/oferta');
    });
});
