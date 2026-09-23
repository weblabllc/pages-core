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
import { CommentListQuery, CommentStatus, StoredComment } from '../comments.js';
import {
    authorToRow,
    categoryToRow,
    commentToRow,
    folderToRow,
    pageToRow,
    patchToColumns,
    rowToAuthor,
    rowToCategory,
    rowToComment,
    rowToFolder,
    rowToPage,
    TableNames,
    tableNames,
} from './sql-common.js';

interface MysqlPool {
    query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
    end(): Promise<void>;
}

export class MysqlPageStore implements PageStore {
    private constructor(
        private pool: MysqlPool,
        private t: TableNames,
        private ownsPool: boolean,
    ) {}

    static async create(options: PageStoreOptions): Promise<MysqlPageStore> {
        const t = tableNames(options.tablePrefix ?? 'rl_');
        if (options.client) {
            return new MysqlPageStore(options.client as MysqlPool, t, false);
        }
        const mysql = await loadOptionalModule('mysql2/promise', 'the mysql page store');
        const pool = mysql.createPool(options.url);
        return new MysqlPageStore(pool, t, true);
    }

    private async rows(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
        const [rows] = await this.pool.query(sql, params);
        return rows as Array<Record<string, unknown>>;
    }

    private async exec(sql: string, params: unknown[] = []): Promise<{ affectedRows: number }> {
        const [result] = await this.pool.query(sql, params);
        return result as { affectedRows: number };
    }

