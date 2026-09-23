import { loadOptionalModule, PageStore, PageStoreOptions, SchemaFeatures } from '../store.js';
import { uuidv7 } from '../comments.js';
import { TableNames, tableNames } from './sql-common.js';
import { ColumnCache, SqlDialect, SqlExecutor, SqlPageStore } from './sql-store.js';

interface MysqlQueryable {
    query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

interface MysqlConnection extends MysqlQueryable {
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
    destroy?(): void;
}

interface MysqlPool extends MysqlQueryable {
    getConnection?(): Promise<MysqlConnection>;
    end?(): Promise<void>;
}

function executor(conn: MysqlQueryable): SqlExecutor {
    return {
        async rows(sql, params = []) {
            const [rows] = await conn.query(sql, params);
            return rows as Array<Record<string, unknown>>;
        },
        async run(sql, params = []) {
            const [result] = await conn.query(sql, params);
            return (result as { affectedRows?: number }).affectedRows ?? 0;
        },
    };
}

const BIN = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';

const mysqlDialect: SqlDialect = {
    ilike: expr => `LOWER(${expr}) LIKE LOWER(?)`,
    jsonText: column => `JSON_UNQUOTE(JSON_EXTRACT(${column}, ?))`,
    jsonKey: lang => `$."${lang}"`,
    nulls: () => '',
    upsert: (table, columns, _key, update) =>
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${update.map(c => `${c} = VALUES(${c})`).join(', ')}`,
    conflictTarget(error, t) {
        const e = error as { code?: string; errno?: number; message?: string };
        if (e?.code !== 'ER_DUP_ENTRY' && e?.errno !== 1062) return null;
        const match = /for key '([^']+)'/.exec(e.message ?? '');
        const full = match?.[1] ?? '';
        const dot = full.lastIndexOf('.');
        const table = dot >= 0 ? full.slice(0, dot) : '';
        const key = dot >= 0 ? full.slice(dot + 1) : full;
        if (key === 'slug_uq') return 'page_slug';
        if (key === 'role_idx') return 'page_role';
        if (key === 'sibling_uq') return 'folder_sibling';
        if (key === 'PRIMARY' && table === t.pages) return 'page_id';
        if (key === 'PRIMARY' && table === t.comments) return 'comment_id';
        return 'unknown';
    },
    columnsQuery: `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
};

const BACKFILL_BATCH = 500;

class MysqlSchema {
    constructor(
        private db: SqlExecutor,
        private t: TableNames,
        private batches: boolean,
    ) {}

    private async columns(table: string): Promise<Map<string, { nullable: boolean; length: number | null }>> {
        const rows = await this.db.rows(
            `SELECT column_name AS c, is_nullable AS n, character_maximum_length AS l
             FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`,
            [table],
        );
        return new Map(rows.map(r => [String(r.c), { nullable: r.n === 'YES', length: r.l === null ? null : Number(r.l) }]));
    }

    private async indexes(table: string): Promise<Set<string>> {
        const rows = await this.db.rows(
            `SELECT DISTINCT index_name AS i FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?`,
            [table],
        );
        return new Set(rows.map(r => String(r.i)));
    }

    private async primaryKey(table: string): Promise<string[]> {
        const rows = await this.db.rows(
            `SELECT column_name AS c FROM information_schema.key_column_usage
             WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`,
            [table],
        );
        return rows.map(r => String(r.c));
    }

    private async alter(table: string, clauses: string[]): Promise<void> {
        if (clauses.length) await this.db.run(`ALTER TABLE ${table} ${clauses.join(', ')}`);
    }

