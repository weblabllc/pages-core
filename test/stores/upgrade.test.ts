import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { createPageStore, PageStore } from '../../src/index.js';
import { mysqlSchemaV05, pgSchemaV05 } from '../fixtures/v05-schema.js';

const ALL = { pages: true, authors: true, categories: true, folders: true, roles: true, comments: true, slugHistory: true };

const at = (iso: string) => new Date(iso);

const LEGACY_PAGES = [
    { slug: 'alpha', role: null, folderId: null, createdAt: at('2026-01-01T00:00:00Z') },
    { slug: 'beta', role: 'offer', folderId: null, createdAt: at('2026-02-01T00:00:00Z') },
    { slug: 'gamma', role: null, folderId: 'f1', createdAt: at('2026-02-10T00:00:00Z') },
    { slug: 'ghost', role: null, folderId: null, createdAt: at('2026-04-01T00:00:00Z') },
];

const LEGACY_HISTORY = [
    { slug: 'old-alpha', current: 'alpha', createdAt: at('2026-03-01T00:00:00Z') },
    { slug: 'older-alpha', current: 'alpha', createdAt: at('2026-02-01T00:00:00Z') },
    { slug: 'ghost-old', current: 'ghost', createdAt: at('2026-01-15T00:00:00Z') },
];

const LEGACY_FOLDERS = [
    { id: 'f1', parentId: null, segment: 'docs' },
    { id: 'f2', parentId: 'f1', segment: 'intro' },
];

interface Raw {
    load(prefix: string, duplicateFolders?: boolean): Promise<void>;
    close(): Promise<void>;
}

const idTime = (id: string) => parseInt(id.replace(/-/g, '').slice(0, 12), 16);

function pgRaw(url: string): Raw {
    const pool = new pg.Pool({ connectionString: url });
    return {
        async load(p, duplicateFolders = false) {
            for (const sql of pgSchemaV05(p)) await pool.query(sql);
            for (const page of LEGACY_PAGES) {
                await pool.query(
                    `INSERT INTO ${p}pages (slug, tenant, title, title_mlt, data, role, folder_id, created_at, updated_at)
                     VALUES ($1, '', $1, $2, 'null', $3, $4, $5, $5)`,
                    [page.slug, JSON.stringify({ en: page.slug }), page.role, page.folderId, page.createdAt],
                );
            }
            for (const h of LEGACY_HISTORY) {
                await pool.query(`INSERT INTO ${p}page_slug_history (slug, tenant, current_slug, created_at) VALUES ($1, '', $2, $3)`, [
                    h.slug,
                    h.current,
                    h.createdAt,
                ]);
            }
            const folders = duplicateFolders ? [...LEGACY_FOLDERS, { id: 'f3', parentId: null, segment: 'docs' }] : LEGACY_FOLDERS;
            for (const f of folders) {
                await pool.query(`INSERT INTO ${p}page_folders (id, tenant, parent_id, name, segment) VALUES ($1, '', $2, $3, $3)`, [
                    f.id,
                    f.parentId,
                    f.segment,
                ]);
            }
        },
        close: () => pool.end(),
    };
}

function mysqlRaw(url: string): Raw {
    const pool = mysql.createPool(url);
    return {
        async load(p, duplicateFolders = false) {
            for (const sql of mysqlSchemaV05(p)) await pool.query(sql);
            for (const page of LEGACY_PAGES) {
                await pool.query(
                    `INSERT INTO ${p}pages (slug, tenant, title, title_mlt, data, role, folder_id, created_at, updated_at)
                     VALUES (?, '', ?, ?, 'null', ?, ?, ?, ?)`,
                    [page.slug, page.slug, JSON.stringify({ en: page.slug }), page.role, page.folderId, page.createdAt, page.createdAt],
                );
            }
            for (const h of LEGACY_HISTORY) {
                await pool.query(`INSERT INTO ${p}page_slug_history (slug, tenant, current_slug, created_at) VALUES (?, '', ?, ?)`, [
                    h.slug,
                    h.current,
                    h.createdAt,
                ]);
            }
            const folders = duplicateFolders ? [...LEGACY_FOLDERS, { id: 'f3', parentId: null, segment: 'docs' }] : LEGACY_FOLDERS;
            for (const f of folders) {
                await pool.query(`INSERT INTO ${p}page_folders (id, tenant, parent_id, name, segment) VALUES (?, '', ?, ?, ?)`, [
                    f.id,
                    f.parentId,
                    f.segment,
                    f.segment,
                ]);
            }
        },
        close: () => pool.end(),
    };
}

