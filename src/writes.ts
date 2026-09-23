import { ContentError } from './addressing.js';
import { PageStore, StoreConflictError } from './store.js';

export function conflictToContentError(error: unknown): unknown {
    if (!(error instanceof StoreConflictError)) return error;
    switch (error.target) {
        case 'page_slug':
            return new ContentError('slug_conflict', 'This address is already used by another page');
        case 'page_role':
            return new ContentError('role_conflict', 'This role was just given to another page; try again');
        case 'folder_sibling':
            return new ContentError('folder_conflict', 'A folder with this address already exists here');
        default:
            return error;
    }
}

export async function inTransaction<T>(store: PageStore, fn: (tx: PageStore) => Promise<T>): Promise<T> {
    try {
        return await store.transaction(fn);
    } catch (error) {
        throw conflictToContentError(error);
    }
}
