import { PaginationMeta } from './pagination.js';
import { MultiLangText } from './mlt.js';
import { AuthorRecord } from './authors.js';
import { PageStatus, PageType } from './types.js';
import { StoredFolder } from './addressing.js';

export interface StoredPage {
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

export interface PageListQuery {
    tenant?: string;
    type?: PageType;
    status?: PageStatus;
    category?: string;
    authorSlug?: string;
    pinned?: boolean;
    search?: string;
    page?: number;
    pageSize?: number;
}

export interface PageListResult {
    rows: StoredPage[];
    pagination: PaginationMeta;
}

export interface SchemaFeatures {
    pages?: boolean;
    authors?: boolean;
    categories?: boolean;
    folders?: boolean;
    roles?: boolean;
}

export interface PageStore {
    ensureSchema(features?: SchemaFeatures): Promise<void>;
    close(): Promise<void>;

    getPage(slug: string, tenant?: string): Promise<StoredPage | null>;
    createPage(record: StoredPage): Promise<StoredPage>;
    updatePage(slug: string, patch: Partial<StoredPage>, tenant?: string): Promise<StoredPage | null>;
    deletePage(slug: string, tenant?: string): Promise<boolean>;
    listPages(query?: PageListQuery): Promise<PageListResult>;

    upsertAuthor(author: StoredAuthor): Promise<StoredAuthor>;
    getAuthor(slug: string, tenant?: string): Promise<StoredAuthor | null>;
    listAuthors(options?: { tenant?: string; enabledOnly?: boolean }): Promise<StoredAuthor[]>;
    deleteAuthor(slug: string, tenant?: string): Promise<boolean>;
    countPagesByAuthor(authorSlug: string, tenant?: string): Promise<number>;

    upsertCategory(category: StoredCategory): Promise<StoredCategory>;
    listCategories(kind: string, options?: { tenant?: string; enabledOnly?: boolean }): Promise<StoredCategory[]>;
    deleteCategory(kind: string, slug: string, tenant?: string): Promise<boolean>;

    listFolders(tenant?: string): Promise<StoredFolder[]>;
    saveFolder(folder: StoredFolder): Promise<StoredFolder>;
    deleteFolder(id: string, tenant?: string): Promise<boolean>;
    listPagesInFolders(folderIds: ReadonlyArray<string | null>, tenant?: string): Promise<StoredPage[]>;
    renamePage(from: string, to: string, tenant?: string): Promise<void>;
    resolveFormerSlug(slug: string, tenant?: string): Promise<string | null>;
    releaseFormerSlug(slug: string, tenant?: string): Promise<void>;

    findPageByRole(role: string, tenant?: string): Promise<StoredPage | null>;
    setRole(slug: string, role: string | null, tenant?: string): Promise<void>;
    listPagesWithRole(tenant?: string): Promise<StoredPage[]>;
}

export type PageStoreDriver = 'postgres' | 'mysql' | 'mongodb';

export interface PageStoreOptions {
    driver: PageStoreDriver;
    url?: string;
    client?: unknown;
    tablePrefix?: string;
    database?: string;
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
