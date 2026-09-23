import { ContentError } from './addressing.js';
import { findMltError, puckDataError } from './data-codecs.js';
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
    seoTitle: MultiLangText | null;
    seoDescription: MultiLangText | null;
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
        seoTitle: page.seoTitle ?? null,
        seoDescription: page.seoDescription ?? null,
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
    const dataError = puckDataError(data, expected.langs);
    if (dataError) fail(dataError);
    for (const field of ['titleMlt', 'annotation', 'seoTitle', 'seoDescription'] as const) {
        const value = input[field];
        if (value === undefined || value === null) continue;
        if (!isObject(value)) fail(`${field} must be an object`);
        const error = findMltError(value, expected.langs, field);
        if (error) fail(error);
    }

    const { slug: _slug, type: _type, ...rest } = input;
    return { ...(rest as Omit<PortableImport, 'data'>), data: data as unknown as PuckData };
}
