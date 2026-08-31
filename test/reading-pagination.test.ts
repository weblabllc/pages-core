import { describe, expect, it } from 'vitest';
import { computeReadingTime } from '../src/reading-time.js';
import { clampPage, paginationMeta } from '../src/pagination.js';
import { normalizeBlocks } from '../src/blocks.js';

describe('computeReadingTime', () => {
    it('counts words at 200 wpm with minimum 1', () => {
        expect(computeReadingTime({ content: [], root: {} })).toBe(1);
        const text = 'слово '.repeat(450);
        expect(computeReadingTime({ content: [{ props: { text } }], root: {} })).toBe(3);
    });
    it('counts only the primary language of mlt objects', () => {
        const data = { content: [{ props: { title: { en: 'one two', ua: 'багато зайвих слів тут є' } } }], root: {} };
        expect(computeReadingTime(data, { mltLangs: ['en', 'ua'], wordsPerMinute: 2 })).toBe(1);
    });
});

describe('pagination', () => {
    it('computes shp-compatible meta', () => {
        expect(paginationMeta(53, 2, 25)).toEqual({
            total_count: 53, total_pages: 3, current_page: 2, page_size: 25,
            has_next_page: true, has_prev_page: true,
        });
        expect(clampPage('nope')).toBe(1);
        expect(clampPage(4)).toBe(4);
    });
});

describe('normalizeBlocks', () => {
    it('coerces legacy and unknown types to paragraph', () => {
        expect(normalizeBlocks([{ type: 'text', text: 'hi' }, { type: 'quote', text: 'q' }, null])).toEqual([
            { type: 'paragraph', text: 'hi' },
            { type: 'quote', text: 'q' },
        ]);
        expect(normalizeBlocks('garbage')).toEqual([]);
    });
});
