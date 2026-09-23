import { clampPage, paginationMeta, pageOffset, PaginationMeta } from '../pagination.js';
import {
    CommentListQuery,
    ConflictTarget,
    PageFilter,
    PageListQuery,
    PageListResult,
    PageOrder,
    PagePatch,
    PageProjection,
    PageStore,
    SchemaFeatures,
    StoreConflictError,
    StoredAuthor,
    StoredCategory,
    StoredPage,
} from '../store.js';
import { StoredFolder } from '../addressing.js';
import { CommentStatus, StoredComment } from '../comments.js';
import {
    authorToRow,
    categoryToRow,
    COMMENT_SORT_COLUMNS,
    commentToRow,
    folderToRow,
    INDEX_PROJECTION_COLUMNS,
    likePattern,
    PAGE_SORT_COLUMNS,
    pageToRow,
    patchToColumns,
    rowToAuthor,
    rowToCategory,
    rowToComment,
    rowToFolder,
    rowToPage,
    TableNames,
} from './sql-common.js';

export type Row = Record<string, unknown>;

export interface SqlExecutor {
    rows(sql: string, params?: unknown[]): Promise<Row[]>;
    run(sql: string, params?: unknown[]): Promise<number>;
}

export interface SqlDialect {
    ilike(expr: string): string;
    jsonText(column: string): string;
    jsonKey(lang: string): string;
    nulls(direction: 'asc' | 'desc'): string;
    upsert(table: string, columns: string[], key: string[], update: string[]): string;
    conflictTarget(error: unknown, t: TableNames): ConflictTarget | null;
    columnsQuery: string;
}

export interface ColumnCache {
    pages?: Promise<Set<string>>;
}

class Where {
    readonly parts: string[] = [];
    readonly params: unknown[] = [];

    add(sql: string, ...params: unknown[]): this {
        this.parts.push(sql);
        this.params.push(...params);
        return this;
    }

    in(column: string, values: readonly unknown[]): this {
        if (!values.length) return this.add('1 = 0');
        return this.add(`${column} IN (${values.map(() => '?').join(', ')})`, ...values);
    }

    sql(): string {
        return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
    }
}

function limitOffset(page: number, pageSize: number): { page: number; pageSize: number; sql: string } {
    const size = Math.max(1, Math.floor(Number(pageSize) || 1));
    const current = clampPage(page);
    return { page: current, pageSize: size, sql: `LIMIT ${size} OFFSET ${pageOffset(current, size)}` };
}

export abstract class SqlPageStore implements PageStore {
    protected constructor(
        protected readonly db: SqlExecutor,
        protected readonly dialect: SqlDialect,
        protected readonly t: TableNames,
        protected readonly columns: ColumnCache,
    ) {}

    abstract ensureSchema(features?: SchemaFeatures): Promise<void>;
    abstract close(): Promise<void>;
    abstract transaction<T>(fn: (tx: PageStore) => Promise<T>): Promise<T>;

    protected forgetColumns(): void {
        this.columns.pages = undefined;
    }

    protected pageColumns(): Promise<Set<string>> {
        this.columns.pages ??= this.db
            .rows(this.dialect.columnsQuery, [this.t.pages])
            .then(rows => new Set(rows.map(r => String(r.c ?? r.C ?? r.COLUMN_NAME).toLowerCase())))
            .catch(error => {
                this.columns.pages = undefined;
                throw error;
            });
        return this.columns.pages;
    }

    protected async guard<T>(work: Promise<T>): Promise<T> {
        try {
            return await work;
        } catch (error) {
            const target = this.dialect.conflictTarget(error, this.t);
            if (target) throw new StoreConflictError(target, (error as Error).message);
            throw error;
        }
    }

    private async selectList(projection: PageProjection = 'full'): Promise<string> {
        if (projection === 'full') return '*';
        const have = await this.pageColumns();
        const wanted = projection === 'index' ? INDEX_PROJECTION_COLUMNS : [...have].filter(c => c !== 'data');
        return wanted.filter(c => have.has(c)).join(', ');
    }