    async apply(features: SchemaFeatures): Promise<void> {
        const { pages = true, authors = false, categories = false, folders = false, roles = false, comments = false } = features;
        const slugHistory = features.slugHistory ?? folders;
        if (pages) await this.pages();
        if (roles) {
            const cols = await this.columns(this.t.pages);
            if (!cols.has('role')) await this.alter(this.t.pages, [`ADD COLUMN role varchar(32) ${BIN} NULL`, 'ADD UNIQUE KEY role_idx (tenant, role)']);
        }
        if (folders) await this.folders();
        if (slugHistory) await this.slugHistory();
        if (authors) {
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.t.authors} (
                slug varchar(64) ${BIN} NOT NULL,
                tenant varchar(64) ${BIN} NOT NULL DEFAULT '',
                name json NOT NULL,
                role json NULL,
                photo varchar(512) NULL,
                enabled tinyint(1) NOT NULL DEFAULT 1,
                PRIMARY KEY (tenant, slug)
            ) DEFAULT CHARSET = utf8mb4`);
        }
        if (categories) {
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.t.categories} (
                slug varchar(64) ${BIN} NOT NULL,
                tenant varchar(64) ${BIN} NOT NULL DEFAULT '',
                kind varchar(16) ${BIN} NOT NULL,
                name json NULL,
                sort_order int NOT NULL DEFAULT 0,
                enabled tinyint(1) NOT NULL DEFAULT 1,
                PRIMARY KEY (tenant, kind, slug)
            ) DEFAULT CHARSET = utf8mb4`);
        }
        if (comments) await this.comments();
    }

    private async pages(): Promise<void> {
        const p = this.t.pages;
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${p} (
            id varchar(36) ${BIN} NOT NULL,
            slug varchar(255) ${BIN} NOT NULL,
            tenant varchar(64) ${BIN} NOT NULL DEFAULT '',
            type varchar(32) NOT NULL DEFAULT 'page',
            status varchar(16) NOT NULL DEFAULT 'draft',
            title varchar(512) NULL,
            title_mlt json NULL,
            annotation json NULL,
            data json NULL,
            category varchar(64) ${BIN} NULL,
            pinned tinyint(1) NOT NULL DEFAULT 0,
            author_slug varchar(64) ${BIN} NULL,
            cover_image varchar(2048) NULL,
            reading_time int NULL,
            published_at datetime(3) NULL,
            seo_title json NULL,
            seo_description json NULL,
            created_by varchar(64) NULL,
            created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (tenant, id),
            UNIQUE KEY slug_uq (tenant, slug),
            KEY list_idx (tenant, type, status, published_at),
            KEY author_idx (tenant, author_slug),
            KEY category_idx (tenant, category)
        ) DEFAULT CHARSET = utf8mb4`);
        const cols = await this.columns(p);
        const missing = [
            ['seo_title', 'json NULL'],
            ['seo_description', 'json NULL'],
            ['created_by', 'varchar(64) NULL'],
        ].filter(([name]) => !cols.has(name));
        await this.alter(p, missing.map(([name, def]) => `ADD COLUMN ${name} ${def}`));
        if ((await this.primaryKey(p)).join(',') === 'tenant,slug') await this.upgradePagesKey();
        const have = await this.indexes(p);
        await this.alter(
            p,
            [
                ['author_idx', 'ADD KEY author_idx (tenant, author_slug)'],
                ['category_idx', 'ADD KEY category_idx (tenant, category)'],
            ]
                .filter(([name]) => !have.has(name))
                .map(([, clause]) => clause),
        );
    }

    private async inBatch(work: () => Promise<void>): Promise<void> {
        if (!this.batches) return work();
        await this.db.run('START TRANSACTION');
        try {
            await work();
            await this.db.run('COMMIT');
        } catch (error) {
            await this.db.run('ROLLBACK');
            throw error;
        }
    }

    private async upgradePagesKey(): Promise<void> {
        const p = this.t.pages;
        if (!(await this.columns(p)).has('id')) await this.alter(p, [`ADD COLUMN id varchar(36) ${BIN} NULL`]);
        for (;;) {
            const batch = await this.db.rows(`SELECT tenant, slug, created_at FROM ${p} WHERE id IS NULL LIMIT ${BACKFILL_BATCH}`);
            if (!batch.length) break;
            await this.inBatch(async () => {
                for (const row of batch) {
                    const created = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
                    await this.db.run(`UPDATE ${p} SET id = ? WHERE tenant = ? AND slug = ? AND id IS NULL`, [
                        uuidv7(Number.isFinite(created) ? created : Date.now()),
                        row.tenant,
                        row.slug,
                    ]);
                }
            });
        }
        const have = await this.indexes(p);
        await this.alter(p, [
            `MODIFY id varchar(36) ${BIN} NOT NULL`,
            `MODIFY slug varchar(255) ${BIN} NOT NULL`,
            `MODIFY tenant varchar(64) ${BIN} NOT NULL DEFAULT ''`,
            'MODIFY title varchar(512) NULL',
            `MODIFY category varchar(64) ${BIN} NULL`,
            `MODIFY author_slug varchar(64) ${BIN} NULL`,
            'MODIFY cover_image varchar(2048) NULL',
            'DROP PRIMARY KEY',
            'ADD PRIMARY KEY (tenant, id)',
            ...(have.has('slug_uq') ? [] : ['ADD UNIQUE KEY slug_uq (tenant, slug)']),
        ]);
    }

    private async folders(): Promise<void> {
        const f = this.t.folders;
        const pageCols = await this.columns(this.t.pages);
        await this.alter(this.t.pages, [
            ...(pageCols.has('folder_id') ? [] : [`ADD COLUMN folder_id varchar(64) ${BIN} NULL`, 'ADD KEY folder_idx (tenant, folder_id)']),
            ...(pageCols.has('segment') ? [] : [`ADD COLUMN segment varchar(255) ${BIN} NULL`]),
        ]);
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${f} (
            id varchar(64) ${BIN} NOT NULL,
            tenant varchar(64) ${BIN} NOT NULL DEFAULT '',
            parent_id varchar(64) ${BIN} NULL,
            name varchar(255) NOT NULL,
            name_mlt json NULL,
            segment varchar(64) ${BIN} NOT NULL,
            sort_order int NOT NULL DEFAULT 0,
            parent_key varchar(64) ${BIN} AS (COALESCE(parent_id, '')) STORED,
            PRIMARY KEY (tenant, id),
            UNIQUE KEY sibling_uq (tenant, parent_key, segment)
        ) DEFAULT CHARSET = utf8mb4`);
        if ((await this.columns(f)).has('parent_key')) return;
        const duplicates = await this.db.rows(
            `SELECT tenant, COALESCE(parent_id, '') AS parent, segment, COUNT(*) AS n FROM ${f}
             GROUP BY tenant, COALESCE(parent_id, ''), segment HAVING COUNT(*) > 1`,
        );
        if (duplicates.length) {
            const list = duplicates.map(d => `tenant "${d.tenant}", parent "${d.parent || 'root'}", segment "${d.segment}" (${d.n})`);
            throw new Error(`Cannot add the folder sibling index: rename these duplicate folders first: ${list.join('; ')}`);
        }
        await this.alter(f, [
            `MODIFY segment varchar(64) ${BIN} NOT NULL`,
            `ADD COLUMN parent_key varchar(64) ${BIN} AS (COALESCE(parent_id, '')) STORED`,
            'ADD UNIQUE KEY sibling_uq (tenant, parent_key, segment)',
        ]);
    }

    private async slugHistory(): Promise<void> {
        const h = this.t.slugHistory;
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${h} (
            slug varchar(255) ${BIN} NOT NULL,
            tenant varchar(64) ${BIN} NOT NULL DEFAULT '',
            page_id varchar(36) ${BIN} NULL,
            created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (tenant, slug),
            KEY page_idx (tenant, page_id)
        ) DEFAULT CHARSET = utf8mb4`);
        const cols = await this.columns(h);
        if (!cols.has('current_slug')) return;
        if (!cols.has('page_id')) await this.alter(h, [`ADD COLUMN page_id varchar(36) ${BIN} NULL`, 'ADD KEY page_idx (tenant, page_id)']);
        await this.db.run(
            `UPDATE ${h} h JOIN ${this.t.pages} p ON p.tenant = h.tenant AND p.slug = h.current_slug AND p.created_at <= h.created_at
             SET h.page_id = p.id WHERE h.page_id IS NULL`,
        );
        if (!cols.get('current_slug')!.nullable) await this.alter(h, [`MODIFY current_slug varchar(255) ${BIN} NULL`]);
    }

    private async comments(): Promise<void> {
        const c = this.t.comments;
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${c} (
            id varchar(36) ${BIN} NOT NULL,
            tenant varchar(64) ${BIN} NOT NULL DEFAULT '',
            page_id varchar(36) ${BIN} NOT NULL,
            user_id varchar(64) NULL,
            author_name varchar(120) NOT NULL,
            author_email varchar(255) NULL,
            content text NOT NULL,
            rating smallint NULL,
            status varchar(16) NOT NULL DEFAULT 'pending',
            moderated_by varchar(64) NULL,
            moderated_at datetime(3) NULL,
            ip varchar(64) NULL,
            created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (tenant, id),
            KEY page_idx (tenant, page_id, status, created_at, id),
            KEY queue_idx (tenant, status, created_at, id),
            CONSTRAINT ${c}_rating_chk CHECK (rating BETWEEN 1 AND 5),
            CONSTRAINT ${c}_status_chk CHECK (status IN ('pending', 'approved', 'rejected'))
        ) DEFAULT CHARSET = utf8mb4`);
    }
}

