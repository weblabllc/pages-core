import { describe, expect, it } from 'vitest';
import { canDeleteAuthor, validateAuthorCreate, validateAuthorPatch } from '../src/authors.js';

const opts = { mltLangs: ['en', 'ua'] };

describe('validateAuthorCreate', () => {
    it('accepts mlt name and relative photo', () => {
        const result = validateAuthorCreate(
            { slug: 'ivan', name: { en: 'Ivan', ua: 'Іван' }, photo: '/img/i.png', role: 'Editor' },
            opts,
        );
        expect(result).toHaveProperty('value');
    });
    it('rejects protocol-relative photo urls', () => {
        expect(validateAuthorCreate({ slug: 'ivan', name: 'Ivan', photo: '//evil.host/x.png' }, opts)).toEqual({ error: 'Invalid photo' });
    });
    it('rejects bad slugs and empty names', () => {
        expect(validateAuthorCreate({ slug: 'Іван!', name: 'Ivan' }, opts)).toEqual({ error: 'Invalid slug' });
        expect(validateAuthorCreate({ slug: 'ivan', name: '  ' }, opts)).toHaveProperty('error');
    });
});

describe('validateAuthorPatch', () => {
    it('validates only present fields', () => {
        expect(validateAuthorPatch({}, opts)).toEqual({ value: {} });
        expect(validateAuthorPatch({ enabled: 'yes' as never }, opts)).toHaveProperty('error');
        const patch = validateAuthorPatch({ role: null, photo: null }, opts);
        expect(patch).toEqual({ value: { role: null, photo: null } });
    });
});

describe('canDeleteAuthor', () => {
    it('blocks deletion while articles reference the author', () => {
        expect(canDeleteAuthor(2)).toEqual({ ok: false, reason: expect.stringMatching(/articles/) });
        expect(canDeleteAuthor(0)).toEqual({ ok: true });
    });
});
