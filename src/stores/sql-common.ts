import { StoredFolder } from '../addressing.js';
import { PAGE_PATCH_FIELDS, PagePatch, StoredAuthor, StoredCategory, StoredPage } from '../store.js';
import { StoredComment } from '../comments.js';

export const MAX_TABLE_PREFIX = 20;

export interface TableNames {
    pages: string;
    authors: string;
    categories: string;
    folders: string;
    slugHistory: string;
    comments: string;
}

export function tableNames(prefix: string): TableNames {
    const p = prefix.replace(/[^a-zA-Z0-9_]/g, '');
    if (p.length > MAX_TABLE_PREFIX) {
        throw new Error(`Table prefix "${p}" is longer than ${MAX_TABLE_PREFIX} characters; index names would overflow`);
    }
    return {
        pages: `${p}pages`,
        authors: `${p}authors`,
        categories: `${p}categories`,
        folders: `${p}page_folders`,
        slugHistory: `${p}page_slug_history`,
        comments: `${p}page_comments`,
    };
}

export function likePattern(term: string): string {
    return `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`;
}

const JSON_COLUMNS = new Set(['title_mlt', 'annotation', 'data', 'seo_title', 'seo_description']);

export const PAGE_COLUMNS: Record<(typeof PAGE_PATCH_FIELDS)[number], string> = {
    slug: 'slug',
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

export const PAGE_SORT_COLUMNS = {
    publishedAt: 'published_at',
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    readingTime: 'reading_time',
    title: 'title',
    pinned: 'pinned',
    id: 'id',
} as const;

export const COMMENT_SORT_COLUMNS = {
    createdAt: 'created_at',
    status: 'status',
    rating: 'rating',
    id: 'id',
} as const;

export const INDEX_PROJECTION_COLUMNS = [
    'id',
    'tenant',
    'slug',
    'type',
    'status',
    'title',
    'title_mlt',
    'category',
    'folder_id',
    'segment',
    'role',
    'published_at',
    'updated_at',
    'created_at',
];

export function patchToColumns(patch: PagePatch): Array<[string, unknown]> {
    const entries: Array<[string, unknown]> = [];
    for (const field of PAGE_PATCH_FIELDS) {
        const value = patch[field];
        if (value === undefined) continue;
        const col = PAGE_COLUMNS[field];
        entries.push([col, JSON_COLUMNS.has(col) && value !== null ? JSON.stringify(value) : value]);
    }
    return entries;
}

export function pageToRow(r: StoredPage): Record<string, unknown> {
    const placement: Record<string, unknown> = {};
    if (r.createdAt) placement.created_at = r.createdAt;
    if (r.updatedAt) placement.updated_at = r.updatedAt;
    if (r.folderId !== undefined) placement.folder_id = r.folderId;
    if (r.segment !== undefined) placement.segment = r.segment;
    if (r.role !== undefined) placement.role = r.role;
    if (r.createdBy !== undefined) placement.created_by = r.createdBy;
    if (r.seoTitle !== undefined) placement.seo_title = r.seoTitle === null ? null : JSON.stringify(r.seoTitle);
    if (r.seoDescription !== undefined) placement.seo_description = r.seoDescription === null ? null : JSON.stringify(r.seoDescription);
    return {
        ...placement,
        id: r.id,
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
        id: String(row.id),
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
        ...('created_by' in row ? { createdBy: (row.created_by as string | null) ?? null } : {}),
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

export function commentToRow(c: StoredComment): Record<string, unknown> {
    return {
        id: c.id,
        tenant: c.tenant ?? '',
        page_id: c.pageId,
        user_id: c.userId,
        author_name: c.authorName,
        author_email: c.authorEmail,
        content: c.content,
        rating: c.rating,
        status: c.status,
        moderated_by: c.moderatedBy,
        moderated_at: c.moderatedAt,
        ip: c.ip,
        created_at: c.createdAt,
    };
}

export function rowToComment(row: Record<string, unknown>): StoredComment {
    return {
        id: String(row.id),
        tenant: String(row.tenant ?? ''),
        pageId: String(row.page_id),
        userId: (row.user_id as string | null) ?? null,
        authorName: String(row.author_name),
        authorEmail: (row.author_email as string | null) ?? null,
        content: String(row.content),
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        status: row.status as StoredComment['status'],
        moderatedBy: (row.moderated_by as string | null) ?? null,
        moderatedAt: asDate(row.moderated_at),
        ip: (row.ip as string | null) ?? null,
        createdAt: asDate(row.created_at) ?? new Date(0),
    };
}