export class MysqlPageStore extends SqlPageStore {
    private constructor(
        private conn: MysqlPool,
        t: TableNames,
        private ownsPool: boolean,
        private mode: 'pool' | 'bound',
        columns: ColumnCache,
        private lockKey: string,
    ) {
        super(executor(conn), mysqlDialect, t, columns);
    }

    static async create(options: PageStoreOptions): Promise<MysqlPageStore> {
        const prefix = options.tablePrefix ?? 'rl_';
        const t = tableNames(prefix);
        const mode = options.clientMode ?? 'pool';
        const lockKey = `pages-core:${prefix}`;
        if (options.client) return new MysqlPageStore(options.client as MysqlPool, t, false, mode, {}, lockKey);
        const mysql = await loadOptionalModule('mysql2/promise', 'the mysql page store');
        return new MysqlPageStore(mysql.createPool(options.url), t, true, mode, {}, lockKey);
    }

    private async checkout(): Promise<MysqlConnection> {
        if (!this.conn.getConnection) {
            throw new Error('The mysql client cannot check out connections; pass a pool, or clientMode "bound" for a connection already in a transaction');
        }
        return this.conn.getConnection();
    }

    async ensureSchema(features: SchemaFeatures = {}): Promise<void> {
        if (this.mode === 'bound') {
            await new MysqlSchema(this.db, this.t, false).apply(features);
            this.forgetColumns();
            return;
        }
        const conn = await this.checkout();
        const db = executor(conn);
        try {
            const [lock] = await db.rows(`SELECT GET_LOCK(?, 120) AS ok`, [this.lockKey]);
            if (Number(lock?.ok) !== 1) throw new Error(`Timed out waiting for the schema lock ${this.lockKey}`);
            try {
                await new MysqlSchema(db, this.t, true).apply(features);
            } finally {
                await db.rows(`SELECT RELEASE_LOCK(?)`, [this.lockKey]);
            }
        } finally {
            conn.release();
            this.forgetColumns();
        }
    }

    async transaction<T>(fn: (tx: PageStore) => Promise<T>): Promise<T> {
        if (this.mode === 'bound') return fn(this);
        const conn = await this.checkout();
        try {
            await conn.beginTransaction();
            const result = await fn(new MysqlPageStore(conn, this.t, false, 'bound', this.columns, this.lockKey));
            await conn.commit();
            conn.release();
            return result;
        } catch (error) {
            try {
                await conn.rollback();
                conn.release();
            } catch {
                (conn.destroy ?? conn.release).call(conn);
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        if (this.ownsPool) await this.conn.end?.();
    }
}
