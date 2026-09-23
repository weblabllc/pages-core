import { clampPage, paginationMeta, pageOffset, PaginationMeta } from '../pagination.js';
import {
    CommentListQuery,
    ConflictTarget,
    loadOptionalModule,
    PAGE_PATCH_FIELDS,
    PageFilter,
    PageListQuery,
    PageListResult,
    PageOrder,
    PagePatch,
    PageProjection,
    PageStore,
    PageStoreOptions,
    SchemaFeatures,
    StoreConflictError,
    StoredAuthor,
    StoredCategory,
    StoredPage,
} from '../store.js';
import { StoredFolder } from '../addressing.js';
import { CommentStatus, StoredComment, uuidv7 } from '../comments.js';
import { MAX_TABLE_PREFIX } from './sql-common.js';

type Doc = Record<string, unknown>;

interface MongoCursor {
    sort(spec: Doc): MongoCursor;
    skip(n: number): MongoCursor;
    limit(n: number): MongoCursor;
    toArray(): Promise<Doc[]>;
}

interface MongoCollection {
    createIndex(spec: Doc, options?: Doc): Promise<unknown>;
    findOne(filter: Doc, options?: Doc): Promise<Doc | null>;
    find(filter: Doc, options?: Doc): MongoCursor;
    insertOne(doc: Doc, options?: Doc): Promise<unknown>;
    updateOne(filter: Doc, update: Doc, options?: Doc): Promise<{ matchedCount: number }>;
    deleteOne(filter: Doc, options?: Doc): Promise<{ deletedCount: number }>;
    deleteMany(filter: Doc, options?: Doc): Promise<{ deletedCount: number }>;
    countDocuments(filter: Doc, options?: Doc): Promise<number>;
    aggregate(pipeline: Doc[], options?: Doc): { toArray(): Promise<Doc[]> };
}

interface MongoDb {
    collection(name: string): MongoCollection;
    command(command: Doc): Promise<Doc>;
    createCollection(name: string, options?: Doc): Promise<unknown>;
    listCollections(filter?: Doc, options?: Doc): { toArray(): Promise<Doc[]> };
}

interface MongoSession {
    withTransaction(fn: () => Promise<void>): Promise<unknown>;
    endSession(): Promise<void>;
}

interface MongoClientLike {
    db(name?: string): MongoDb;
    startSession(): MongoSession;
    close(): Promise<void>;
}

interface MongoContext {
    client: MongoClientLike;
    db: MongoDb;
    prefix: string;
    ownsClient: boolean;
    transactions: 'auto' | 'require';
    support?: Promise<boolean>;
}

const COMMENT_VALIDATOR = {
    $and: [
        { $or: [{ rating: null }, { rating: { $in: [1, 2, 3, 4, 5] } }] },
        { status: { $in: ['pending', 'approved', 'rejected'] } },
    ],
};

const INDEX_FIELDS = [
    'id',
    'tenant',
    'slug',
    'type',
    'status',
    'title',
    'titleMlt',
    'category',
    'folderId',
    'segment',
    'role',
    'publishedAt',
    'updatedAt',
    'createdAt',
];

const PAGE_OPTIONAL_FIELDS = ['folderId', 'segment', 'role', 'seoTitle', 'seoDescription', 'createdBy'] as const;

let warnedNoTransactions = false;

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asDate(value: unknown): Date | null {
    if (value === null || value === undefined) return null;
    return value instanceof Date ? value : new Date(value as string);
}

