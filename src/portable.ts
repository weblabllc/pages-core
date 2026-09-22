import { ContentError } from './addressing.js';
import { MultiLangText } from './mlt.js';
import { StoredPage } from './store.js';
import { PageType, PuckData } from './types.js';

export interface PortablePage {
    slug: string;
    type: PageType;
    title: string | null;
    data: PuckData;
    titleMlt: MultiLangText | null;
    annotation: MultiLangText | null;
    category: string | null;
    authorSlug: string | null;
    readingTime: number | null;
    coverImage: string | null;
}

export function exportPortablePage(page: StoredPage): PortablePage {
    return {
        slug: page.slug,
        type: page.type,
        title: page.title,
        data: page.data as PuckData,
        titleMlt: page.titleMlt,
        annotation: page.annotation,
        category: page.category,
        authorSlug: page.authorSlug,
        readingTime: page.readingTime,
        coverImage: page.coverImage,
    };
}

export interface ImportExpectation {
    slug: string;
    type: PageType;
    langs: readonly string[];
}

export type PortableImport = Omit<Partial<PortablePage>, 'data'> & { data: PuckData };

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

export function validatePortablePage(body: unknown, expected: ImportExpectation): PortableImport {
    const fail = (message: string): never => {
        throw new ContentError('invalid_import', message);
    };
    if (!isObject(body)) fail('Body must be a JSON object');
    const input = body as Record<string, unknown>;
    if (input.slug !== undefined && input.slug !== expected.slug) {
        fail(`slug mismatch: body has "${String(input.slug)}", expected "${expected.slug}"`);
    }
    if (input.type !== undefined && input.type !== expected.type) fail('type is immutable');

    const data = input.data;
    if (!isObject(data)) fail('data must be an object');
    const puck = data as Record<string, unknown>;
    if (!isObject(puck.root)) fail('data.root must be an object');
    if (!Array.isArray(puck.content)) fail('data.content must be an array');
    const contentError = checkBlocks(puck.content as unknown[], 'data.content');
    if (contentError) fail(contentError);
    if (puck.zones !== undefined) {
        if (!isObject(puck.zones)) fail('data.zones must be an object');
        for (const [zone, blocks] of Object.entries(puck.zones as Record<string, unknown>)) {
            if (!Array.isArray(blocks)) fail(`data.zones.${zone} must be an array`);
            const zoneError = checkBlocks(blocks as unknown[], `data.zones.${zone}`);
            if (zoneError) fail(zoneError);
        }
    }
    const mltError = findMltError(data, expected.langs);
    if (mltError) fail(mltError);
    for (const field of ['titleMlt', 'annotation'] as const) {
        const value = input[field];
        if (value === undefined || value === null) continue;
        if (!isObject(value)) fail(`${field} must be an object`);
        const error = findMltError(value, expected.langs, field);
        if (error) fail(error);
    }

    const { slug: _slug, type: _type, ...rest } = input;
    return { ...(rest as Omit<PortableImport, 'data'>), data: data as unknown as PuckData };
}
