import { PaginationMeta } from './pagination.js';
import { MultiLangText } from './mlt.js';
import { AuthorRecord } from './authors.js';
import { PageStatus, PageType } from './types.js';
import { StoredFolder } from './addressing.js';
import { CommentStatus, StoredComment } from './comments.js';

export interface StoredPage {
    id: string;
    slug: string;
    tenant: string;
    type: PageType;
    status: PageStatus;
    title: string | null;
    titleMlt: MultiLangText | null;
    annotation: MultiLangText | null;
    data: unknown;
    category: string | null;
    pinned: boolean;
    authorSlug: string | null;
    coverImage: string | null;
    readingTime: number | null;
    publishedAt: Date | null;
    folderId?: string | null;
    segment?: string | null;
    role?: string | null;
    seoTitle?: MultiLangText | null;
    seoDescription?: MultiLangText | null;
    createdBy?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface StoredCategory {
    slug: string;
    tenant: string;
    kind: string;
    name: MultiLangText | null;
    sortOrder: number;
    enabled: boolean;
}

export interface StoredAuthor extends AuthorRecord {
    tenant: string;
}

export type PageSortField = 'publishedAt' | 'updatedAt' | 'createdAt' | 'readingTime' | 'title' | 'pinned' | 'id';

export interface PageOrder {
    field: PageSortField;
    direction: 'asc' | 'desc';
}

export type PageProjection = 'full' | 'card' | 'index';

export interface PageSearch {
    term: string;
    columns: ReadonlyArray<'title' | 'slug'>;
    mlt: ReadonlyArray<'titleMlt' | 'annotation'>;
    langs: readonly string[];
}

export interface PageFilter {
    tenant?: string;
    types?: readonly PageType[];
    status?: PageStatus;
    category?: string;
    hasCategory?: boolean;
    authorSlug?: string;
    pinned?: boolean;
    folderId?: string | null;
    folderIds?: ReadonlyArray<string | null>;
    ids?: readonly string[];
    search?: PageSearch;
}

export interface PageListQuery extends PageFilter {
    order: readonly PageOrder[];
    page: number;
    pageSize: number;
    projection?: PageProjection;
}

export interface PageListResult {
    rows: StoredPage[];
    pagination: PaginationMeta;
}

export const PAGE_PATCH_FIELDS = [
    'slug',
    'status',
    'title',
    'titleMlt',
    'annotation',
    'data',
    'category',
    'pinned',
    'authorSlug',
    'coverImage',
    'readingTime',
    'publishedAt',
    'folderId',
    'segment',
    'seoTitle',
    'seoDescription',
] as const;

export type PagePatch = Partial<Pick<StoredPage, (typeof PAGE_PATCH_FIELDS)[number]>>;

export type ConflictTarget = 'page_id' | 'page_slug' | 'page_role' | 'folder_sibling' | 'comment_id' | 'unknown';

export class StoreConflictError extends Error {
    constructor(
        readonly target: ConflictTarget,
        message: string,
    ) {
        super(message);
        this.name = 'StoreConflictError';
    }
}

export type CommentSortField = 'createdAt' | 'status' | 'rating' | 'id';

export interface CommentOrder {
    field: CommentSortField;
    direction: 'asc' | 'desc';
}

export interface CommentListQuery {
    tenant?: string;
    pageId?: string;
    status?: CommentStatus;
    rating?: number;
    search?: string;
    order: readonly CommentOrder[];
    page: number;
    pageSize: number;
}

export interface SchemaFeatures {
    pages?: boolean;
    authors?: boolean;
    categories?: boolean;
    folders?: boolean;
    roles?: boolean;
    comments?: boolean;
    slugHistory?: boolean;
}

export interface PageStore {
    ensureSchema(features?: SchemaFeatures): Promise<void>;
    close(): Promise<void>;
    transaction<T>(fn: (tx: PageStore) => Promise<T>): Promise<T>;