function mongoRaw(url: string): Raw {
    const client = new MongoClient(url);
    const db = client.db('pages_core_test');
    return {
        async load(p, duplicateFolders = false) {
            await client.connect();
            await db.collection(`${p}pages`).createIndex({ tenant: 1, slug: 1 }, { unique: true });
            await db.collection(`${p}pages`).createIndex({ tenant: 1, role: 1 }, { unique: true, partialFilterExpression: { role: { $type: 'string' } } });
            await db.collection(`${p}page_folders`).createIndex({ tenant: 1, id: 1 }, { unique: true });
            await db.collection(`${p}page_slug_history`).createIndex({ tenant: 1, slug: 1 }, { unique: true });
            await db.collection(`${p}page_slug_history`).createIndex({ tenant: 1, currentSlug: 1 });
            await db.collection(`${p}pages`).insertMany(
                LEGACY_PAGES.map(page => ({
                    slug: page.slug,
                    tenant: '',
                    type: 'page',
                    status: 'draft',
                    title: page.slug,
                    titleMlt: { en: page.slug },
                    annotation: null,
                    data: null,
                    category: null,
                    pinned: false,
                    authorSlug: null,
                    coverImage: null,
                    readingTime: null,
                    publishedAt: null,
                    ...(page.role ? { role: page.role } : {}),
                    folderId: page.folderId,
                    createdAt: page.createdAt,
                    updatedAt: page.createdAt,
                })),
            );
            await db
                .collection(`${p}page_slug_history`)
                .insertMany(LEGACY_HISTORY.map(h => ({ tenant: '', slug: h.slug, currentSlug: h.current, createdAt: h.createdAt })));
            const folders = duplicateFolders ? [...LEGACY_FOLDERS, { id: 'f3', parentId: null, segment: 'docs' }] : LEGACY_FOLDERS;
            await db
                .collection(`${p}page_folders`)
                .insertMany(folders.map(f => ({ id: f.id, tenant: '', parentId: f.parentId, name: f.segment, nameMlt: null, segment: f.segment, sortOrder: 0 })));
        },
        close: () => client.close(),
    };
}

const targets: Array<[string, (() => Raw) | null, Record<string, unknown>]> = [
    ['postgres', process.env.PAGES_PG_URL ? () => pgRaw(process.env.PAGES_PG_URL!) : null, { driver: 'postgres', url: process.env.PAGES_PG_URL }],
    ['mysql', process.env.PAGES_MYSQL_URL ? () => mysqlRaw(process.env.PAGES_MYSQL_URL!) : null, { driver: 'mysql', url: process.env.PAGES_MYSQL_URL }],
    [
        'mongodb',
        process.env.PAGES_MONGO_URL ? () => mongoRaw(process.env.PAGES_MONGO_URL!) : null,
        { driver: 'mongodb', url: process.env.PAGES_MONGO_URL, database: 'pages_core_test' },
    ],
];

const fresh = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_`;

for (const [name, makeRaw, options] of targets) {
    describe.skipIf(!makeRaw)(`${name} upgrade from 0.5`, () => {
        const prefix = fresh();
        let raw: Raw;
        let store: PageStore;

        beforeAll(async () => {
            raw = makeRaw!();
            await raw.load(prefix);
            store = await createPageStore({ ...(options as never), tablePrefix: prefix });
            await store.ensureSchema(ALL);
            await store.ensureSchema(ALL);
        });

        afterAll(async () => {
            await store?.close();
            await raw?.close();
        });

        it('gives every legacy page a uuidv7 id stamped with its creation time', async () => {
            const list = await store.listPages({ page: 1, pageSize: 50, order: [{ field: 'createdAt', direction: 'asc' }] });
            expect(list.rows.map(p => p.slug)).toEqual(LEGACY_PAGES.map(p => p.slug));
            for (const [i, page] of list.rows.entries()) {
                expect(page.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
                expect(idTime(page.id)).toBe(LEGACY_PAGES[i].createdAt.getTime());
                expect((await store.getPageById(page.id))?.slug).toBe(page.slug);
            }
        });

        it('keys pages by id afterwards: slugs stay unique and can change', async () => {
            const alpha = await store.getPageBySlug('alpha');
            await expect(store.createPage({ ...alpha!, id: '0190aaaa-0000-7000-8000-000000000001' })).rejects.toMatchObject({ target: 'page_slug' });
            const renamed = await store.updatePage(alpha!.id, { slug: 'alpha-new' });
            expect(renamed?.slug).toBe('alpha-new');
            await store.updatePage(alpha!.id, { slug: 'alpha' });
        });

        it('binds history to page ids and leaves a stale redirect unbound', async () => {
            const alpha = await store.getPageBySlug('alpha');
            expect(await store.resolveFormerSlug('old-alpha')).toBe(alpha!.id);
            expect(await store.resolveFormerSlug('older-alpha')).toBe(alpha!.id);
            expect(await store.resolveFormerSlug('ghost-old')).toBeNull();
        });

        it('keeps roles and folders, and now refuses duplicate siblings', async () => {
            expect((await store.findPageByRole('offer'))?.slug).toBe('beta');
            expect((await store.listFolders()).map(f => f.id).sort()).toEqual(['f1', 'f2']);
            await expect(
                store.saveFolder({ id: 'f9', tenant: '', parentId: null, name: 'docs', nameMlt: null, segment: 'docs', sortOrder: 0 }),
            ).rejects.toMatchObject({ target: 'folder_sibling' });
        });
    });

    describe.skipIf(!makeRaw)(`${name} upgrade with duplicate folders`, () => {
        it('stops with a message that lists the duplicates', async () => {
            const prefix = fresh();
            const raw = makeRaw!();
            const store = await createPageStore({ ...(options as never), tablePrefix: prefix });
            try {
                await raw.load(prefix, true);
                await expect(store.ensureSchema(ALL)).rejects.toThrow(/duplicate folders.*segment "docs" \(2\)/);
            } finally {
                await store.close();
                await raw.close();
            }
        });
    });
}