function docToPage(doc: Doc): StoredPage {
    const page: StoredPage = {
        id: String(doc.id),
        slug: String(doc.slug),
        tenant: String(doc.tenant ?? ''),
        type: doc.type as StoredPage['type'],
        status: doc.status as StoredPage['status'],
        title: (doc.title as string | null) ?? null,
        titleMlt: (doc.titleMlt as StoredPage['titleMlt']) ?? null,
        annotation: (doc.annotation as StoredPage['annotation']) ?? null,
        data: doc.data ?? null,
        category: (doc.category as string | null) ?? null,
        pinned: Boolean(doc.pinned),
        authorSlug: (doc.authorSlug as string | null) ?? null,
        coverImage: (doc.coverImage as string | null) ?? null,
        readingTime: doc.readingTime === null || doc.readingTime === undefined ? null : Number(doc.readingTime),
        publishedAt: asDate(doc.publishedAt),
        createdAt: asDate(doc.createdAt) ?? undefined,
        updatedAt: asDate(doc.updatedAt) ?? undefined,
    };
    for (const field of PAGE_OPTIONAL_FIELDS) {
        if (field in doc) (page as unknown as Doc)[field] = doc[field] ?? null;
    }
    return page;
}

function docToComment(doc: Doc): StoredComment {
    return {
        id: String(doc.id),
        tenant: String(doc.tenant ?? ''),
        pageId: String(doc.pageId),
        userId: (doc.userId as string | null) ?? null,
        authorName: String(doc.authorName),
        authorEmail: (doc.authorEmail as string | null) ?? null,
        content: String(doc.content),
        rating: doc.rating === null || doc.rating === undefined ? null : Number(doc.rating),
        status: doc.status as CommentStatus,
        moderatedBy: (doc.moderatedBy as string | null) ?? null,
        moderatedAt: asDate(doc.moderatedAt),
        ip: (doc.ip as string | null) ?? null,
        createdAt: asDate(doc.createdAt) ?? new Date(0),
    };
}

function strip(doc: Doc): Doc {
    const { _id, ...rest } = doc;
    return rest;
}

function sameKeys(pattern: unknown, keys: string[]): boolean {
    return !!pattern && typeof pattern === 'object' && Object.keys(pattern).join(',') === keys.join(',');
}

export class MongoPageStore implements PageStore {
    private constructor(
        private ctx: MongoContext,
        private session?: MongoSession,
    ) {}

    static async create(options: PageStoreOptions): Promise<MongoPageStore> {
        const prefix = (options.tablePrefix ?? 'rl_').replace(/[^a-zA-Z0-9_]/g, '');
        if (prefix.length > MAX_TABLE_PREFIX) {
            throw new Error(`Table prefix "${prefix}" is longer than ${MAX_TABLE_PREFIX} characters; index names would overflow`);
        }
        const transactions = options.mongoTransactions ?? 'auto';
        if (options.client) {
            const client = options.client as MongoClientLike;
            return new MongoPageStore({ client, db: client.db(options.database), prefix, ownsClient: false, transactions });
        }
        const mongodb = await loadOptionalModule('mongodb', 'the mongodb page store');
        const client = new mongodb.MongoClient(options.url);
        await client.connect();
        return new MongoPageStore({ client, db: client.db(options.database), prefix, ownsClient: true, transactions });
    }

    private get o(): Doc | undefined {
        return this.session ? { session: this.session } : undefined;
    }

    private opts(extra: Doc = {}): Doc {
        return this.session ? { ...extra, session: this.session } : extra;
    }

    private col(name: string): MongoCollection {
        return this.ctx.db.collection(`${this.ctx.prefix}${name}`);
    }

    private pages(): MongoCollection {
        return this.col('pages');
    }

    private authors(): MongoCollection {
        return this.col('authors');
    }

    private categories(): MongoCollection {
        return this.col('categories');
    }

    private folders(): MongoCollection {
        return this.col('page_folders');
    }

    private slugHistory(): MongoCollection {
        return this.col('page_slug_history');
    }

    private comments(): MongoCollection {
        return this.col('page_comments');
    }

    private async guard<T>(work: Promise<T>, targets: Array<[string[], ConflictTarget]>): Promise<T> {
        try {
            return await work;
        } catch (error) {
            const e = error as { code?: number; keyPattern?: unknown; message?: string };
            if (e?.code !== 11000) throw error;
            const hit = targets.find(([keys]) => sameKeys(e.keyPattern, keys));
            throw new StoreConflictError(hit?.[1] ?? 'unknown', e.message ?? 'duplicate key');
        }
    }