    async ensureSchema(features: SchemaFeatures = {}): Promise<void> {
        const { pages = true, authors = false, categories = false, folders = false, roles = false, comments = false } = features;
        if (pages) {
            await this.exec(`CREATE TABLE IF NOT EXISTS ${this.t.pages} (
                slug varchar(255) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                type varchar(32) NOT NULL DEFAULT 'page',
                status varchar(16) NOT NULL DEFAULT 'draft',
                title varchar(255) NULL,
                title_mlt json NULL,
                annotation json NULL,
                data json NULL,
                category varchar(64) NULL,
                pinned tinyint(1) NOT NULL DEFAULT 0,
                author_slug varchar(64) NULL,
                cover_image varchar(512) NULL,
                reading_time int NULL,
                published_at datetime NULL,
                created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (tenant, slug),
                KEY list_idx (tenant, type, status, published_at)
            )`);
        }
        if (authors) {
            await this.exec(`CREATE TABLE IF NOT EXISTS ${this.t.authors} (
                slug varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                name json NOT NULL,
                role json NULL,
                photo varchar(512) NULL,
                enabled tinyint(1) NOT NULL DEFAULT 1,
                PRIMARY KEY (tenant, slug)
            )`);
        }
        if (categories) {
            await this.exec(`CREATE TABLE IF NOT EXISTS ${this.t.categories} (
                slug varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                kind varchar(16) NOT NULL,
                name json NULL,
                sort_order int NOT NULL DEFAULT 0,
                enabled tinyint(1) NOT NULL DEFAULT 1,
                PRIMARY KEY (tenant, kind, slug)
            )`);
        }
        if (pages) {
            const existing = await this.rows(
                `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
                [this.t.pages],
            );
            const have = new Set(existing.map(r => String(r.c ?? r.COLUMN_NAME).toLowerCase()));
            if (!have.has('seo_title')) await this.exec(`ALTER TABLE ${this.t.pages} ADD COLUMN seo_title json NULL`);
            if (!have.has('seo_description')) await this.exec(`ALTER TABLE ${this.t.pages} ADD COLUMN seo_description json NULL`);
            if (!have.has('created_by')) await this.exec(`ALTER TABLE ${this.t.pages} ADD COLUMN created_by varchar(64) NULL`);
        }
        if (comments) {
            await this.exec(`CREATE TABLE IF NOT EXISTS ${this.t.comments} (
                id varchar(36) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                page_slug varchar(255) NOT NULL,
                user_id varchar(64) NULL,
                author_name varchar(120) NOT NULL,
                author_email varchar(255) NULL,
                content text NOT NULL,
                rating smallint NULL,
                status varchar(16) NOT NULL DEFAULT 'pending',
                moderated_by varchar(64) NULL,
                moderated_at datetime NULL,
                ip varchar(64) NULL,
                created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                PRIMARY KEY (tenant, id),
                KEY page_idx (tenant, page_slug, status, created_at),
                KEY queue_idx (tenant, status, created_at)
            )`);
        }
        if (roles) {
            const existing = await this.rows(
                `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
                [this.t.pages],
            );
            const have = new Set(existing.map(r => String(r.c ?? r.COLUMN_NAME).toLowerCase()));
            if (!have.has('role')) {
                await this.exec(`ALTER TABLE ${this.t.pages} ADD COLUMN role varchar(32) NULL, ADD UNIQUE KEY role_idx (tenant, role)`);
            }
        }
        if (folders) {
            const existing = await this.rows(
                `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
                [this.t.pages],
            );
            const have = new Set(existing.map(r => String(r.c ?? r.COLUMN_NAME).toLowerCase()));
            if (!have.has('folder_id')) {
                await this.exec(`ALTER TABLE ${this.t.pages} ADD COLUMN folder_id varchar(64) NULL, ADD KEY folder_idx (tenant, folder_id)`);
            }
            if (!have.has('segment')) await this.exec(`ALTER TABLE ${this.t.pages} ADD COLUMN segment varchar(255) NULL`);
            await this.exec(`CREATE TABLE IF NOT EXISTS ${this.t.folders} (
                id varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                parent_id varchar(64) NULL,
                name varchar(255) NOT NULL,
                name_mlt json NULL,
                segment varchar(64) NOT NULL,
                sort_order int NOT NULL DEFAULT 0,
                PRIMARY KEY (tenant, id)
            )`);
            await this.exec(`CREATE TABLE IF NOT EXISTS ${this.t.slugHistory} (
                slug varchar(255) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                current_slug varchar(255) NOT NULL,
                created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (tenant, slug)
            )`);
        }
    }

    async close(): Promise<void> {
        if (this.ownsPool) await this.pool.end();
    }

    async getPage(slug: string, tenant = ''): Promise<StoredPage | null> {
        const rows = await this.rows(`SELECT * FROM ${this.t.pages} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async createPage(record: StoredPage): Promise<StoredPage> {
        const row = pageToRow(record);
        const cols = Object.keys(row);
        await this.exec(
            `INSERT INTO ${this.t.pages} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            Object.values(row),
        );
        return (await this.getPage(record.slug, record.tenant ?? ''))!;
    }

    async updatePage(slug: string, patch: Partial<StoredPage>, tenant = ''): Promise<StoredPage | null> {
        const entries = patchToColumns(patch);
        if (!entries.length) return this.getPage(slug, tenant);
        const sets = entries.map(([col]) => `${col} = ?`).join(', ');
        await this.exec(
            `UPDATE ${this.t.pages} SET ${sets} WHERE tenant = ? AND slug = ?`,
            [...entries.map(([, v]) => v), tenant, slug],
        );
        return this.getPage(slug, tenant);
    }

    async deletePage(slug: string, tenant = ''): Promise<boolean> {
        const res = await this.exec(`DELETE FROM ${this.t.pages} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
        return res.affectedRows > 0;
    }

    async listPages(query: PageListQuery = {}): Promise<PageListResult> {
        const page = clampPage(query.page);
        const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 25;
        const where: string[] = ['tenant = ?'];
        const params: unknown[] = [query.tenant ?? ''];
        if (query.type) { where.push('type = ?'); params.push(query.type); }
        if (query.status) { where.push('status = ?'); params.push(query.status); }
        if (query.category) { where.push('category = ?'); params.push(query.category); }
        if (query.authorSlug) { where.push('author_slug = ?'); params.push(query.authorSlug); }
        if (query.pinned !== undefined) { where.push('pinned = ?'); params.push(query.pinned ? 1 : 0); }
        if (query.search) {
            where.push('(title LIKE ? OR slug LIKE ?)');
            params.push(`%${query.search}%`, `%${query.search}%`);
        }
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const countRows = await this.rows(`SELECT count(*) AS c FROM ${this.t.pages} ${whereSql}`, params);
        const total = Number(countRows[0]?.c ?? 0);
        const rows = await this.rows(
            `SELECT * FROM ${this.t.pages} ${whereSql}
             ORDER BY pinned DESC, published_at IS NULL, published_at DESC, updated_at DESC
             LIMIT ${pageSize} OFFSET ${pageOffset(page, pageSize)}`,
            params,
        );
        return { rows: rows.map(rowToPage), pagination: paginationMeta(total, page, pageSize) };
    }

    async upsertAuthor(author: StoredAuthor): Promise<StoredAuthor> {
        const row = authorToRow(author);
        await this.exec(
            `INSERT INTO ${this.t.authors} (slug, tenant, name, role, photo, enabled)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), photo = VALUES(photo), enabled = VALUES(enabled)`,
            [row.slug, row.tenant, row.name, row.role, row.photo, row.enabled],
        );
        return (await this.getAuthor(author.slug, author.tenant ?? ''))!;
    }

    async getAuthor(slug: string, tenant = ''): Promise<StoredAuthor | null> {
        const rows = await this.rows(`SELECT * FROM ${this.t.authors} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
        return rows[0] ? rowToAuthor(rows[0]) : null;
    }

    async listAuthors(options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredAuthor[]> {
        const enabled = options.enabledOnly ? 'AND enabled = 1' : '';
        const rows = await this.rows(
            `SELECT * FROM ${this.t.authors} WHERE tenant = ? ${enabled} ORDER BY slug`,
            [options.tenant ?? ''],
        );
        return rows.map(rowToAuthor);
    }

    async deleteAuthor(slug: string, tenant = ''): Promise<boolean> {
        const res = await this.exec(`DELETE FROM ${this.t.authors} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
        return res.affectedRows > 0;
    }

    async countPagesByAuthor(authorSlug: string, tenant = ''): Promise<number> {
        const rows = await this.rows(
            `SELECT count(*) AS c FROM ${this.t.pages} WHERE tenant = ? AND author_slug = ?`,
            [tenant, authorSlug],
        );
        return Number(rows[0]?.c ?? 0);
    }

    async upsertCategory(category: StoredCategory): Promise<StoredCategory> {
        const row = categoryToRow(category);
        await this.exec(
            `INSERT INTO ${this.t.categories} (slug, tenant, kind, name, sort_order, enabled)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order), enabled = VALUES(enabled)`,
            [row.slug, row.tenant, row.kind, row.name, row.sort_order, row.enabled],
        );
        return category;
    }

    async listCategories(kind: string, options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredCategory[]> {
        const enabled = options.enabledOnly ? 'AND enabled = 1' : '';
        const rows = await this.rows(
            `SELECT * FROM ${this.t.categories} WHERE tenant = ? AND kind = ? ${enabled} ORDER BY sort_order, slug`,
            [options.tenant ?? '', kind],
        );
        return rows.map(rowToCategory);
    }

    async deleteCategory(kind: string, slug: string, tenant = ''): Promise<boolean> {
        const res = await this.exec(
            `DELETE FROM ${this.t.categories} WHERE tenant = ? AND kind = ? AND slug = ?`,
            [tenant, kind, slug],
        );
        return res.affectedRows > 0;
    }

    async listFolders(tenant = ''): Promise<StoredFolder[]> {
        const rows = await this.rows(`SELECT * FROM ${this.t.folders} WHERE tenant = ? ORDER BY sort_order, name`, [tenant]);
        return rows.map(rowToFolder);
    }

    async saveFolder(folder: StoredFolder): Promise<StoredFolder> {
        const row = folderToRow(folder);
        await this.exec(
            `INSERT INTO ${this.t.folders} (id, tenant, parent_id, name, name_mlt, segment, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), name_mlt = VALUES(name_mlt),
                 segment = VALUES(segment), sort_order = VALUES(sort_order)`,
            [row.id, row.tenant, row.parent_id, row.name, row.name_mlt, row.segment, row.sort_order],
        );
        return folder;
    }

    async deleteFolder(id: string, tenant = ''): Promise<boolean> {
        const res = await this.exec(`DELETE FROM ${this.t.folders} WHERE tenant = ? AND id = ?`, [tenant, id]);
        return res.affectedRows > 0;
    }

    async listPagesInFolders(folderIds: ReadonlyArray<string | null>, tenant = ''): Promise<StoredPage[]> {
        const ids = folderIds.filter((id): id is string => id !== null);
        const includeRoot = folderIds.includes(null);
        const conditions: string[] = [];
        const params: unknown[] = [tenant];
        if (ids.length) {
            conditions.push(`folder_id IN (${ids.map(() => '?').join(', ')})`);
            params.push(...ids);
        }
        if (includeRoot) conditions.push('folder_id IS NULL');
        if (!conditions.length) return [];
        const rows = await this.rows(
            `SELECT * FROM ${this.t.pages} WHERE tenant = ? AND (${conditions.join(' OR ')})`,
            params,
        );
        return rows.map(rowToPage);
    }

    async renamePage(from: string, to: string, tenant = ''): Promise<void> {
        if (from === to) return;
        await this.exec(`DELETE FROM ${this.t.slugHistory} WHERE tenant = ? AND slug = ?`, [tenant, to]);
        await this.exec(`UPDATE ${this.t.pages} SET slug = ? WHERE tenant = ? AND slug = ?`, [to, tenant, from]);
        await this.exec(`UPDATE ${this.t.slugHistory} SET current_slug = ? WHERE tenant = ? AND current_slug = ?`, [to, tenant, from]);
        await this.exec(
            `INSERT INTO ${this.t.slugHistory} (slug, tenant, current_slug) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE current_slug = VALUES(current_slug)`,
            [from, tenant, to],
        );
        await this.exec(`UPDATE ${this.t.comments} SET page_slug = ? WHERE tenant = ? AND page_slug = ?`, [to, tenant, from]).catch(
            (error: { code?: string }) => {
                if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
            },
        );
    }

    async findPageByRole(role: string, tenant = ''): Promise<StoredPage | null> {
        const rows = await this.rows(`SELECT * FROM ${this.t.pages} WHERE tenant = ? AND role = ?`, [tenant, role]);
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async setRole(slug: string, role: string | null, tenant = ''): Promise<void> {
        await this.exec(`UPDATE ${this.t.pages} SET role = ? WHERE tenant = ? AND slug = ?`, [role, tenant, slug]);
    }

    async listPagesWithRole(tenant = ''): Promise<StoredPage[]> {
        const rows = await this.rows(`SELECT * FROM ${this.t.pages} WHERE tenant = ? AND role IS NOT NULL ORDER BY role`, [tenant]);
        return rows.map(rowToPage);
    }

    async resolveFormerSlug(slug: string, tenant = ''): Promise<string | null> {
        const rows = await this.rows(
            `SELECT current_slug FROM ${this.t.slugHistory} WHERE tenant = ? AND slug = ?`,
            [tenant, slug],
        );
        return rows[0] ? String(rows[0].current_slug) : null;
    }

    async releaseFormerSlug(slug: string, tenant = ''): Promise<void> {
        await this.exec(`DELETE FROM ${this.t.slugHistory} WHERE tenant = ? AND slug = ?`, [tenant, slug]);
    }

    async createComment(comment: StoredComment): Promise<StoredComment> {
        const row = commentToRow(comment);
        const cols = Object.keys(row);
        await this.exec(
            `INSERT INTO ${this.t.comments} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            Object.values(row),
        );
        return (await this.getComment(comment.id, comment.tenant))!;
    }

    async getComment(id: string, tenant = ''): Promise<StoredComment | null> {
        const rows = await this.rows(`SELECT * FROM ${this.t.comments} WHERE tenant = ? AND id = ?`, [tenant, id]);
        return rows[0] ? rowToComment(rows[0]) : null;
    }

    async listComments(query: CommentListQuery = {}) {
        const page = clampPage(query.page);
        const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 25;
        const params: unknown[] = [query.tenant ?? ''];
        const where = ['tenant = ?'];
        if (query.pageSlug) {
            params.push(query.pageSlug);
            where.push('page_slug = ?');
        }
        if (query.status) {
            params.push(query.status);
            where.push('status = ?');
        }
        const clause = where.join(' AND ');
        const countRows = await this.rows(`SELECT count(*) AS n FROM ${this.t.comments} WHERE ${clause}`, params);
        const rows = await this.rows(
            `SELECT * FROM ${this.t.comments} WHERE ${clause} ORDER BY created_at DESC, id DESC
             LIMIT ${pageSize} OFFSET ${pageOffset(page, pageSize)}`,
            params,
        );
        return { rows: rows.map(rowToComment), pagination: paginationMeta(Number(countRows[0].n), page, pageSize) };
    }

    async setCommentStatus(id: string, status: CommentStatus, moderatedBy: string | null, tenant = ''): Promise<StoredComment | null> {
        await this.exec(
            `UPDATE ${this.t.comments} SET status = ?, moderated_by = ?, moderated_at = CURRENT_TIMESTAMP WHERE tenant = ? AND id = ?`,
            [status, moderatedBy, tenant, id],
        );
        return this.getComment(id, tenant);
    }

    async deleteComment(id: string, tenant = ''): Promise<boolean> {
        const res = await this.exec(`DELETE FROM ${this.t.comments} WHERE tenant = ? AND id = ?`, [tenant, id]);
        return res.affectedRows > 0;
    }

    async listApprovedRatings(pageSlugs: readonly string[], tenant = ''): Promise<Array<{ pageSlug: string; rating: number }>> {
        if (!pageSlugs.length) return [];
        const rows = await this.rows(
            `SELECT page_slug, rating FROM ${this.t.comments}
             WHERE tenant = ? AND page_slug IN (${pageSlugs.map(() => '?').join(', ')}) AND status = 'approved' AND rating IS NOT NULL`,
            [tenant, ...pageSlugs],
        );
        return rows.map(r => ({ pageSlug: String(r.page_slug), rating: Number(r.rating) }));
    }
}
