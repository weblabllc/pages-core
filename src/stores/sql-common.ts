import { StoredFolder } from '../addressing.js';
import { StoredAuthor, StoredCategory, StoredPage } from '../store.js';

export interface TableNames {
    pages: string;
    authors: string;
    categories: string;
    folders: string;
    slugHistory: string;
}

export function tableNames(prefix: string): TableNames {
    const p = prefix.replace(/[^a-zA-Z0-9_]/g, '');
    return {
        pages: `${p}pages`,
        authors: `${p}authors`,
        categories: `${p}categories`,
        folders: `${p}page_folders`,
        slugHistory: `${p}page_slug_history`,
    };
}

export function pageToRow(r: StoredPage): Record<string, unknown> {
    const placement: Record<string, unknown> = {};
    if (r.folderId !== undefined) placement.folder_id = r.folderId;
    if (r.segment !== undefined) placement.segment = r.segment;
    if (r.role !== undefined) placement.role = r.role;
    if (r.seoTitle !== undefined) placement.seo_title = r.seoTitle === null ? null : JSON.stringify(r.seoTitle);
    if (r.seoDescription !== undefined) placement.seo_description = r.seoDescription === null ? null : JSON.stringify(r.seoDescription);
    return {
        ...placement,
        slug: r.slug,
        tenant: r.tenant ?? '',
        type: r.type,
        status: r.status,
        title: r.title,
        title_mlt: r.titleMlt === null || r.titleMlt === undefined ? null : JSON.stringify(r.titleMlt),
        annotation: r.annotation === null || r.annotation === undefined ? null : JSON.stringify(r.annotation),
        data: JSON.stringify(r.data ?? null),
        category: r.category,
        pinned: r.pinned ?? false,
        author_slug: r.authorSlug,
        cover_image: r.coverImage,
        reading_time: r.readingTime,
        published_at: r.publishedAt,
    };
}

function parseJson(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
    return value;
}

function asDate(value: unknown): Date | null {
    if (!value) return null;
    return value instanceof Date ? value : new Date(String(value));
}

export function rowToPage(row: Record<string, unknown>): StoredPage {
    return {
        slug: String(row.slug),
        tenant: String(row.tenant ?? ''),
        type: row.type as StoredPage['type'],
        status: row.status as StoredPage['status'],
        title: (row.title as string | null) ?? null,
        titleMlt: parseJson(row.title_mlt) as StoredPage['titleMlt'],
        annotation: parseJson(row.annotation) as StoredPage['annotation'],
        data: parseJson(row.data),
        category: (row.category as string | null) ?? null,
        pinned: Boolean(row.pinned),
        authorSlug: (row.author_slug as string | null) ?? null,
        coverImage: (row.cover_image as string | null) ?? null,
        readingTime: row.reading_time === null || row.reading_time === undefined ? null : Number(row.reading_time),
        publishedAt: asDate(row.published_at),
        ...('folder_id' in row ? { folderId: (row.folder_id as string | null) ?? null } : {}),
        ...('segment' in row ? { segment: (row.segment as string | null) ?? null } : {}),
        ...('role' in row ? { role: (row.role as string | null) ?? null } : {}),
        ...('seo_title' in row ? { seoTitle: parseJson(row.seo_title) as StoredPage['seoTitle'] } : {}),
        ...('seo_description' in row ? { seoDescription: parseJson(row.seo_description) as StoredPage['seoDescription'] } : {}),
        createdAt: asDate(row.created_at) ?? undefined,
        updatedAt: asDate(row.updated_at) ?? undefined,
    };
}

export function authorToRow(a: StoredAuthor): Record<string, unknown> {
    return {
        slug: a.slug,
        tenant: a.tenant ?? '',
        name: JSON.stringify(a.name),
        role: a.role === null || a.role === undefined ? null : JSON.stringify(a.role),
        photo: a.photo,
        enabled: a.enabled ?? true,
    };
}

export function rowToAuthor(row: Record<string, unknown>): StoredAuthor {
    return {
        slug: String(row.slug),
        tenant: String(row.tenant ?? ''),
        name: parseJson(row.name) as StoredAuthor['name'],
        role: parseJson(row.role) as StoredAuthor['role'],
        photo: (row.photo as string | null) ?? null,
        enabled: Boolean(row.enabled),
    };
}

export function categoryToRow(c: StoredCategory): Record<string, unknown> {
    return {
        slug: c.slug,
        tenant: c.tenant ?? '',
        kind: c.kind,
        name: c.name === null || c.name === undefined ? null : JSON.stringify(c.name),
        sort_order: c.sortOrder ?? 0,
        enabled: c.enabled ?? true,
    };
}

export function rowToCategory(row: Record<string, unknown>): StoredCategory {
    return {
        slug: String(row.slug),
        tenant: String(row.tenant ?? ''),
        kind: String(row.kind),
        name: parseJson(row.name) as StoredCategory['name'],
        sortOrder: Number(row.sort_order ?? 0),
        enabled: Boolean(row.enabled),
    };
}

export const PAGE_PATCHABLE: Record<string, string> = {
    type: 'type',
    status: 'status',
    title: 'title',
    titleMlt: 'title_mlt',
    annotation: 'annotation',
    data: 'data',
    category: 'category',
    pinned: 'pinned',
    authorSlug: 'author_slug',
    coverImage: 'cover_image',
    readingTime: 'reading_time',
    publishedAt: 'published_at',
    folderId: 'folder_id',
    segment: 'segment',
    seoTitle: 'seo_title',
    seoDescription: 'seo_description',
};

export function patchToColumns(patch: Partial<StoredPage>): Array<[string, unknown]> {
    const jsonCols = new Set(['title_mlt', 'annotation', 'data', 'seo_title', 'seo_description']);
    const entries: Array<[string, unknown]> = [];
    for (const [key, col] of Object.entries(PAGE_PATCHABLE)) {
        if (!(key in patch)) continue;
        const value = (patch as Record<string, unknown>)[key];
        entries.push([col, jsonCols.has(col) && value !== null ? JSON.stringify(value) : value]);
    }
    return entries;
}

export function folderToRow(f: StoredFolder): Record<string, unknown> {
    return {
        id: f.id,
        tenant: f.tenant ?? '',
        parent_id: f.parentId,
        name: f.name,
        name_mlt: f.nameMlt === null || f.nameMlt === undefined ? null : JSON.stringify(f.nameMlt),
        segment: f.segment,
        sort_order: f.sortOrder ?? 0,
    };
}

export function rowToFolder(row: Record<string, unknown>): StoredFolder {
    return {
        id: String(row.id),
        tenant: String(row.tenant ?? ''),
        parentId: (row.parent_id as string | null) ?? null,
        name: String(row.name),
        nameMlt: parseJson(row.name_mlt) as StoredFolder['nameMlt'],
        segment: String(row.segment),
        sortOrder: Number(row.sort_order ?? 0),
    };
}
