import { describe, expect, it } from 'vitest';
import { computeReadingTime } from '../src/reading-time.js';
import { clampPage, paginationMeta } from '../src/pagination.js';
import { blocksToPlainText, normalizeBlocks } from '../src/blocks.js';

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

    it('normalizes media blocks and validates the url', () => {
        expect(normalizeBlocks([
            { type: 'image', url: '/assets/preview/cover.jpg', text: 'обкладинка' },
            { type: 'document', url: 'https://example.com/doc.pdf', text: 'Договір' },
            { type: 'image', url: '//evil.host/x.png', text: 'bad' },
            { type: 'document', text: 'no url' },
        ])).toEqual([
            { type: 'image', url: '/assets/preview/cover.jpg', text: 'обкладинка' },
            { type: 'document', url: 'https://example.com/doc.pdf', text: 'Договір' },
            { type: 'image', url: '', text: 'bad' },
            { type: 'document', url: '', text: 'no url' },
        ]);
    });

    it('normalizes form blocks and ignores any text they carry', () => {
        expect(normalizeBlocks([{ type: 'contact-form' }, { type: 'manuscript-form', text: 'ignored' }])).toEqual([
            { type: 'contact-form', text: '' },
            { type: 'manuscript-form', text: 'ignored' },
        ]);
    });
});

describe('blocksToPlainText', () => {
    it('skips blocks with empty text, such as form blocks', () => {
        expect(
            blocksToPlainText([
                { type: 'paragraph', text: 'Привіт' },
                { type: 'contact-form', text: '' },
                { type: 'heading', text: 'Розділ' },
            ]),
        ).toBe('Привіт\n\nРозділ');
    });
});