    private orderSql(order: readonly PageOrder[]): string {
        if (!order.length) return '';
        const parts = order.map(o => {
            const column = PAGE_SORT_COLUMNS[o.field];
            if (!column) throw new Error(`Unknown sort field: ${o.field}`);
            const direction = o.direction === 'asc' ? 'ASC' : 'DESC';
            return `${column} ${direction}${this.dialect.nulls(o.direction)}`;
        });
        return `ORDER BY ${parts.join(', ')}`;
    }

    private pageWhere(filter: PageFilter): Where {
        const w = new Where().add('tenant = ?', filter.tenant ?? '');
        if (filter.types) w.in('type', filter.types);
        if (filter.status) w.add('status = ?', filter.status);
        if (filter.category !== undefined) w.add('category = ?', filter.category);
        if (filter.hasCategory !== undefined) w.add(filter.hasCategory ? 'category IS NOT NULL' : 'category IS NULL');
        if (filter.authorSlug !== undefined) w.add('author_slug = ?', filter.authorSlug);
        if (filter.pinned !== undefined) w.add('pinned = ?', filter.pinned);
        if (filter.folderId !== undefined) {
            if (filter.folderId === null) w.add('folder_id IS NULL');
            else w.add('folder_id = ?', filter.folderId);
        }
        if (filter.folderIds) {
            const ids = filter.folderIds.filter((id): id is string => id !== null);
            const root = filter.folderIds.includes(null);
            const parts: string[] = [];
            if (ids.length) parts.push(`folder_id IN (${ids.map(() => '?').join(', ')})`);
            if (root) parts.push('folder_id IS NULL');
            w.add(parts.length ? `(${parts.join(' OR ')})` : '1 = 0', ...ids);
        }
        if (filter.ids) w.in('id', filter.ids);
        if (filter.search && filter.search.term.trim()) {
            const pattern = likePattern(filter.search.term.trim());
            const parts: string[] = [];
            const params: unknown[] = [];
            for (const column of filter.search.columns) {
                parts.push(this.dialect.ilike(column));
                params.push(pattern);
            }
            for (const field of filter.search.mlt) {
                const column = field === 'titleMlt' ? 'title_mlt' : 'annotation';
                for (const lang of filter.search.langs) {
                    parts.push(this.dialect.ilike(this.dialect.jsonText(column)));
                    params.push(this.dialect.jsonKey(lang), pattern);
                }
            }
            if (parts.length) w.add(`(${parts.join(' OR ')})`, ...params);
        }
        return w;
    }

