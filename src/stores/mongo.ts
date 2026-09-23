import { clampPage, paginationMeta, pageOffset } from '../pagination.js';
import {
    loadOptionalModule,
    PageListQuery,
    PageListResult,
    PageStore,
    PageStoreOptions,
    SchemaFeatures,
    StoredAuthor,
    StoredCategory,
    StoredPage,
} from '../store.js';
import { StoredFolder } from '../addressing.js';

interface MongoCollection {
    createIndex(spec: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
    findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    insertOne(doc: Record<string, unknown>): Promise<unknown>;
    updateOne(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
    ): Promise<{ matchedCount: number }>;
    deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
    updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
    countDocuments(filter: Record<string, unknown>): Promise<number>;
    find(filter: Record<string, unknown>): {
        sort(spec: Record<string, unknown>): {
            skip(n: number): { limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> } };
        };
        toArray(): Promise<Array<Record<string, unknown>>>;
    };
}

interface MongoDb {
    collection(name: string): MongoCollection;
}

interface MongoClientLike {
    db(name?: string): MongoDb;
    close(): Promise<void>;
}

function docToPage(doc: Record<string, unknown>): StoredPage {
    const { _id, ...rest } = doc;
    return {
        ...(rest as unknown as StoredPage),
        publishedAt: rest.publishedAt ? new Date(rest.publishedAt as string | Date) : null,
    };
}

export class MongoPageStore implements PageStore {
    private constructor(
        private client: MongoClientLike,
        private db: MongoDb,
        private prefix: string,
        private ownsClient: boolean,
    ) {}

    static async create(options: PageStoreOptions): Promise<MongoPageStore> {
        const prefix = (options.tablePrefix ?? 'rl_').replace(/[^a-zA-Z0-9_]/g, '');
        if (options.client) {
            const client = options.client as MongoClientLike;
            return new MongoPageStore(client, client.db(options.database), prefix, false);
        }
        const mongodb = await loadOptionalModule('mongodb', 'the mongodb page store');
        const client: MongoClientLike = new mongodb.MongoClient(options.url);
        await (client as unknown as { connect(): Promise<void> }).connect();
        return new MongoPageStore(client, client.db(options.database), prefix, true);
    }

    private pages(): MongoCollection {
        return this.db.collection(`${this.prefix}pages`);
    }

    private authors(): MongoCollection {
        return this.db.collection(`${this.prefix}authors`);
    }

    private categories(): MongoCollection {
        return this.db.collection(`${this.prefix}categories`);
    }

    private folders(): MongoCollection {
        return this.db.collection(`${this.prefix}page_folders`);
    }

    private slugHistory(): MongoCollection {
        return this.db.collection(`${this.prefix}page_slug_history`);
    }

    async ensureSchema(features: SchemaFeatures = {}): Promise<void> {
        const { pages = true, authors = false, categories = false, folders = false, roles = false } = features;
        if (pages) {
            await this.pages().createIndex({ tenant: 1, slug: 1 }, { unique: true });
            await this.pages().createIndex({ tenant: 1, type: 1, status: 1, publishedAt: -1 });
        }
        if (authors) {
            await this.authors().createIndex({ tenant: 1, slug: 1 }, { unique: true });
        }
        if (categories) {
            await this.categories().createIndex({ tenant: 1, kind: 1, slug: 1 }, { unique: true });
        }
        if (roles) {
            await this.pages().createIndex(
                { tenant: 1, role: 1 },
                { unique: true, partialFilterExpression: { role: { $type: 'string' } } },
            );
        }
        if (folders) {
            await this.pages().createIndex({ tenant: 1, folderId: 1 });
            await this.folders().createIndex({ tenant: 1, id: 1 }, { unique: true });
            await this.slugHistory().createIndex({ tenant: 1, slug: 1 }, { unique: true });
            await this.slugHistory().createIndex({ tenant: 1, currentSlug: 1 });
        }
    }

    async close(): Promise<void> {
        if (this.ownsClient) await this.client.close();
    }

    async getPage(slug: string, tenant = ''): Promise<StoredPage | null> {
        const doc = await this.pages().findOne({ tenant, slug });
        return doc ? docToPage(doc) : null;
    }

    async createPage(record: StoredPage): Promise<StoredPage> {
        const now = new Date();
        await this.pages().insertOne({
            ...record,
            tenant: record.tenant ?? '',
            createdAt: now,
            updatedAt: now,
        });
        return (await this.getPage(record.slug, record.tenant ?? ''))!;
    }

    async updatePage(slug: string, patch: Partial<StoredPage>, tenant = ''): Promise<StoredPage | null> {
        const { slug: _s, tenant: _t, createdAt: _c, ...rest } = patch;
        await this.pages().updateOne({ tenant, slug }, { $set: { ...rest, updatedAt: new Date() } });
        return this.getPage(slug, tenant);
    }

    async deletePage(slug: string, tenant = ''): Promise<boolean> {
        const res = await this.pages().deleteOne({ tenant, slug });
        return res.deletedCount > 0;
    }

