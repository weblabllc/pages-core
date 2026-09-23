import { loadOptionalModule, PageStore, PageStoreOptions, SchemaFeatures } from '../store.js';
import { uuidv7 } from '../comments.js';
import { TableNames, tableNames } from './sql-common.js';
import { ColumnCache, SqlDialect, SqlExecutor, SqlPageStore } from './sql-store.js';

interface PgResult {
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
}

interface PgQueryable {
    query(sql: string, params?: unknown[]): Promise<PgResult>;
}

interface PgPoolClient extends PgQueryable {
    release(error?: Error | boolean): void;
}

interface PgPool extends PgQueryable {
    connect?(): Promise<PgPoolClient>;
    end?(): Promise<void>;
}

function dollarParams(sql: string): string {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
}

function executor(conn: PgQueryable): SqlExecutor {
    return {
        async rows(sql, params = []) {
            return (await conn.query(dollarParams(sql), params)).rows;
        },
        async run(sql, params = []) {
            return (await conn.query(dollarParams(sql), params)).rowCount ?? 0;
        },
    };
}

const pgDialect: SqlDialect = {
    ilike: expr => `${expr} ILIKE ?`,
    jsonText: column => `(${column} ->> ?)`,
    jsonKey: lang => lang,
    nulls: direction => (direction === 'asc' ? ' NULLS FIRST' : ' NULLS LAST'),
    upsert: (table, columns, key, update) =>
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
         ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${update.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
    conflictTarget(error, t) {
        const e = error as { code?: string; constraint?: string };
        if (e?.code !== '23505') return null;
        const name = e.constraint ?? '';
        if (name === `${t.pages}_pkey`) return 'page_id';
        if (name === `${t.pages}_slug_uq`) return 'page_slug';
        if (name === `${t.pages}_role_idx`) return 'page_role';
        if (name === `${t.folders}_sibling_uq`) return 'folder_sibling';
        if (name === `${t.comments}_pkey`) return 'comment_id';
        return 'unknown';
    },
    columnsQuery: `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`,
};

const LOCK_WAIT_MS = 120_000;
const BACKFILL_BATCH = 500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class PgSchema {
    constructor(
        private db: SqlExecutor,
        private t: TableNames,
        private concurrent: boolean,
    ) {}

    private get cic(): string {
        return this.concurrent ? ' CONCURRENTLY' : '';
    }

    private async tableExists(table: string): Promise<boolean> {
        const rows = await this.db.rows(`SELECT to_regclass(?) AS r`, [table]);
        return rows[0]?.r !== null && rows[0]?.r !== undefined;
    }

    private async columns(table: string): Promise<Map<string, { nullable: boolean; type: string; length: number | null }>> {
        const rows = await this.db.rows(
            `SELECT column_name AS c, is_nullable AS n, data_type AS d, character_maximum_length AS l
             FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`,
            [table],
        );
        return new Map(
            rows.map(r => [String(r.c), { nullable: r.n === 'YES', type: String(r.d), length: r.l === null ? null : Number(r.l) }]),
        );
    }

    private async addColumns(table: string, defs: Record<string, string>): Promise<void> {
        const have = await this.columns(table);
        const missing = Object.entries(defs).filter(([name]) => !have.has(name));
        if (!missing.length) return;
        await this.db.run(`ALTER TABLE ${table} ${missing.map(([name, def]) => `ADD COLUMN IF NOT EXISTS ${name} ${def}`).join(', ')}`);
    }

    private async index(name: string, definition: string, unique = false): Promise<void> {
        const rows = await this.db.rows(
            `SELECT i.indisvalid AS v FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
             WHERE c.relname = ? AND c.relnamespace = current_schema()::regnamespace`,
            [name],
        );
        if (rows[0]?.v === true) return;
        if (rows[0]) await this.db.run(`DROP INDEX${this.cic} IF EXISTS ${name}`);
        await this.db.run(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX${this.cic} IF NOT EXISTS ${name} ON ${definition}`);
    }

    private async inBatch(work: () => Promise<void>): Promise<void> {
        if (!this.concurrent) return work();
        await this.db.run('BEGIN');
        try {
            await work();
            await this.db.run('COMMIT');
        } catch (error) {
            await this.db.run('ROLLBACK');
            throw error;
        }
    }

    async apply(features: SchemaFeatures): Promise<void> {
        const { pages = true, authors = false, categories = false, folders = false, roles = false, comments = false } = features;
        const slugHistory = features.slugHistory ?? folders;
        if (pages) await this.pages();
        if (roles) {
            await this.addColumns(this.t.pages, { role: 'varchar(32)' });
            await this.index(`${this.t.pages}_role_idx`, `${this.t.pages} (tenant, role) WHERE role IS NOT NULL`, true);
        }
        if (folders) await this.folders();
        if (slugHistory) await this.slugHistory();
        if (authors) {
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.t.authors} (
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
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.t.categories} (
                slug varchar(64) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                kind varchar(16) NOT NULL,
                name jsonb,
                sort_order integer NOT NULL DEFAULT 0,
                enabled boolean NOT NULL DEFAULT true,
                PRIMARY KEY (tenant, kind, slug)
            )`);
        }
        if (comments) await this.comments();
    }

    private async pages(): Promise<void> {
        const p = this.t.pages;
        if (!(await this.tableExists(p))) {
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${p} (
                id varchar(36) NOT NULL,
                slug varchar(255) NOT NULL,
                tenant varchar(64) NOT NULL DEFAULT '',
                type varchar(32) NOT NULL DEFAULT 'page',
                status varchar(16) NOT NULL DEFAULT 'draft',
                title varchar(512),
                title_mlt jsonb,
                annotation jsonb,
                data jsonb NOT NULL DEFAULT 'null'::jsonb,
                category varchar(64),
                pinned boolean NOT NULL DEFAULT false,
                author_slug varchar(64),
                cover_image text,
                reading_time integer,
                published_at timestamptz,
                seo_title jsonb,
                seo_description jsonb,
                created_by varchar(64),
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT ${p}_pkey PRIMARY KEY (tenant, id)
            )`);
        } else {
            await this.addColumns(p, { seo_title: 'jsonb', seo_description: 'jsonb', created_by: 'varchar(64)' });
            const cols = await this.columns(p);
            const title = cols.get('title');
            if (title?.length !== null && title?.length !== undefined && title.length < 512) {
                await this.db.run(`ALTER TABLE ${p} ALTER COLUMN title TYPE varchar(512)`);
            }
            if (cols.get('cover_image')?.type === 'character varying') {
                await this.db.run(`ALTER TABLE ${p} ALTER COLUMN cover_image TYPE text`);
            }
            if ((await this.primaryKey(p)).join(',') === 'tenant,slug') await this.upgradePagesKey();
        }
        await this.index(`${p}_slug_uq`, `${p} (tenant, slug)`, true);
        await this.index(`${p}_list_idx`, `${p} (tenant, type, status, published_at DESC)`);
        await this.index(`${p}_author_idx`, `${p} (tenant, author_slug)`);
        await this.index(`${p}_category_idx`, `${p} (tenant, category)`);
    }

    private async primaryKey(table: string): Promise<string[]> {
        const rows = await this.db.rows(
            `SELECT a.attname AS c FROM pg_index i
             CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE i.indrelid = ?::regclass AND i.indisprimary ORDER BY k.ord`,
            [table],
        );
        return rows.map(r => String(r.c));
    }

    private async upgradePagesKey(): Promise<void> {
        const p = this.t.pages;
        await this.addColumns(p, { id: 'varchar(36)' });
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
        if ((await this.columns(p)).get('id')?.nullable) {
            if (this.concurrent) {
                const check = `${p}_id_nn`;
                const existing = await this.db.rows(`SELECT 1 FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [p, check]);
                if (!existing.length) await this.db.run(`ALTER TABLE ${p} ADD CONSTRAINT ${check} CHECK (id IS NOT NULL) NOT VALID`);
                await this.db.run(`ALTER TABLE ${p} VALIDATE CONSTRAINT ${check}`);
                await this.db.run(`ALTER TABLE ${p} ALTER COLUMN id SET NOT NULL`);
                await this.db.run(`ALTER TABLE ${p} DROP CONSTRAINT ${check}`);
            } else {
                await this.db.run(`ALTER TABLE ${p} ALTER COLUMN id SET NOT NULL`);
            }
        }
        await this.index(`${p}_slug_uq`, `${p} (tenant, slug)`, true);
        await this.index(`${p}_pkey_new`, `${p} (tenant, id)`, true);
        const [pk] = await this.db.rows(`SELECT conname AS n FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'p'`, [p]);
        await this.inBatch(async () => {
            if (this.concurrent) await this.db.run(`SET LOCAL lock_timeout = '10s'`);
            if (pk) await this.db.run(`ALTER TABLE ${p} DROP CONSTRAINT ${String(pk.n)}`);
            await this.db.run(`ALTER TABLE ${p} ADD CONSTRAINT ${p}_pkey PRIMARY KEY USING INDEX ${p}_pkey_new`);
        });
    }

    private async folders(): Promise<void> {
        const f = this.t.folders;
        await this.addColumns(this.t.pages, { folder_id: 'varchar(64)', segment: 'varchar(255)' });
        await this.index(`${this.t.pages}_folder_idx`, `${this.t.pages} (tenant, folder_id)`);
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${f} (
            id varchar(64) NOT NULL,
            tenant varchar(64) NOT NULL DEFAULT '',
            parent_id varchar(64),
            name varchar(255) NOT NULL,
            name_mlt jsonb,
            segment varchar(64) NOT NULL,
            sort_order integer NOT NULL DEFAULT 0,
            PRIMARY KEY (tenant, id)
        )`);
        const duplicates = await this.db.rows(
            `SELECT tenant, COALESCE(parent_id, '') AS parent, segment, count(*) AS n FROM ${f}
             GROUP BY tenant, COALESCE(parent_id, ''), segment HAVING count(*) > 1`,
        );
        if (duplicates.length) {
            const list = duplicates.map(d => `tenant "${d.tenant}", parent "${d.parent || 'root'}", segment "${d.segment}" (${d.n})`);
            throw new Error(`Cannot add the folder sibling index: rename these duplicate folders first: ${list.join('; ')}`);
        }
        await this.index(`${f}_sibling_uq`, `${f} (tenant, (COALESCE(parent_id, '')), segment)`, true);
    }

    private async slugHistory(): Promise<void> {
        const h = this.t.slugHistory;
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${h} (
            slug varchar(255) NOT NULL,
            tenant varchar(64) NOT NULL DEFAULT '',
            page_id varchar(36),
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant, slug)
        )`);
        const cols = await this.columns(h);
        if (cols.has('current_slug')) {
            await this.addColumns(h, { page_id: 'varchar(36)' });
            await this.db.run(
                `UPDATE ${h} h SET page_id = p.id FROM ${this.t.pages} p
                 WHERE p.tenant = h.tenant AND p.slug = h.current_slug AND p.created_at <= h.created_at AND h.page_id IS NULL`,
            );
            if (!cols.get('current_slug')!.nullable) await this.db.run(`ALTER TABLE ${h} ALTER COLUMN current_slug DROP NOT NULL`);
        }
        await this.index(`${h}_page_idx`, `${h} (tenant, page_id)`);
    }

    private async comments(): Promise<void> {
        const c = this.t.comments;
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${c} (
            id varchar(36) NOT NULL,
            tenant varchar(64) NOT NULL DEFAULT '',
            page_id varchar(36) NOT NULL,
            user_id varchar(64),
            author_name varchar(120) NOT NULL,
            author_email varchar(255),
            content text NOT NULL,
            rating smallint CONSTRAINT ${c}_rating_chk CHECK (rating BETWEEN 1 AND 5),
            status varchar(16) NOT NULL DEFAULT 'pending' CONSTRAINT ${c}_status_chk CHECK (status IN ('pending', 'approved', 'rejected')),
            moderated_by varchar(64),
            moderated_at timestamptz,
            ip varchar(64),
            created_at timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT ${c}_pkey PRIMARY KEY (tenant, id)
        )`);
        await this.index(`${c}_page_idx`, `${c} (tenant, page_id, status, created_at DESC, id DESC)`);
        await this.index(`${c}_queue_idx`, `${c} (tenant, status, created_at DESC, id DESC)`);
    }
}

export class PgPageStore extends SqlPageStore {
    private constructor(
        private conn: PgPool,
        t: TableNames,
        private ownsPool: boolean,
        private mode: 'pool' | 'bound',
        columns: ColumnCache,
        private lockKey: string,
    ) {
        super(executor(conn), pgDialect, t, columns);
    }

    static async create(options: PageStoreOptions): Promise<PgPageStore> {
        const prefix = options.tablePrefix ?? 'rl_';
        const t = tableNames(prefix);
        const mode = options.clientMode ?? 'pool';
        const lockKey = `pages-core:${prefix}`;
        if (options.client) return new PgPageStore(options.client as PgPool, t, false, mode, {}, lockKey);
        const pg = await loadOptionalModule('pg', 'the postgres page store');
        return new PgPageStore(new pg.Pool({ connectionString: options.url }), t, true, mode, {}, lockKey);
    }

    private async checkout(): Promise<PgPoolClient> {
        if (!this.conn.connect) {
            throw new Error('The postgres client cannot check out connections; pass a pool, or clientMode "bound" for a client already in a transaction');
        }
        return this.conn.connect();
    }

    async ensureSchema(features: SchemaFeatures = {}): Promise<void> {
        if (this.mode === 'bound') {
            await this.db.rows(`SELECT pg_advisory_xact_lock(hashtext(?))`, [this.lockKey]);
            await new PgSchema(this.db, this.t, false).apply(features);
            this.forgetColumns();
            return;
        }
        const client = await this.checkout();
        const db = executor(client);
        let broken: Error | undefined;
        try {
            const deadline = Date.now() + LOCK_WAIT_MS;
            while (!(await db.rows(`SELECT pg_try_advisory_lock(hashtext(?)) AS ok`, [this.lockKey]))[0]?.ok) {
                if (Date.now() > deadline) throw new Error(`Timed out waiting for the schema lock ${this.lockKey}`);
                await sleep(100);
            }
            try {
                await new PgSchema(db, this.t, true).apply(features);
            } finally {
                await db.rows(`SELECT pg_advisory_unlock(hashtext(?))`, [this.lockKey]);
            }
        } catch (error) {
            broken = error as Error;
            throw error;
        } finally {
            client.release(broken);
            this.forgetColumns();
        }
    }

    async transaction<T>(fn: (tx: PageStore) => Promise<T>): Promise<T> {
        if (this.mode === 'bound') return fn(this);
        const client = await this.checkout();
        try {
            await client.query('BEGIN');
        } catch (error) {
            client.release(error as Error);
            throw error;
        }
        let result: T;
        try {
            result = await fn(new PgPageStore(client, this.t, false, 'bound', this.columns, this.lockKey));
        } catch (error) {
            try {
                await client.query('ROLLBACK');
                client.release();
            } catch (rollbackError) {
                client.release(rollbackError as Error);
            }
            throw error;
        }
        try {
            await client.query('COMMIT');
        } catch (error) {
            client.release(error as Error);
            throw error;
        }
        client.release();
        return result;
    }

    async close(): Promise<void> {
        if (this.ownsPool) await this.conn.end?.();
    }
}