    async getPageById(id: string, tenant = '', projection: PageProjection = 'full'): Promise<StoredPage | null> {
        const rows = await this.db.rows(
            `SELECT ${await this.selectList(projection)} FROM ${this.t.pages} WHERE tenant = ? AND id = ?`,
            [tenant, id],
        );
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async getPageBySlug(slug: string, tenant = '', projection: PageProjection = 'full'): Promise<StoredPage | null> {
        const rows = await this.db.rows(
            `SELECT ${await this.selectList(projection)} FROM ${this.t.pages} WHERE tenant = ? AND slug = ?`,
            [tenant, slug],
        );
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async getPagesByIds(ids: readonly string[], tenant = '', projection: PageProjection = 'full'): Promise<StoredPage[]> {
        if (!ids.length) return [];
        const w = new Where().add('tenant = ?', tenant).in('id', [...new Set(ids)]);
        const rows = await this.db.rows(`SELECT ${await this.selectList(projection)} FROM ${this.t.pages} ${w.sql()}`, w.params);
        return rows.map(rowToPage);
    }

    async createPage(record: StoredPage): Promise<StoredPage> {
        const have = await this.pageColumns();
        const row = Object.entries(pageToRow(record)).filter(([col, value]) => have.has(col) || value !== null);
        const cols = row.map(([col]) => col);
        await this.guard(
            this.db.run(
                `INSERT INTO ${this.t.pages} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                row.map(([, value]) => value),
            ),
        );
        return (await this.getPageById(record.id, record.tenant ?? ''))!;
    }

    async updatePage(id: string, patch: PagePatch, tenant = ''): Promise<StoredPage | null> {
        const entries = patchToColumns(patch);
        if (entries.length) {
            const sets = entries.map(([col]) => `${col} = ?`).join(', ');
            await this.guard(
                this.db.run(`UPDATE ${this.t.pages} SET ${sets}, updated_at = CURRENT_TIMESTAMP(3) WHERE tenant = ? AND id = ?`, [
                    ...entries.map(([, value]) => value),
                    tenant,
                    id,
                ]),
            );
        }
        return this.getPageById(id, tenant);
    }

    async deletePage(id: string, tenant = ''): Promise<boolean> {
        return (await this.db.run(`DELETE FROM ${this.t.pages} WHERE tenant = ? AND id = ?`, [tenant, id])) > 0;
    }

    async listPages(query: PageListQuery): Promise<PageListResult> {
        const w = this.pageWhere(query);
        const { page, pageSize, sql: limit } = limitOffset(query.page, query.pageSize);
        const [countRows, rows] = await Promise.all([
            this.db.rows(`SELECT COUNT(*) AS c FROM ${this.t.pages} ${w.sql()}`, w.params),
            this.db.rows(
                `SELECT ${await this.selectList(query.projection)} FROM ${this.t.pages} ${w.sql()} ${this.orderSql(query.order)} ${limit}`,
                w.params,
            ),
        ]);
        return { rows: rows.map(rowToPage), pagination: paginationMeta(Number(countRows[0]?.c ?? 0), page, pageSize) };
    }

    async countPages(filter: PageFilter): Promise<number> {
        const w = this.pageWhere(filter);
        const rows = await this.db.rows(`SELECT COUNT(*) AS c FROM ${this.t.pages} ${w.sql()}`, w.params);
        return Number(rows[0]?.c ?? 0);
    }

    async upsertAuthor(author: StoredAuthor): Promise<StoredAuthor> {
        const row = authorToRow(author);
        const cols = Object.keys(row);
        await this.db.run(this.dialect.upsert(this.t.authors, cols, ['tenant', 'slug'], ['name', 'role', 'photo', 'enabled']), Object.values(row));
        return (await this.getAuthor(author.slug, author.tenant ?? ''))!;
    }

    async getAuthor(slug: string, tenant = ''): Promise<StoredAuthor | null> {
        const rows = await this.db.rows(`SELECT * FROM ${this.t.authors} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
        return rows[0] ? rowToAuthor(rows[0]) : null;
    }

    async getAuthorsBySlugs(slugs: readonly string[], tenant = ''): Promise<StoredAuthor[]> {
        if (!slugs.length) return [];
        const w = new Where().add('tenant = ?', tenant).in('slug', [...new Set(slugs)]);
        const rows = await this.db.rows(`SELECT * FROM ${this.t.authors} ${w.sql()} ORDER BY slug`, w.params);
        return rows.map(rowToAuthor);
    }

    async listAuthors(options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredAuthor[]> {
        const enabled = options.enabledOnly ? 'AND enabled = ?' : '';
        const params: unknown[] = [options.tenant ?? ''];
        if (options.enabledOnly) params.push(true);
        const rows = await this.db.rows(`SELECT * FROM ${this.t.authors} WHERE tenant = ? ${enabled} ORDER BY slug`, params);
        return rows.map(rowToAuthor);
    }

    async deleteAuthor(slug: string, tenant = ''): Promise<boolean> {
        return (await this.db.run(`DELETE FROM ${this.t.authors} WHERE tenant = ? AND slug = ?`, [tenant, slug])) > 0;
    }

    async upsertCategory(category: StoredCategory): Promise<StoredCategory> {
        const row = categoryToRow(category);
        await this.db.run(
            this.dialect.upsert(this.t.categories, Object.keys(row), ['tenant', 'kind', 'slug'], ['name', 'sort_order', 'enabled']),
            Object.values(row),
        );
        return (await this.getCategory(category.kind, category.slug, category.tenant ?? ''))!;
    }

    async getCategory(kind: string, slug: string, tenant = ''): Promise<StoredCategory | null> {
        const rows = await this.db.rows(`SELECT * FROM ${this.t.categories} WHERE tenant = ? AND kind = ? AND slug = ?`, [
            tenant,
            kind,
            slug,
        ]);
        return rows[0] ? rowToCategory(rows[0]) : null;
    }

    async listCategories(kind: string, options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredCategory[]> {
        const enabled = options.enabledOnly ? 'AND enabled = ?' : '';
        const params: unknown[] = [options.tenant ?? '', kind];
        if (options.enabledOnly) params.push(true);
        const rows = await this.db.rows(
            `SELECT * FROM ${this.t.categories} WHERE tenant = ? AND kind = ? ${enabled} ORDER BY sort_order, slug`,
            params,
        );
        return rows.map(rowToCategory);
    }

    async deleteCategory(kind: string, slug: string, tenant = ''): Promise<boolean> {
        return (await this.db.run(`DELETE FROM ${this.t.categories} WHERE tenant = ? AND kind = ? AND slug = ?`, [tenant, kind, slug])) > 0;
    }

    async listFolders(tenant = ''): Promise<StoredFolder[]> {
        const rows = await this.db.rows(`SELECT * FROM ${this.t.folders} WHERE tenant = ? ORDER BY sort_order, name, id`, [tenant]);
        return rows.map(rowToFolder);
    }

    async saveFolder(folder: StoredFolder): Promise<StoredFolder> {
        const row = folderToRow(folder);
        const existing = await this.db.rows(`SELECT id FROM ${this.t.folders} WHERE tenant = ? AND id = ?`, [row.tenant, row.id]);
        if (existing.length) {
            const fields = ['parent_id', 'name', 'name_mlt', 'segment', 'sort_order'];
            await this.guard(
                this.db.run(`UPDATE ${this.t.folders} SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE tenant = ? AND id = ?`, [
                    ...fields.map(f => row[f]),
                    row.tenant,
                    row.id,
                ]),
            );
        } else {
            const cols = Object.keys(row);
            await this.guard(
                this.db.run(`INSERT INTO ${this.t.folders} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row)),
            );
        }
        return folder;
    }

    async deleteFolder(id: string, tenant = ''): Promise<boolean> {
        return (await this.db.run(`DELETE FROM ${this.t.folders} WHERE tenant = ? AND id = ?`, [tenant, id])) > 0;
    }

    async recordFormerSlug(slug: string, pageId: string, tenant = ''): Promise<void> {
        await this.db.run(this.dialect.upsert(this.t.slugHistory, ['slug', 'tenant', 'page_id'], ['tenant', 'slug'], ['page_id']), [
            slug,
            tenant,
            pageId,
        ]);
    }

    async resolveFormerSlug(slug: string, tenant = ''): Promise<string | null> {
        const rows = await this.db.rows(`SELECT page_id FROM ${this.t.slugHistory} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
        const id = rows[0]?.page_id;
        return id === null || id === undefined ? null : String(id);
    }

    async releaseFormerSlug(slug: string, tenant = ''): Promise<void> {
        await this.db.run(`DELETE FROM ${this.t.slugHistory} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
    }

    async deleteSlugHistory(pageId: string, tenant = ''): Promise<void> {
        await this.db.run(`DELETE FROM ${this.t.slugHistory} WHERE tenant = ? AND page_id = ?`, [tenant, pageId]);
    }

    async findPageByRole(role: string, tenant = ''): Promise<StoredPage | null> {
        const rows = await this.db.rows(`SELECT * FROM ${this.t.pages} WHERE tenant = ? AND role = ?`, [tenant, role]);
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async setRole(id: string, role: string | null, tenant = ''): Promise<void> {
        await this.guard(
            this.db.run(`UPDATE ${this.t.pages} SET role = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE tenant = ? AND id = ?`, [role, tenant, id]),
        );
    }

    async listPagesWithRole(tenant = ''): Promise<StoredPage[]> {
        const rows = await this.db.rows(`SELECT * FROM ${this.t.pages} WHERE tenant = ? AND role IS NOT NULL ORDER BY role`, [tenant]);
        return rows.map(rowToPage);
    }

    async createComment(comment: StoredComment): Promise<StoredComment> {
        const row = commentToRow(comment);
        const cols = Object.keys(row);
        await this.guard(
            this.db.run(`INSERT INTO ${this.t.comments} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row)),
        );
        return (await this.getComment(comment.id, comment.tenant ?? ''))!;
    }

    async getComment(id: string, tenant = ''): Promise<StoredComment | null> {
        const rows = await this.db.rows(`SELECT * FROM ${this.t.comments} WHERE tenant = ? AND id = ?`, [tenant, id]);
        return rows[0] ? rowToComment(rows[0]) : null;
    }

    async listComments(query: CommentListQuery): Promise<{ rows: StoredComment[]; pagination: PaginationMeta }> {
        const w = new Where().add('tenant = ?', query.tenant ?? '');
        if (query.pageId !== undefined) w.add('page_id = ?', query.pageId);
        if (query.status) w.add('status = ?', query.status);
        if (query.rating !== undefined) w.add('rating = ?', query.rating);
        if (query.search && query.search.trim()) {
            const pattern = likePattern(query.search.trim());
            w.add(
                `(${['content', 'author_name', 'author_email'].map(c => this.dialect.ilike(c)).join(' OR ')})`,
                pattern,
                pattern,
                pattern,
            );
        }
        const order = query.order.map(o => {
            const column = COMMENT_SORT_COLUMNS[o.field];
            if (!column) throw new Error(`Unknown comment sort field: ${o.field}`);
            return `${column} ${o.direction === 'asc' ? 'ASC' : 'DESC'}${this.dialect.nulls(o.direction)}`;
        });
        const { page, pageSize, sql: limit } = limitOffset(query.page, query.pageSize);
        const [countRows, rows] = await Promise.all([
            this.db.rows(`SELECT COUNT(*) AS c FROM ${this.t.comments} ${w.sql()}`, w.params),
            this.db.rows(
                `SELECT * FROM ${this.t.comments} ${w.sql()} ${order.length ? `ORDER BY ${order.join(', ')}` : ''} ${limit}`,
                w.params,
            ),
        ]);
        return { rows: rows.map(rowToComment), pagination: paginationMeta(Number(countRows[0]?.c ?? 0), page, pageSize) };
    }

    async setCommentStatus(id: string, status: CommentStatus, moderatedBy: string | null, tenant = ''): Promise<StoredComment | null> {
        await this.db.run(
            `UPDATE ${this.t.comments} SET status = ?, moderated_by = ?, moderated_at = CURRENT_TIMESTAMP(3) WHERE tenant = ? AND id = ?`,
            [status, moderatedBy, tenant, id],
        );
        return this.getComment(id, tenant);
    }

    async deleteComment(id: string, tenant = ''): Promise<boolean> {
        return (await this.db.run(`DELETE FROM ${this.t.comments} WHERE tenant = ? AND id = ?`, [tenant, id])) > 0;
    }

    async deleteCommentsByPage(pageId: string, tenant = ''): Promise<number> {
        return this.db.run(`DELETE FROM ${this.t.comments} WHERE tenant = ? AND page_id = ?`, [tenant, pageId]);
    }

    async aggregateApprovedRatings(pageIds: readonly string[], tenant = ''): Promise<Array<{ pageId: string; count: number; sum: number }>> {
        if (!pageIds.length) return [];
        const w = new Where()
            .add('tenant = ?', tenant)
            .in('page_id', [...new Set(pageIds)])
            .add('status = ?', 'approved')
            .add('rating IS NOT NULL');
        const rows = await this.db.rows(
            `SELECT page_id, COUNT(*) AS n, SUM(rating) AS s FROM ${this.t.comments} ${w.sql()} GROUP BY page_id ORDER BY page_id`,
            w.params,
        );
        return rows.map(r => ({ pageId: String(r.page_id), count: Number(r.n), sum: Number(r.s) }));
    }
}