    async listPages(query: PageListQuery = {}): Promise<PageListResult> {
        const page = clampPage(query.page);
        const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 25;
        const filter: Record<string, unknown> = { tenant: query.tenant ?? '' };
        if (query.type) filter.type = query.type;
        if (query.status) filter.status = query.status;
        if (query.category) filter.category = query.category;
        if (query.authorSlug) filter.authorSlug = query.authorSlug;
        if (query.pinned !== undefined) filter.pinned = query.pinned;
        if (query.search) {
            const re = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
            filter.$or = [{ title: re }, { slug: re }];
        }
        const total = await this.pages().countDocuments(filter);
        const docs = await this.pages()
            .find(filter)
            .sort({ pinned: -1, publishedAt: -1, updatedAt: -1 })
            .skip(pageOffset(page, pageSize))
            .limit(pageSize)
            .toArray();
        return { rows: docs.map(docToPage), pagination: paginationMeta(total, page, pageSize) };
    }

    async upsertAuthor(author: StoredAuthor): Promise<StoredAuthor> {
        const tenant = author.tenant ?? '';
        await this.authors().updateOne(
            { tenant, slug: author.slug },
            { $set: { ...author, tenant } },
            { upsert: true },
        );
        return (await this.getAuthor(author.slug, tenant))!;
    }

    async getAuthor(slug: string, tenant = ''): Promise<StoredAuthor | null> {
        const doc = await this.authors().findOne({ tenant, slug });
        if (!doc) return null;
        const { _id, ...rest } = doc;
        return rest as unknown as StoredAuthor;
    }

    async listAuthors(options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredAuthor[]> {
        const filter: Record<string, unknown> = { tenant: options.tenant ?? '' };
        if (options.enabledOnly) filter.enabled = true;
        const docs = await this.authors().find(filter).toArray();
        return docs.map(({ _id, ...rest }) => rest as unknown as StoredAuthor);
    }

    async deleteAuthor(slug: string, tenant = ''): Promise<boolean> {
        const res = await this.authors().deleteOne({ tenant, slug });
        return res.deletedCount > 0;
    }

    async countPagesByAuthor(authorSlug: string, tenant = ''): Promise<number> {
        return this.pages().countDocuments({ tenant, authorSlug });
    }

    async upsertCategory(category: StoredCategory): Promise<StoredCategory> {
        const tenant = category.tenant ?? '';
        await this.categories().updateOne(
            { tenant, kind: category.kind, slug: category.slug },
            { $set: { ...category, tenant } },
            { upsert: true },
        );
        return category;
    }

    async listCategories(kind: string, options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredCategory[]> {
        const filter: Record<string, unknown> = { tenant: options.tenant ?? '', kind };
        if (options.enabledOnly) filter.enabled = true;
        const docs = await this.categories().find(filter).toArray();
        return (docs.map(({ _id, ...rest }) => rest) as unknown as StoredCategory[]).sort(
            (a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug),
        );
    }

    async deleteCategory(kind: string, slug: string, tenant = ''): Promise<boolean> {
        const res = await this.categories().deleteOne({ tenant, kind, slug });
        return res.deletedCount > 0;
    }

    async listFolders(tenant = ''): Promise<StoredFolder[]> {
        const docs = await this.folders().find({ tenant }).toArray();
        return (docs.map(({ _id, ...rest }) => rest) as unknown as StoredFolder[]).sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        );
    }

    async saveFolder(folder: StoredFolder): Promise<StoredFolder> {
        const tenant = folder.tenant ?? '';
        await this.folders().updateOne({ tenant, id: folder.id }, { $set: { ...folder, tenant } }, { upsert: true });
        return folder;
    }

    async deleteFolder(id: string, tenant = ''): Promise<boolean> {
        const res = await this.folders().deleteOne({ tenant, id });
        return res.deletedCount > 0;
    }

    async listPagesInFolders(folderIds: ReadonlyArray<string | null>, tenant = ''): Promise<StoredPage[]> {
        if (!folderIds.length) return [];
        const ids = folderIds.filter((id): id is string => id !== null);
        const or: Record<string, unknown>[] = [];
        if (ids.length) or.push({ folderId: { $in: ids } });
        if (folderIds.includes(null)) or.push({ folderId: null });
        const docs = await this.pages().find({ tenant, $or: or }).toArray();
        return docs.map(docToPage);
    }

    async renamePage(from: string, to: string, tenant = ''): Promise<void> {
        if (from === to) return;
        await this.slugHistory().deleteOne({ tenant, slug: to });
        await this.pages().updateOne({ tenant, slug: from }, { $set: { slug: to, updatedAt: new Date() } });
        await this.slugHistory().updateMany({ tenant, currentSlug: from }, { $set: { currentSlug: to } });
        await this.slugHistory().updateOne(
            { tenant, slug: from },
            { $set: { tenant, slug: from, currentSlug: to, createdAt: new Date() } },
            { upsert: true },
        );
    }

    async findPageByRole(role: string, tenant = ''): Promise<StoredPage | null> {
        const doc = await this.pages().findOne({ tenant, role });
        return doc ? docToPage(doc) : null;
    }

    async setRole(slug: string, role: string | null, tenant = ''): Promise<void> {
        await this.pages().updateOne({ tenant, slug }, { $set: { role, updatedAt: new Date() } });
    }

    async listPagesWithRole(tenant = ''): Promise<StoredPage[]> {
        const docs = await this.pages().find({ tenant, role: { $type: 'string' } }).toArray();
        return docs.map(docToPage).sort((a, b) => String(a.role).localeCompare(String(b.role)));
    }

    async resolveFormerSlug(slug: string, tenant = ''): Promise<string | null> {
        const doc = await this.slugHistory().findOne({ tenant, slug });
        return doc ? String(doc.currentSlug) : null;
    }

    async releaseFormerSlug(slug: string, tenant = ''): Promise<void> {
        await this.slugHistory().deleteOne({ tenant, slug });
    }
}
