import { PageFilter, PageProjection, PageStore, StoredPage } from './store.js';

export const SCAN_BATCH = 100;

export async function* scanPages(store: PageStore, filter: PageFilter, projection: PageProjection = 'full'): AsyncGenerator<StoredPage> {
    for (let page = 1; ; page++) {
        const { rows } = await store.listPages({ ...filter, order: [{ field: 'id', direction: 'asc' }], page, pageSize: SCAN_BATCH, projection });
        yield* rows;
        if (rows.length < SCAN_BATCH) return;
    }
}

export async function collectPages(store: PageStore, filter: PageFilter, projection: PageProjection = 'full'): Promise<StoredPage[]> {
    const pages: StoredPage[] = [];
    for await (const page of scanPages(store, filter, projection)) pages.push(page);
    return pages;
}