    private supportsTransactions(): Promise<boolean> {
        this.ctx.support ??= this.ctx.db
            .command({ hello: 1 })
            .then(reply => Boolean(reply.setName) || reply.msg === 'isdbgrid')
            .catch(error => {
                this.ctx.support = undefined;
                throw error;
            });
        return this.ctx.support;
    }

    async transaction<T>(fn: (tx: PageStore) => Promise<T>): Promise<T> {
        if (this.session) return fn(this);
        if (!(await this.supportsTransactions())) {
            if (this.ctx.transactions === 'require') {
                throw new Error('MongoDB transactions need a replica set or sharded cluster; this server is standalone');
            }
            if (!warnedNoTransactions) {
                warnedNoTransactions = true;
                console.warn('[pages-core] MongoDB is standalone: page store transactions run without atomicity');
            }
            return fn(this);
        }
        const session = this.ctx.client.startSession();
        try {
            let result: T | undefined;
            await session.withTransaction(async () => {
                result = await fn(new MongoPageStore(this.ctx, session));
            });
            return result as T;
        } finally {
            await session.endSession();
        }
    }

    async ensureSchema(features: SchemaFeatures = {}): Promise<void> {
        const { pages = true, authors = false, categories = false, folders = false, roles = false, comments = false } = features;
        const slugHistory = features.slugHistory ?? folders;
        if (pages) {
            await this.backfillPageIds();
            await this.pages().createIndex({ tenant: 1, slug: 1 }, { unique: true });
            await this.pages().createIndex(
                { tenant: 1, id: 1 },
                { unique: true, name: 'tenant_id_uq', partialFilterExpression: { id: { $type: 'string' } } },
            );
            await this.pages().createIndex({ tenant: 1, type: 1, status: 1, publishedAt: -1 });
            await this.pages().createIndex({ tenant: 1, authorSlug: 1 });
            await this.pages().createIndex({ tenant: 1, category: 1 });
        }
        if (authors) await this.authors().createIndex({ tenant: 1, slug: 1 }, { unique: true });
        if (categories) await this.categories().createIndex({ tenant: 1, kind: 1, slug: 1 }, { unique: true });
        if (roles) {
            await this.pages().createIndex({ tenant: 1, role: 1 }, { unique: true, partialFilterExpression: { role: { $type: 'string' } } });
        }
        if (folders) {
            await this.pages().createIndex({ tenant: 1, folderId: 1 });
            await this.folders().createIndex({ tenant: 1, id: 1 }, { unique: true });
            const duplicates = await this.folders()
                .aggregate([
                    { $group: { _id: { tenant: '$tenant', parentId: { $ifNull: ['$parentId', null] }, segment: '$segment' }, n: { $sum: 1 } } },
                    { $match: { n: { $gt: 1 } } },
                ])
                .toArray();
            if (duplicates.length) {
                const list = duplicates.map(d => {
                    const key = d._id as Doc;
                    return `tenant "${key.tenant}", parent "${key.parentId ?? 'root'}", segment "${key.segment}" (${d.n})`;
                });
                throw new Error(`Cannot add the folder sibling index: rename these duplicate folders first: ${list.join('; ')}`);
            }
            await this.folders().createIndex({ tenant: 1, parentId: 1, segment: 1 }, { unique: true, name: 'sibling_uq' });
        }
        if (slugHistory) await this.upgradeSlugHistory();
        if (comments) await this.ensureComments();
    }

    private async backfillPageIds(): Promise<void> {
        for (;;) {
            const batch = await this.pages().find({ id: { $exists: false } }, { projection: { _id: 1, createdAt: 1 } }).limit(500).toArray();
            if (!batch.length) return;
            for (const doc of batch) {
                const created = asDate(doc.createdAt)?.getTime();
                await this.pages().updateOne(
                    { _id: doc._id, id: { $exists: false } },
                    { $set: { id: uuidv7(created !== undefined && Number.isFinite(created) ? created : Date.now()) } },
                );
            }
        }
    }

