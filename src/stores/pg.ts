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
import {
    authorToRow,
    categoryToRow,
    folderToRow,
    pageToRow,
    patchToColumns,
    rowToAuthor,
    rowToCategory,
    rowToFolder,
    rowToPage,
    TableNames,
    tableNames,
} from './sql-common.js';

interface PgPool {
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
    end(): Promise<void>;
}

export class PgPageStore implements PageStore {
    private constructor(
        private pool: PgPool,
        private t: TableNames,
        private ownsPool: boolean,
    ) {}

    static async create(options: PageStoreOptions): Promise<PgPageStore> {
        const t = tableNames(options.tablePrefix ?? 'rl_');
        if (options.client) {
            return new PgPageStore(options.client as PgPool, t, false);
        }
        const pg = await loadOptionalModule('pg', 'the postgres page store');
        const pool = new pg.Pool({ connectionString: options.url });
        return new PgPageStore(pool, t, true);
    }

    async ensureSchema(features: SchemaFeatures = {}): Promise<void> {
        const { pages = true, authors = false, categories = false, folders = false, roles = false } = features;
        if (pages) {
            await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.t.pages} (
                slug varchar(255) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                type varchar(32) NOT NULL DEFAULT 'page',
                status varchar(16) NOT NULL DEFAULT 'draft',
                title varchar(255),
                title_mlt jsonb,
                annotation jsonb,
                data jsonb NOT NULL DEFAULT 'null'::jsonb,
                category varchar(64),
                pinned boolean NOT NULL DEFAULT false,
                author_slug varchar(64),
                cover_image varchar(512),
                reading_time integer,
                published_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (tenant, slug)
            )`);
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS ${this.t.pages}_list_idx ON ${this.t.pages} (tenant, type, status, published_at DESC)`,
            );
            await this.pool.query(`ALTER TABLE ${this.t.pages} ADD COLUMN IF NOT EXISTS seo_title jsonb`);
            await this.pool.query(`ALTER TABLE ${this.t.pages} ADD COLUMN IF NOT EXISTS seo_description jsonb`);
        }
        if (authors) {
            await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.t.authors} (
                slug varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                name jsonb NOT NULL,
                role jsonb,
                photo varchar(512),
                enabled boolean NOT NULL DEFAULT true,
                PRIMARY KEY (tenant, slug)
            )`);
        }
        if (categories) {
            await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.t.categories} (
                slug varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                kind varchar(16) NOT NULL,
                name jsonb,
                sort_order integer NOT NULL DEFAULT 0,
                enabled boolean NOT NULL DEFAULT true,
                PRIMARY KEY (tenant, kind, slug)
            )`);
        }
        if (roles) {
            await this.pool.query(`ALTER TABLE ${this.t.pages} ADD COLUMN IF NOT EXISTS role varchar(32)`);
            await this.pool.query(
                `CREATE UNIQUE INDEX IF NOT EXISTS ${this.t.pages}_role_idx ON ${this.t.pages} (tenant, role) WHERE role IS NOT NULL`,
            );
        }
        if (folders) {
            await this.pool.query(`ALTER TABLE ${this.t.pages} ADD COLUMN IF NOT EXISTS folder_id varchar(64)`);
            await this.pool.query(`ALTER TABLE ${this.t.pages} ADD COLUMN IF NOT EXISTS segment varchar(255)`);
            await this.pool.query(
                `CREATE INDEX IF NOT EXISTS ${this.t.pages}_folder_idx ON ${this.t.pages} (tenant, folder_id)`,
            );
            await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.t.folders} (
                id varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                parent_id varchar(64),
                name varchar(255) NOT NULL,
                name_mlt jsonb,
                segment varchar(64) NOT NULL,
                sort_order integer NOT NULL DEFAULT 0,
                PRIMARY KEY (tenant, id)
            )`);
            await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.t.slugHistory} (
                slug varchar(255) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                current_slug varchar(255) NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (tenant, slug)
            )`);
        }
    }

    async close(): Promise<void> {
        if (this.ownsPool) await this.pool.end();
    }

    async getPage(slug: string, tenant = ''): Promise<StoredPage | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.pages} WHERE tenant = $1 AND slug = $2`,
            [tenant, slug],
        );
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async createPage(record: StoredPage): Promise<StoredPage> {
        const row = pageToRow(record);
        const cols = Object.keys(row);
        const params = Object.values(row);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        await this.pool.query(
            `INSERT INTO ${this.t.pages} (${cols.join(', ')}) VALUES (${placeholders})`,
            params,
        );
        return (await this.getPage(record.slug, record.tenant ?? ''))!;
    }

    async updatePage(slug: string, patch: Partial<StoredPage>, tenant = ''): Promise<StoredPage | null> {
        const entries = patchToColumns(patch);
        if (!entries.length) return this.getPage(slug, tenant);
        const sets = entries.map(([col], i) => `${col} = $${i + 1}`).join(', ');
        const params = [...entries.map(([, v]) => v), tenant, slug];
        await this.pool.query(
            `UPDATE ${this.t.pages} SET ${sets}, updated_at = now() WHERE tenant = $${entries.length + 1} AND slug = $${entries.length + 2}`,
            params,
        );
        return this.getPage(slug, tenant);
    }

    async deletePage(slug: string, tenant = ''): Promise<boolean> {
        const res = await this.pool.query(
            `DELETE FROM ${this.t.pages} WHERE tenant = $1 AND slug = $2`,
            [tenant, slug],
        );
        return (res.rowCount ?? 0) > 0;
    }

    async listPages(query: PageListQuery = {}): Promise<PageListResult> {
        const page = clampPage(query.page);
        const pageSize = query.pageSize && query.pageSize > 0 ? query.pageSize : 25;
        const where: string[] = ['tenant = $1'];
        const params: unknown[] = [query.tenant ?? ''];
        const add = (condition: string, value: unknown) => {
            params.push(value);
            where.push(condition.replace('?', `$${params.length}`));
        };
        if (query.type) add('type = ?', query.type);
        if (query.status) add('status = ?', query.status);
        if (query.category) add('category = ?', query.category);
        if (query.authorSlug) add('author_slug = ?', query.authorSlug);
        if (query.pinned !== undefined) add('pinned = ?', query.pinned);
        if (query.search) {
            params.push(`%${query.search}%`);
            where.push(`(title ILIKE $${params.length} OR slug ILIKE $${params.length})`);
        }
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const { rows: countRows } = await this.pool.query(
            `SELECT count(*)::int AS c FROM ${this.t.pages} ${whereSql}`,
            params,
        );
        const total = Number(countRows[0]?.c ?? 0);
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.pages} ${whereSql}
             ORDER BY pinned DESC, published_at DESC NULLS LAST, updated_at DESC
             LIMIT ${pageSize} OFFSET ${pageOffset(page, pageSize)}`,
            params,
        );
        return { rows: rows.map(rowToPage), pagination: paginationMeta(total, page, pageSize) };
    }

    async upsertAuthor(author: StoredAuthor): Promise<StoredAuthor> {
        const row = authorToRow(author);
        await this.pool.query(
            `INSERT INTO ${this.t.authors} (slug, tenant, name, role, photo, enabled)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant, slug) DO UPDATE SET name = $3, role = $4, photo = $5, enabled = $6`,
            [row.slug, row.tenant, row.name, row.role, row.photo, row.enabled],
        );
        return (await this.getAuthor(author.slug, author.tenant ?? ''))!;
    }

    async getAuthor(slug: string, tenant = ''): Promise<StoredAuthor | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.authors} WHERE tenant = $1 AND slug = $2`,
            [tenant, slug],
        );
        return rows[0] ? rowToAuthor(rows[0]) : null;
    }

    async listAuthors(options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredAuthor[]> {
        const params: unknown[] = [options.tenant ?? ''];
        const enabled = options.enabledOnly ? 'AND enabled = true' : '';
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.authors} WHERE tenant = $1 ${enabled} ORDER BY slug`,
            params,
        );
        return rows.map(rowToAuthor);
    }

    async deleteAuthor(slug: string, tenant = ''): Promise<boolean> {
        const res = await this.pool.query(
            `DELETE FROM ${this.t.authors} WHERE tenant = $1 AND slug = $2`,
            [tenant, slug],
        );
        return (res.rowCount ?? 0) > 0;
    }

    async countPagesByAuthor(authorSlug: string, tenant = ''): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT count(*)::int AS c FROM ${this.t.pages} WHERE tenant = $1 AND author_slug = $2`,
            [tenant, authorSlug],
        );
        return Number(rows[0]?.c ?? 0);
    }

    async upsertCategory(category: StoredCategory): Promise<StoredCategory> {
        const row = categoryToRow(category);
        await this.pool.query(
            `INSERT INTO ${this.t.categories} (slug, tenant, kind, name, sort_order, enabled)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant, kind, slug) DO UPDATE SET name = $4, sort_order = $5, enabled = $6`,
            [row.slug, row.tenant, row.kind, row.name, row.sort_order, row.enabled],
        );
        return category;
    }

    async listCategories(kind: string, options: { tenant?: string; enabledOnly?: boolean } = {}): Promise<StoredCategory[]> {
        const enabled = options.enabledOnly ? 'AND enabled = true' : '';
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.categories} WHERE tenant = $1 AND kind = $2 ${enabled} ORDER BY sort_order, slug`,
            [options.tenant ?? '', kind],
        );
        return rows.map(rowToCategory);
    }

    async deleteCategory(kind: string, slug: string, tenant = ''): Promise<boolean> {
        const res = await this.pool.query(
            `DELETE FROM ${this.t.categories} WHERE tenant = $1 AND kind = $2 AND slug = $3`,
            [tenant, kind, slug],
        );
        return (res.rowCount ?? 0) > 0;
    }

    async listFolders(tenant = ''): Promise<StoredFolder[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.folders} WHERE tenant = $1 ORDER BY sort_order, name`,
            [tenant],
        );
        return rows.map(rowToFolder);
    }

    async saveFolder(folder: StoredFolder): Promise<StoredFolder> {
        const row = folderToRow(folder);
        await this.pool.query(
            `INSERT INTO ${this.t.folders} (id, tenant, parent_id, name, name_mlt, segment, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant, id) DO UPDATE SET parent_id = $3, name = $4, name_mlt = $5, segment = $6, sort_order = $7`,
            [row.id, row.tenant, row.parent_id, row.name, row.name_mlt, row.segment, row.sort_order],
        );
        return folder;
    }

    async deleteFolder(id: string, tenant = ''): Promise<boolean> {
        const res = await this.pool.query(`DELETE FROM ${this.t.folders} WHERE tenant = $1 AND id = $2`, [tenant, id]);
        return (res.rowCount ?? 0) > 0;
    }

    async listPagesInFolders(folderIds: ReadonlyArray<string | null>, tenant = ''): Promise<StoredPage[]> {
        const ids = folderIds.filter((id): id is string => id !== null);
        const includeRoot = folderIds.includes(null);
        if (!ids.length && !includeRoot) return [];
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.pages} WHERE tenant = $1 AND (folder_id = ANY($2::varchar[])${includeRoot ? ' OR folder_id IS NULL' : ''})`,
            [tenant, ids],
        );
        return rows.map(rowToPage);
    }

    async renamePage(from: string, to: string, tenant = ''): Promise<void> {
        if (from === to) return;
        await this.pool.query(`DELETE FROM ${this.t.slugHistory} WHERE tenant = $1 AND slug = $2`, [tenant, to]);
        await this.pool.query(
            `UPDATE ${this.t.pages} SET slug = $3, updated_at = now() WHERE tenant = $1 AND slug = $2`,
            [tenant, from, to],
        );
        await this.pool.query(
            `UPDATE ${this.t.slugHistory} SET current_slug = $3 WHERE tenant = $1 AND current_slug = $2`,
            [tenant, from, to],
        );
        await this.pool.query(
            `INSERT INTO ${this.t.slugHistory} (slug, tenant, current_slug) VALUES ($1, $2, $3)
             ON CONFLICT (tenant, slug) DO UPDATE SET current_slug = $3`,
            [from, tenant, to],
        );
    }

    async findPageByRole(role: string, tenant = ''): Promise<StoredPage | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.pages} WHERE tenant = $1 AND role = $2`, [tenant, role]);
        return rows[0] ? rowToPage(rows[0]) : null;
    }

    async setRole(slug: string, role: string | null, tenant = ''): Promise<void> {
        await this.pool.query(`UPDATE ${this.t.pages} SET role = $3, updated_at = now() WHERE tenant = $1 AND slug = $2`, [
            tenant,
            slug,
            role,
        ]);
    }

    async listPagesWithRole(tenant = ''): Promise<StoredPage[]> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.pages} WHERE tenant = $1 AND role IS NOT NULL ORDER BY role`, [
            tenant,
        ]);
        return rows.map(rowToPage);
    }

    async resolveFormerSlug(slug: string, tenant = ''): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT current_slug FROM ${this.t.slugHistory} WHERE tenant = $1 AND slug = $2`,
            [tenant, slug],
        );
        return rows[0] ? String(rows[0].current_slug) : null;
    }

    async releaseFormerSlug(slug: string, tenant = ''): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.slugHistory} WHERE tenant = $1 AND slug = $2`, [tenant, slug]);
    }
}
