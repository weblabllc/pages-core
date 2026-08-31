import { isMltObject } from './mlt.js';
import { PuckData } from './types.js';

export interface ReadingTimeOptions {
    wordsPerMinute?: number;
    mltLangs?: readonly string[];
    mltPrimary?: string;
}

export function countWords(node: unknown, mltLangs: readonly string[] = [], mltPrimary = 'en'): number {
    if (node == null) return 0;
    if (typeof node === 'string') {
        const trimmed = node.trim();
        return trimmed ? trimmed.split(/\s+/).length : 0;
    }
    if (Array.isArray(node)) {
        return node.reduce<number>((sum, item) => sum + countWords(item, mltLangs, mltPrimary), 0);
    }
    if (typeof node === 'object') {
        if (mltLangs.length && isMltObject(node, mltLangs)) {
            return countWords((node as Record<string, string>)[mltPrimary], mltLangs, mltPrimary);
        }
        return Object.values(node as Record<string, unknown>).reduce<number>(
            (sum, v) => sum + countWords(v, mltLangs, mltPrimary),
            0,
        );
    }
    return 0;
}

export function computeReadingTime(
    data: PuckData | null | undefined,
    { wordsPerMinute = 200, mltLangs = [], mltPrimary = 'en' }: ReadingTimeOptions = {},
): number {
    const words = countWords(data?.content, mltLangs, mltPrimary);
    return Math.max(1, Math.ceil(words / wordsPerMinute));
}
