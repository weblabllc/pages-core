export type MultiLangText = Record<string, string>;

export interface MltOptions {
    langs: readonly string[];
    maxLen?: number;
}

export function emptyMlt(langs: readonly string[]): MultiLangText {
    return Object.fromEntries(langs.map(l => [l, '']));
}

export function isMltObject(value: unknown, langs: readonly string[]): value is MultiLangText {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every(k => langs.includes(k));
}

export function resolveMlt(
    mlt: MultiLangText | string | null | undefined,
    lang: string,
    fallbackLang = 'en',
): string {
    if (!mlt) return '';
    if (typeof mlt === 'string') return mlt;
    return mlt[lang] || mlt[fallbackLang] || Object.values(mlt).find(v => v) || '';
}

export function sanitizeMlt(
    raw: unknown,
    { langs, maxLen = 512 }: MltOptions,
): { value: MultiLangText | null } | { error: string } {
    if (raw === null || raw === undefined) return { value: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Invalid MLT object' };
    const cleaned: MultiLangText = {};
    for (const [lang, text] of Object.entries(raw as Record<string, unknown>)) {
        if (!langs.includes(lang)) return { error: `Unknown MLT language key: ${lang}` };
        if (typeof text !== 'string') return { error: `MLT value for "${lang}" must be a string` };
        const value = text.split('\u0000').join('').trim();
        if (value.length > maxLen) return { error: `MLT value for "${lang}" exceeds ${maxLen} chars` };
        cleaned[lang] = value;
    }
    return { value: cleaned };
}

export function mltMatches(mlt: MultiLangText | null | undefined, term: string): boolean {
    if (!mlt) return false;
    const needle = term.toLowerCase();
    return Object.values(mlt).some(v => v.toLowerCase().includes(needle));
}
