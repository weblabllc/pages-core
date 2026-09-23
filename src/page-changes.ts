import { StoredPage } from './store.js';

export interface Actor {
    id: string | null;
}

export type PageChangeReason = 'created' | 'updated' | 'renamed' | 'moved' | 'published' | 'unpublished' | 'deleted' | 'role_released';

export interface PageChange {
    id: string;
    slug: string;
    type: string;
    reason: PageChangeReason;
    previousSlug?: string;
}

export interface PageMutation {
    page: StoredPage | null;
    changes: PageChange[];
}

export function pageChange(page: Pick<StoredPage, 'id' | 'slug' | 'type'>, reason: PageChangeReason, previousSlug?: string): PageChange {
    const change: PageChange = { id: page.id, slug: page.slug, type: page.type, reason };
    if (previousSlug !== undefined && previousSlug !== page.slug) change.previousSlug = previousSlug;
    return change;
}