    private async upgradeSlugHistory(): Promise<void> {
        await this.slugHistory().createIndex({ tenant: 1, slug: 1 }, { unique: true });
        await this.slugHistory().createIndex({ tenant: 1, pageId: 1 });
        const legacy = await this.slugHistory().find({ currentSlug: { $exists: true }, pageId: { $exists: false } }).toArray();
        for (const doc of legacy) {
            const created = asDate(doc.createdAt);
            const page = await this.pages().findOne({
                tenant: doc.tenant ?? '',
                slug: doc.currentSlug,
                ...(created ? { createdAt: { $lte: created } } : {}),
            });
            await this.slugHistory().updateOne({ _id: doc._id, pageId: { $exists: false } }, { $set: { pageId: page ? page.id : null } });
        }
    }

    private async ensureComments(): Promise<void> {
        const name = `${this.ctx.prefix}page_comments`;
        const existing = await this.ctx.db.listCollections({ name }, { nameOnly: true }).toArray();
        if (existing.length) {
            await this.ctx.db.command({ collMod: name, validator: COMMENT_VALIDATOR, validationLevel: 'strict' });
        } else {
            try {
                await this.ctx.db.createCollection(name, { validator: COMMENT_VALIDATOR, validationLevel: 'strict' });
            } catch (error) {
                if ((error as { code?: number }).code !== 48) throw error;
                await this.ctx.db.command({ collMod: name, validator: COMMENT_VALIDATOR, validationLevel: 'strict' });
            }
        }
        await this.comments().createIndex({ tenant: 1, id: 1 }, { unique: true });
        await this.comments().createIndex({ tenant: 1, pageId: 1, status: 1, createdAt: -1, id: -1 });
        await this.comments().createIndex({ tenant: 1, status: 1, createdAt: -1, id: -1 });
    }

    async close(): Promise<void> {
        if (this.ctx.ownsClient) await this.ctx.client.close();
    }

    private projection(projection: PageProjection = 'full'): Doc | undefined {
        if (projection === 'card') return { data: 0 };
        if (projection === 'index') return Object.fromEntries(INDEX_FIELDS.map(f => [f, 1]));
        return undefined;
    }

    private pageQuery(filter: PageFilter): Doc {
        const and: Doc[] = [{ tenant: filter.tenant ?? '' }];
        if (filter.types) and.push({ type: { $in: [...filter.types] } });
        if (filter.status) and.push({ status: filter.status });
        if (filter.category !== undefined) and.push({ category: filter.category });
        if (filter.hasCategory !== undefined) and.push({ category: filter.hasCategory ? { $ne: null } : null });
        if (filter.authorSlug !== undefined) and.push({ authorSlug: filter.authorSlug });
        if (filter.pinned !== undefined) and.push({ pinned: filter.pinned });
        if (filter.folderId !== undefined) and.push({ folderId: filter.folderId });
        if (filter.folderIds) {
            const ids = filter.folderIds.filter((id): id is string => id !== null);
            const or: Doc[] = [];
            if (ids.length) or.push({ folderId: { $in: ids } });
            if (filter.folderIds.includes(null)) or.push({ folderId: null });
            and.push(or.length ? { $or: or } : { _id: { $exists: false } });
        }
        if (filter.ids) and.push({ id: { $in: [...filter.ids] } });
        if (filter.search && filter.search.term.trim()) {
            const regex = new RegExp(escapeRegex(filter.search.term.trim()), 'i');
            const or: Doc[] = filter.search.columns.map(column => ({ [column]: regex }));
            for (const field of filter.search.mlt) {
                for (const lang of filter.search.langs) or.push({ [`${field}.${lang}`]: regex });
            }
            if (or.length) and.push({ $or: or });
        }
        return and.length === 1 ? and[0] : { $and: and };
    }