    getPageById(id: string, tenant?: string, projection?: PageProjection): Promise<StoredPage | null>;
    getPageBySlug(slug: string, tenant?: string, projection?: PageProjection): Promise<StoredPage | null>;
    getPagesByIds(ids: readonly string[], tenant?: string, projection?: PageProjection): Promise<StoredPage[]>;
    createPage(record: StoredPage): Promise<StoredPage>;
    updatePage(id: string, patch: PagePatch, tenant?: string): Promise<StoredPage | null>;
    deletePage(id: string, tenant?: string): Promise<boolean>;
    listPages(query: PageListQuery): Promise<PageListResult>;
    countPages(filter: PageFilter): Promise<number>;

    upsertAuthor(author: StoredAuthor): Promise<StoredAuthor>;
    getAuthor(slug: string, tenant?: string): Promise<StoredAuthor | null>;
    getAuthorsBySlugs(slugs: readonly string[], tenant?: string): Promise<StoredAuthor[]>;
    listAuthors(options?: { tenant?: string; enabledOnly?: boolean }): Promise<StoredAuthor[]>;
    deleteAuthor(slug: string, tenant?: string): Promise<boolean>;

    upsertCategory(category: StoredCategory): Promise<StoredCategory>;
    getCategory(kind: string, slug: string, tenant?: string): Promise<StoredCategory | null>;
    listCategories(kind: string, options?: { tenant?: string; enabledOnly?: boolean }): Promise<StoredCategory[]>;
    deleteCategory(kind: string, slug: string, tenant?: string): Promise<boolean>;

    listFolders(tenant?: string): Promise<StoredFolder[]>;
    saveFolder(folder: StoredFolder): Promise<StoredFolder>;
    deleteFolder(id: string, tenant?: string): Promise<boolean>;

    recordFormerSlug(slug: string, pageId: string, tenant?: string): Promise<void>;
    resolveFormerSlug(slug: string, tenant?: string): Promise<string | null>;
    releaseFormerSlug(slug: string, tenant?: string): Promise<void>;
    deleteSlugHistory(pageId: string, tenant?: string): Promise<void>;

    findPageByRole(role: string, tenant?: string): Promise<StoredPage | null>;
    setRole(id: string, role: string | null, tenant?: string): Promise<void>;
    listPagesWithRole(tenant?: string): Promise<StoredPage[]>;

    createComment(comment: StoredComment): Promise<StoredComment>;
    getComment(id: string, tenant?: string): Promise<StoredComment | null>;
    listComments(query: CommentListQuery): Promise<{ rows: StoredComment[]; pagination: PaginationMeta }>;
    setCommentStatus(id: string, status: CommentStatus, moderatedBy: string | null, tenant?: string): Promise<StoredComment | null>;
    deleteComment(id: string, tenant?: string): Promise<boolean>;
    deleteCommentsByPage(pageId: string, tenant?: string): Promise<number>;
    aggregateApprovedRatings(pageIds: readonly string[], tenant?: string): Promise<Array<{ pageId: string; count: number; sum: number }>>;
}

export type PageStoreDriver = 'postgres' | 'mysql' | 'mongodb';

export interface PageStoreOptions {
    driver: PageStoreDriver;
    url?: string;
    client?: unknown;
    tablePrefix?: string;
    database?: string;
    clientMode?: 'pool' | 'bound';
    mongoTransactions?: 'auto' | 'require';
}

export async function loadOptionalModule(name: string, purpose: string): Promise<any> {
    try {
        const mod = await import(name);
        return mod.default ?? mod;
    } catch (error) {
        if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
            throw new Error(
                `Optional dependency "${name}" is required for ${purpose}. Install it: npm install ${name}`,
            );
        }
        throw error;
    }
}

export async function createPageStore(options: PageStoreOptions): Promise<PageStore> {
    switch (options.driver) {
        case 'postgres': {
            const { PgPageStore } = await import('./stores/pg.js');
            return PgPageStore.create(options);
        }
        case 'mysql': {
            const { MysqlPageStore } = await import('./stores/mysql.js');
            return MysqlPageStore.create(options);
        }
        case 'mongodb': {
            const { MongoPageStore } = await import('./stores/mongo.js');
            return MongoPageStore.create(options);
        }
        default:
            throw new Error(`Unknown page store driver: ${(options as PageStoreOptions).driver}`);
    }
}
