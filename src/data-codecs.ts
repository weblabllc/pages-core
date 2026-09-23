import { ContentError } from './addressing.js';
import { blocksToPlainText, normalizeBlocks } from './blocks.js';
import { puckRootMeta } from './domain.js';
import { countWords } from './reading-time.js';
import { SimpleBlock } from './types.js';

export interface DataCodec {
    validate(raw: unknown, langs: readonly string[]): unknown;
    words(data: unknown, primaryLang: string, langs: readonly string[]): number;
    meta?(data: unknown): { title?: string; segment?: string };
    localize?(data: unknown, lang: string, primaryLang: string): unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function findMltError(node: unknown, langs: readonly string[], path = 'data'): string | null {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            const error = findMltError(node[i], langs, `${path}[${i}]`);
            if (error) return error;
        }
        return null;
    }
    const keys = Object.keys(node);
    const langKeys = keys.filter(k => langs.includes(k));
    if (langKeys.length) {
        const strays = keys.filter(k => !langs.includes(k));
        if (strays.length) return `${path}: unexpected keys in a translation object: ${strays.join(', ')}`;
        for (const lang of langKeys) {
            if (typeof (node as Record<string, unknown>)[lang] !== 'string') {
                return `${path}.${lang}: translation must be a string`;
            }
        }
        return null;
    }
    for (const key of keys) {
        const error = findMltError((node as Record<string, unknown>)[key], langs, `${path}.${key}`);
        if (error) return error;
    }
    return null;
}

function checkBlocks(blocks: unknown[], path: string): string | null {
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const at = `${path}[${i}]`;
        if (!isObject(block)) return `${at} must be an object`;
        if (typeof block.type !== 'string' || !block.type) return `${at}.type is missing`;
        if (!isObject(block.props) || typeof block.props.id !== 'string' || !block.props.id) {
            return `${at}.props.id is missing`;
        }
    }
    return null;
}

export function puckDataError(data: unknown, langs: readonly string[]): string | null {
    if (!isObject(data)) return 'data must be an object';
    if (!isObject(data.root)) return 'data.root must be an object';
    if (!Array.isArray(data.content)) return 'data.content must be an array';
    const contentError = checkBlocks(data.content, 'data.content');
    if (contentError) return contentError;
    if (data.zones !== undefined) {
        if (!isObject(data.zones)) return 'data.zones must be an object';
        for (const [zone, blocks] of Object.entries(data.zones)) {
            if (!Array.isArray(blocks)) return `data.zones.${zone} must be an array`;
            const zoneError = checkBlocks(blocks, `data.zones.${zone}`);
            if (zoneError) return zoneError;
        }
    }
    return findMltError(data, langs);
}

const invalidData = (message: string): never => {
    throw new ContentError('invalid_page', message, { field: 'data' });
};

export const PUCK_DATA: DataCodec = {
    validate(raw, langs) {
        const error = puckDataError(raw, langs);
        if (error) invalidData(error);
        return raw;
    },
    words(data, primaryLang, langs) {
        return countWords(isObject(data) ? data.content : null, langs, primaryLang);
    },
    meta(data) {
        const meta = puckRootMeta(isObject(data) ? (data as { root?: { props?: Record<string, unknown> } }) : null);
        return { ...(meta.title !== undefined ? { title: meta.title } : {}), ...(meta.slug !== undefined ? { segment: meta.slug } : {}) };
    },
};

export type LocalizedBlocks = Record<string, { blocks: SimpleBlock[] }>;

export function localizedBlocksData(): DataCodec {
    return {
        validate(raw, langs) {
            if (!isObject(raw)) return invalidData('data must be an object keyed by language');
            const result: LocalizedBlocks = {};
            for (const [lang, value] of Object.entries(raw)) {
                if (!langs.includes(lang)) invalidData(`data.${lang}: unknown language`);
                result[lang] = { blocks: normalizeBlocks(isObject(value) ? value.blocks : []) };
            }
            return result;
        },
        words(data, primaryLang) {
            const blocks = isObject(data) && isObject(data[primaryLang]) ? (data[primaryLang] as { blocks?: unknown }).blocks : [];
            return countWords(blocksToPlainText(normalizeBlocks(blocks)));
        },
        localize(data, lang, primaryLang) {
            if (!isObject(data)) return { blocks: [] };
            return data[lang] ?? data[primaryLang] ?? { blocks: [] };
        },
    };
}
