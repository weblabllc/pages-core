import { ContentError, isValidPageSegment } from './addressing.js';
import { ContentModel } from './content-model.js';
import { MultiLangText, sanitizeMlt } from './mlt.js';
import { StoredPage } from './store.js';
import { isReservedSlug, isValidImageUrl } from './validation.js';

export type PageInputMode = 'create' | 'update' | 'import';

export interface PageDraft {
    type?: string;
    segment?: string;
    title?: string | null;
    titleMlt?: MultiLangText | null;
    annotation?: MultiLangText | null;
    seoTitle?: MultiLangText | null;
    seoDescription?: MultiLangText | null;
    data?: unknown;
    category?: string | null;
    pinned?: boolean;
    authorSlug?: string | null;
    coverImage?: string | null;
    folderId?: string | null;
    role?: string | null;
}

export interface PageInputContext {
    model: ContentModel;
    mode: PageInputMode;
    current?: StoredPage;
}

const IMPORT_FIELDS = ['data', 'title', 'titleMlt', 'annotation', 'seoTitle', 'seoDescription', 'category', 'authorSlug', 'coverImage'];
const MLT_FIELDS = ['titleMlt', 'annotation', 'seoTitle', 'seoDescription'] as const;
const TAXONOMY_FIELDS = ['category', 'pinned', 'authorSlug', 'coverImage'] as const;

const invalid = (field: string, message: string): never => {
    throw new ContentError('invalid_page', message, { field });
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function pick(raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(raw).filter(([key]) => keys.includes(key)));
}

function validSegment(segment: unknown, mode: 'slug' | 'path'): segment is string {
    if (typeof segment !== 'string') return false;
    return mode === 'path' ? segment.split('/').every(isValidPageSegment) : isValidPageSegment(segment);
}

export function validatePageInput(raw: unknown, { model, mode, current }: PageInputContext): PageDraft {
    if (!isObject(raw)) return invalid('body', 'Page input must be an object');
    if (mode !== 'create' && !current) throw new Error(`validatePageInput: "${mode}" needs the current page`);

    let kind: string;
    if (mode === 'create') {
        if (typeof raw.type !== 'string' || !model.hasKind(raw.type)) {
            return invalid('type', `Unknown content type "${String(raw.type)}" (enabled: ${model.kinds().join(', ')})`);
        }
        kind = raw.type;
    } else {
        kind = current!.type;
        if (raw.type !== undefined && raw.type !== kind) {
            throw new ContentError('type_immutable', 'The type of a page cannot be changed', { field: 'type' });
        }
    }

    const input = mode === 'import' ? pick(raw, IMPORT_FIELDS) : raw;
    const config = model.kindConfig(kind);
    const limits = model.limits();
    const langs = model.langs();
    const draft: PageDraft = mode === 'create' ? { type: kind } : {};

    if (input.data !== undefined) draft.data = model.dataCodec(kind).validate(input.data, langs);
    const meta = draft.data !== undefined ? model.dataCodec(kind).meta?.(draft.data) ?? {} : {};

    const segment = input.segment ?? (mode === 'create' ? meta.segment : undefined);
    if (segment !== undefined && mode !== 'import') {
        if (!validSegment(segment, config.segment ?? 'slug')) invalid('segment', `Invalid page address "${String(segment)}"`);
        if (isReservedSlug(segment as string, config.reservedSlugs ?? [])) invalid('segment', `The address "${String(segment)}" is reserved`);
        draft.segment = segment as string;
    } else if (mode === 'create') {
        invalid('segment', 'A new page needs an address');
    }

    for (const field of MLT_FIELDS) {
        if (input[field] === undefined) continue;
        const result = sanitizeMlt(input[field], { langs, maxLen: limits[field] });
        if ('error' in result) invalid(field, `${field}: ${result.error}`);
        else draft[field] = result.value;
    }

    if (input.title !== undefined) {
        if (input.title !== null && (typeof input.title !== 'string' || input.title.length > limits.title)) {
            invalid('title', `title must be a string up to ${limits.title} characters`);
        }
        draft.title = input.title as string | null;
    } else if (draft.titleMlt) {
        draft.title = draft.titleMlt[model.primaryLang()] || Object.values(draft.titleMlt).find(Boolean) || null;
    } else if (meta.title !== undefined) {
        draft.title = meta.title;
    }

    if (input.pinned !== undefined && typeof input.pinned !== 'boolean') invalid('pinned', 'pinned must be true or false');
    if (input.coverImage !== undefined && input.coverImage !== null && !isValidImageUrl(input.coverImage)) {
        invalid('coverImage', 'coverImage must be an http(s) URL or an absolute path');
    }
    if (input.category !== undefined && input.category !== null && (typeof input.category !== 'string' || !input.category || input.category.length > 64)) {
        invalid('category', 'category must be a slug up to 64 characters');
    }
    if (input.authorSlug !== undefined) {
        if (input.authorSlug === null && mode !== 'create' && config.authors && current!.authorSlug) {
            invalid('authorSlug', 'The author of a post cannot be removed, only replaced');
        }
        if (input.authorSlug !== null && (typeof input.authorSlug !== 'string' || !input.authorSlug)) invalid('authorSlug', 'authorSlug must be a slug');
    }

    const provided = TAXONOMY_FIELDS.filter(field => input[field] !== undefined);
    if (mode === 'create' || provided.length) {
        const applied = model.taxonomyFieldsFor(kind, {
            category: input.category as string | null | undefined,
            pinned: input.pinned as boolean | undefined,
            authorSlug: input.authorSlug as string | null | undefined,
            coverImage: input.coverImage as string | null | undefined,
        });
        for (const field of mode === 'create' ? TAXONOMY_FIELDS : provided) (draft as Record<string, unknown>)[field] = applied[field];
    }

    if (mode !== 'import') {
        if (input.folderId !== undefined) {
            if (input.folderId !== null && typeof input.folderId !== 'string') invalid('folderId', 'folderId must be a string or null');
            draft.folderId = input.folderId as string | null;
        }
        if (input.role !== undefined) {
            model.assertRole(input.role as string | null);
            draft.role = input.role as string | null;
        }
    }
    return draft;
}