    private sortSpec(order: readonly PageOrder[]): Doc {
        return Object.fromEntries(order.map(o => [o.field, o.direction === 'asc' ? 1 : -1]));
    }

    async getPageById(id: string, tenant = '', projection: PageProjection = 'full'): Promise<StoredPage | null> {
        const doc = await this.pages().findOne({ tenant, id }, this.opts({ projection: this.projection(projection) }));
        return doc ? docToPage(doc) : null;
    }

    async getPageBySlug(slug: string, tenant = '', projection: PageProjection = 'full'): Promise<StoredPage | null> {
        const doc = await this.pages().findOne({ tenant, slug }, this.opts({ projection: this.projection(projection) }));
        return doc ? docToPage(doc) : null;
    }

    async getPagesByIds(ids: readonly string[], tenant = '', projection: PageProjection = 'full'): Promise<StoredPage[]> {
        if (!ids.length) return [];
        const docs = await this.pages()
            .find({ tenant, id: { $in: [...new Set(ids)] } }, this.opts({ projection: this.projection(projection) }))
            .toArray();
        return docs.map(docToPage);
    }

    private pageConflicts(): Array<[string[], ConflictTarget]> {
        return [
            [['tenant', 'slug'], 'page_slug'],
            [['tenant', 'id'], 'page_id'],
            [['tenant', 'role'], 'page_role'],
        ];
    }

    async createPage(record: StoredPage): Promise<StoredPage> {
        const now = new Date();
        const doc: Doc = { ...record, tenant: record.tenant ?? '', createdAt: record.createdAt ?? now, updatedAt: record.updatedAt ?? now };
        for (const key of Object.keys(doc)) if (doc[key] === undefined) delete doc[key];
        await this.guard(this.pages().insertOne(doc, this.o), this.pageConflicts());
        return (await this.getPageById(record.id, record.tenant ?? ''))!;
    }

    async updatePage(id: string, patch: PagePatch, tenant = ''): Promise<StoredPage | null> {
        const set: Doc = {};
        for (const field of PAGE_PATCH_FIELDS) if (patch[field] !== undefined) set[field] = patch[field];
        if (Object.keys(set).length) {
            await this.guard(this.pages().updateOne({ tenant, id }, { $set: { ...set, updatedAt: new Date() } }, this.o), this.pageConflicts());
        }
        return this.getPageById(id, tenant);
    }

    async deletePage(id: string, tenant = ''): Promise<boolean> {
        return (await this.pages().deleteOne({ tenant, id }, this.o)).deletedCount > 0;
    }

    async listPages(query: PageListQuery): Promise<PageListResult> {
        const filter = this.pageQuery(query);
        const page = clampPage(query.page);
        const pageSize = Math.max(1, Math.floor(Number(query.pageSize) || 1));
        const total = await this.pages().countDocuments(filter, this.o);
        const docs = await this.pages()
            .find(filter, this.opts({ projection: this.projection(query.projection) }))
            .sort(this.sortSpec(query.order))
            .skip(pageOffset(page, pageSize))
            .limit(pageSize)
            .toArray();
        return { rows: docs.map(docToPage), pagination: paginationMeta(total, page, pageSize) };
    }

    async countPages(filter: PageFilter): Promise<number> {
        return this.pages().countDocuments(this.pageQuery(filter), this.o);
    }

    async upsertAuthor(author: StoredAuthor): Promise<StoredAuthor> {
        const tenant = author.tenant ?? '';
        await this.authors().updateOne({ tenant, slug: author.slug }, { $set: { ...author, tenant } }, this.opts({ upsert: true }));
        return (await this.getAuthor(author.slug, tenant))!;
    }

    async getAuthor(slug: string, tenant = ''): Promise<StoredAuthor | null> {
        const doc = await this.authors().findOne({ tenant, slug }, this.o);
        return doc ? (strip(doc) as unknown as StoredAuthor) : null;
    }

