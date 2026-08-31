import { describe, expect, it } from 'vitest';
import { mltMatches, resolveMlt, sanitizeMlt } from '../src/mlt.js';

const LANGS = ['en', 'ua'];

describe('sanitizeMlt', () => {
    it('accepts allowlisted languages and trims', () => {
        const result = sanitizeMlt({ en: '  Hello ', ua: 'Привіт' }, { langs: LANGS });
        expect(result).toEqual({ value: { en: 'Hello', ua: 'Привіт' } });
    });
    it('rejects unknown language keys', () => {
        expect(sanitizeMlt({ de: 'Hallo' }, { langs: LANGS })).toHaveProperty('error');
    });
    it('rejects non-string values and oversize', () => {
        expect(sanitizeMlt({ en: 5 }, { langs: LANGS })).toHaveProperty('error');
        expect(sanitizeMlt({ en: 'x'.repeat(10) }, { langs: LANGS, maxLen: 5 })).toHaveProperty('error');
    });
});

describe('resolveMlt', () => {
    it('falls back lang → en → first non-empty', () => {
        expect(resolveMlt({ en: 'Hi', ua: 'Привіт' }, 'ua')).toBe('Привіт');
        expect(resolveMlt({ en: 'Hi', ua: '' }, 'ua')).toBe('Hi');
        expect(resolveMlt({ en: '', ua: 'Привіт' }, 'de')).toBe('Привіт');
        expect(resolveMlt('plain', 'ua')).toBe('plain');
    });
});

describe('mltMatches', () => {
    it('searches values case-insensitively', () => {
        expect(mltMatches({ en: 'Reading Rooms', ua: 'Читальні' }, 'читал')).toBe(true);
        expect(mltMatches({ en: 'x' }, 'y')).toBe(false);
    });
});
