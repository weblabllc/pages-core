import { describe, expect, it } from 'vitest';
import { cleanCommentText, ContentError, ratingSummary, uuidv7, validateCommentInput } from '../src/index.js';

const code = (fn: () => unknown) => {
    try {
        fn();
    } catch (error) {
        return error instanceof ContentError ? `${error.code}:${String(error.details.field)}` : 'other';
    }
    return 'ok';
};

describe('validateCommentInput', () => {
    it('cleans and accepts a valid comment', () => {
        expect(validateCommentInput({ authorName: '  Іван\u0000 ', content: 'Чудова книжка\u0007', authorEmail: 'i@x.ua', rating: 5 })).toEqual({
            authorName: 'Іван',
            authorEmail: 'i@x.ua',
            content: 'Чудова книжка',
            rating: 5,
        });
        expect(validateCommentInput({ authorName: 'A', content: 'B', authorEmail: '' })).toEqual({ authorName: 'A', authorEmail: null, content: 'B', rating: null });
    });

    it('refuses each invalid field with its name', () => {
        expect(code(() => validateCommentInput(null))).toBe('invalid_comment:body');
        expect(code(() => validateCommentInput({ authorName: ' ', content: 'x' }))).toBe('invalid_comment:authorName');
        expect(code(() => validateCommentInput({ authorName: 'x'.repeat(121), content: 'x' }))).toBe('invalid_comment:authorName');
        expect(code(() => validateCommentInput({ authorName: 'A', content: '' }))).toBe('invalid_comment:content');
        expect(code(() => validateCommentInput({ authorName: 'A', content: 'x'.repeat(4001) }))).toBe('invalid_comment:content');
        expect(code(() => validateCommentInput({ authorName: 'A', content: 'x', authorEmail: 'not-an-email' }))).toBe('invalid_comment:authorEmail');
        expect(code(() => validateCommentInput({ authorName: 'A', content: 'x', authorEmail: `${'a'.repeat(251)}@x.ua` }))).toBe('invalid_comment:authorEmail');
        for (const rating of [0, 6, 4.5, '5']) {
            expect(code(() => validateCommentInput({ authorName: 'A', content: 'x', rating }))).toBe('invalid_comment:rating');
        }
    });

    it('keeps tabs and new lines', () => {
        expect(cleanCommentText('a\tb\nc\r\nd\u007f')).toBe('a\tb\nc\r\nd');
    });
});

describe('ratingSummary', () => {
    it('averages to one decimal and ignores missing ratings', () => {
        expect(ratingSummary([5, 4, null, 4])).toEqual({ avg: 4.3, count: 3 });
        expect(ratingSummary([null])).toBeNull();
    });
});

describe('uuidv7', () => {
    it('is a v7 uuid ordered by time', () => {
        const a = uuidv7(1_700_000_000_000);
        const b = uuidv7(1_700_000_000_001);
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(a < b).toBe(true);
    });
});