    async getAuthorsBySlugs(slugs: readonly string[], tenant = ''): Promise<StoredAuthor[]> {
        if (!slugs.length) return [];
        const docs = await this.authors()
            .find({ tenant, slug: { $in: [...new Set(slugs)] } }, this.o)
            .sort({ slug: 1 })
            .toArray();
        return docs.map(d => strip(d) as unknown as StoredAuthor);
    }

    async listAuthors(options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredAuthor[]> {
        const filter: Doc = { tenant: options.tenant ?? '' };
        if (options.enabledOnly) filter.enabled = true;
        const docs = await this.authors().find(filter, this.o).sort({ slug: 1 }).toArray();
        return docs.map(d => strip(d) as unknown as StoredAuthor);
    }

    async deleteAuthor(slug: string, tenant = ''): Promise<boolean> {
        return (await this.authors().deleteOne({ tenant, slug }, this.o)).deletedCount > 0;
    }

    async upsertCategory(category: StoredCategory): Promise<StoredCategory> {
        const tenant = category.tenant ?? '';
        await this.categories().updateOne(
            { tenant, kind: category.kind, slug: category.slug },
            { $set: { ...category, tenant } },
            this.opts({ upsert: true }),
        );
        return (await this.getCategory(category.kind, category.slug, tenant))!;
    }

    async getCategory(kind: string, slug: string, tenant = ''): Promise<StoredCategory | null> {
        const doc = await this.categories().findOne({ tenant, kind, slug }, this.o);
        return doc ? (strip(doc) as unknown as StoredCategory) : null;
    }

    async listCategories(kind: string, options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredCategory[]> {
        const filter: Doc = { tenant: options.tenant ?? '', kind };
        if (options.enabledOnly) filter.enabled = true;
        const docs = await this.categories().find(filter, this.o).sort({ sortOrder: 1, slug: 1 }).toArray();
        return docs.map(d => strip(d) as unknown as StoredCategory);
    }

    async deleteCategory(kind: string, slug: string, tenant = ''): Promise<boolean> {
        return (await this.categories().deleteOne({ tenant, kind, slug }, this.o)).deletedCount > 0;
    }

    async listFolders(tenant = ''): Promise<StoredFolder[]> {
        const docs = await this.folders().find({ tenant }, this.o).sort({ sortOrder: 1, name: 1, id: 1 }).toArray();
        return docs.map(d => strip(d) as unknown as StoredFolder);
    }

    async saveFolder(folder: StoredFolder): Promise<StoredFolder> {
        const tenant = folder.tenant ?? '';
        const doc = { ...folder, tenant, parentId: folder.parentId ?? null };
        const conflicts: Array<[string[], ConflictTarget]> = [[['tenant', 'parentId', 'segment'], 'folder_sibling']];
        const existing = await this.folders().findOne({ tenant, id: folder.id }, this.o);
        if (existing) await this.guard(this.folders().updateOne({ tenant, id: folder.id }, { $set: doc }, this.o), conflicts);
        else await this.guard(this.folders().insertOne(doc, this.o), conflicts);
        return folder;
    }

    async deleteFolder(id: string, tenant = ''): Promise<boolean> {
        return (await this.folders().deleteOne({ tenant, id }, this.o)).deletedCount > 0;
    }

    async recordFormerSlug(slug: string, pageId: string, tenant = ''): Promise<void> {
        await this.slugHistory().updateOne(
            { tenant, slug },
            { $set: { tenant, slug, pageId, createdAt: new Date() }, $unset: { currentSlug: '' } },
            this.opts({ upsert: true }),
        );
    }

    async resolveFormerSlug(slug: string, tenant = ''): Promise<string | null> {
        const doc = await this.slugHistory().findOne({ tenant, slug }, this.o);
        return doc?.pageId ? String(doc.pageId) : null;
    }

    async releaseFormerSlug(slug: string, tenant = ''): Promise<void> {
        await this.slugHistory().deleteOne({ tenant, slug }, this.o);
    }

    async deleteSlugHistory(pageId: string, tenant = ''): Promise<void> {
        await this.slugHistory().deleteMany({ tenant, pageId }, this.o);
    }

    async findPageByRole(role: string, tenant = ''): Promise<StoredPage | null> {
        const doc = await this.pages().findOne({ tenant, role }, this.o);
        return doc ? docToPage(doc) : null;
    }

    async setRole(id: string, role: string | null, tenant = ''): Promise<void> {
        await this.guard(this.pages().updateOne({ tenant, id }, { $set: { role, updatedAt: new Date() } }, this.o), this.pageConflicts());
    }

    async listPagesWithRole(tenant = ''): Promise<StoredPage[]> {
        const docs = await this.pages()
            .find({ tenant, role: { $type: 'string' } }, this.o)
            .sort({ role: 1 })
            .toArray();
        return docs.map(docToPage);
    }

    async createComment(comment: StoredComment): Promise<StoredComment> {
        await this.guard(this.comments().insertOne({ ...comment, tenant: comment.tenant ?? '' }, this.o), [[['tenant', 'id'], 'comment_id']]);
        return (await this.getComment(comment.id, comment.tenant ?? ''))!;
    }

    async getComment(id: string, tenant = ''): Promise<StoredComment | null> {
        const doc = await this.comments().findOne({ tenant, id }, this.o);
        return doc ? docToComment(doc) : null;
    }

    async listComments(query: CommentListQuery): Promise<{ rows: StoredComment[]; pagination: PaginationMeta }> {
        const filter: Doc = { tenant: query.tenant ?? '' };
        if (query.pageId !== undefined) filter.pageId = query.pageId;
        if (query.status) filter.status = query.status;
        if (query.rating !== undefined) filter.rating = query.rating;
        if (query.search && query.search.trim()) {
            const regex = new RegExp(escapeRegex(query.search.trim()), 'i');
            filter.$or = [{ content: regex }, { authorName: regex }, { authorEmail: regex }];
        }
        const page = clampPage(query.page);
        const pageSize = Math.max(1, Math.floor(Number(query.pageSize) || 1));
        const total = await this.comments().countDocuments(filter, this.o);
        const docs = await this.comments()
            .find(filter, this.o)
            .sort(Object.fromEntries(query.order.map(o => [o.field, o.direction === 'asc' ? 1 : -1])))
            .skip(pageOffset(page, pageSize))
            .limit(pageSize)
            .toArray();
        return { rows: docs.map(docToComment), pagination: paginationMeta(total, page, pageSize) };
    }

    async setCommentStatus(id: string, status: CommentStatus, moderatedBy: string | null, tenant = ''): Promise<StoredComment | null> {
        await this.comments().updateOne({ tenant, id }, { $set: { status, moderatedBy, moderatedAt: new Date() } }, this.o);
        return this.getComment(id, tenant);
    }

    async deleteComment(id: string, tenant = ''): Promise<boolean> {
        return (await this.comments().deleteOne({ tenant, id }, this.o)).deletedCount > 0;
    }

    async deleteCommentsByPage(pageId: string, tenant = ''): Promise<number> {
        return (await this.comments().deleteMany({ tenant, pageId }, this.o)).deletedCount;
    }

    async aggregateApprovedRatings(pageIds: readonly string[], tenant = ''): Promise<Array<{ pageId: string; count: number; sum: number }>> {
        if (!pageIds.length) return [];
        const rows = await this.comments()
            .aggregate(
                [
                    { $match: { tenant, pageId: { $in: [...new Set(pageIds)] }, status: 'approved', rating: { $ne: null } } },
                    { $group: { _id: '$pageId', count: { $sum: 1 }, sum: { $sum: '$rating' } } },
                    { $sort: { _id: 1 } },
                ],
                this.o,
            )
            .toArray();
        return rows.map(r => ({ pageId: String(r._id), count: Number(r.count), sum: Number(r.sum) }));
    }
}
