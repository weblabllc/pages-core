import {
    buildFolderTree,
    composeSlug,
    ContentError,
    FolderNode,
    folderPath,
    indexFolders,
    isValidFolderSegment,
    StoredFolder,
    subtreeIds,
    wouldCreateCycle,
} from './addressing.js';
import { uuidv7 } from './comments.js';
import { ContentModel } from './content-model.js';
import { MultiLangText, sanitizeMlt } from './mlt.js';
import { PageChange, pageChange } from './page-changes.js';
import { collectPages } from './scan.js';
import { PageStore, StoredPage } from './store.js';
import { PageType } from './types.js';
import { inTransaction, stillThere } from './writes.js';

export const FOLDER_LIMITS = { name: 255, nameMlt: 100 } as const;

export interface FolderInput {
    name: string;
    segment: string;
    parentId?: string | null;
    nameMlt?: MultiLangText | null;
    sortOrder?: number;
}

export interface Placement {
    type: PageType;
    category?: string | null;
    folderId?: string | null;
    segment: string;
}

export type Resolution = { page: StoredPage } | { redirectTo: string } | null;

const invalidFolder = (field: string, message: string): never => {
    throw new ContentError('invalid_folder', message, { field });
};

function validateFolderPatch(raw: unknown, model: ContentModel, create: boolean): Partial<FolderInput> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalidFolder('body', 'Folder input must be an object');
    const input = raw as Record<string, unknown>;
    const patch: Partial<FolderInput> = {};
    if (input.name !== undefined || create) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > FOLDER_LIMITS.name) invalidFolder('name', `name is required, up to ${FOLDER_LIMITS.name} characters`);
        patch.name = name;
    }
    if (input.segment !== undefined || create) {
        if (!isValidFolderSegment(input.segment)) {
            throw new ContentError('invalid_segment', `Invalid folder segment "${String(input.segment)}": lowercase letters, digits, dashes`);
        }
        patch.segment = input.segment;
    }
    if (input.nameMlt !== undefined) {
        const result = sanitizeMlt(input.nameMlt, { langs: model.langs(), maxLen: FOLDER_LIMITS.nameMlt });
        if ('error' in result) invalidFolder('nameMlt', `nameMlt: ${result.error}`);
        else patch.nameMlt = result.value;
    }
    if (input.sortOrder !== undefined) {
        if (!Number.isInteger(input.sortOrder)) invalidFolder('sortOrder', 'sortOrder must be an integer');
        patch.sortOrder = input.sortOrder as number;
    }
    if (input.parentId !== undefined) {
        if (input.parentId !== null && typeof input.parentId !== 'string') invalidFolder('parentId', 'parentId must be a string or null');
        patch.parentId = input.parentId as string | null;
    }
    return patch;
}

export function pageSegment(page: StoredPage): string {
    return page.segment ?? page.slug.split('/').pop()!;
}

export async function slugFor(store: PageStore, model: ContentModel, tenant: string, placement: Placement): Promise<string> {
    const { mode, categoryInPath } = model.addressing(placement.type);
    const path = mode === 'nested' && placement.folderId ? folderPath(indexFolders(await store.listFolders(tenant)), placement.folderId) : [];
    return composeSlug({ mode, categoryInPath, category: placement.category, folderPath: path, segment: placement.segment });
}

export async function assertSlugFree(store: PageStore, tenant: string, slug: string, ownerId: string | null): Promise<void> {
    const holder = await store.getPageBySlug(slug, tenant, 'index');
    if (holder && holder.id !== ownerId) {
        throw new ContentError('slug_conflict', `The address "${slug}" is already used by another page`, { slug });
    }
}

export async function renamePage(
    store: PageStore,
    model: ContentModel,
    tenant: string,
    page: StoredPage,
    slug: string,
): Promise<void> {
    if (slug === page.slug) return;
    await assertSlugFree(store, tenant, slug, page.id);
    if (model.usesSlugHistory()) {
        await store.releaseFormerSlug(slug, tenant);
        await store.recordFormerSlug(page.slug, page.id, tenant);
    }
}

export class PageAddressing {
    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {}

    async tree(): Promise<FolderNode[]> {
        return buildFolderTree(await this.store.listFolders(this.tenant));
    }

    async createFolder(raw: unknown): Promise<StoredFolder> {
        const input = validateFolderPatch(raw, this.model, true);
        return inTransaction(this.store, async tx => {
            const folders = indexFolders(await tx.listFolders(this.tenant));
            const parentId = input.parentId ?? null;
            if (parentId && !folders.has(parentId)) throw new ContentError('not_found', `Folder ${parentId} not found`);
            this.assertSiblingFree(folders.values(), parentId, input.segment!);
            return tx.saveFolder({
                id: uuidv7(),
                tenant: this.tenant,
                parentId,
                name: input.name!,
                nameMlt: input.nameMlt ?? null,
                segment: input.segment!,
                sortOrder: input.sortOrder ?? 0,
            });
        });
    }

    async updateFolder(id: string, raw: unknown): Promise<{ folder: StoredFolder; changes: PageChange[] }> {
        const patch = validateFolderPatch(raw, this.model, false);
        return inTransaction(this.store, async tx => {
            const all = await tx.listFolders(this.tenant);
            const folders = indexFolders(all);
            const current = folders.get(id);
            if (!current) throw new ContentError('not_found', `Folder ${id} not found`);
            const next: StoredFolder = {
                ...current,
                name: patch.name ?? current.name,
                nameMlt: patch.nameMlt === undefined ? current.nameMlt : patch.nameMlt,
                segment: patch.segment ?? current.segment,
                parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
                sortOrder: patch.sortOrder ?? current.sortOrder,
            };
            if (next.parentId && !folders.has(next.parentId)) throw new ContentError('not_found', `Folder ${next.parentId} not found`);
            if (wouldCreateCycle(folders, id, next.parentId)) {
                throw new ContentError('folder_cycle', 'A folder cannot be moved into its own subtree');
            }
            this.assertSiblingFree(
                all.filter(f => f.id !== id),
                next.parentId,
                next.segment,
            );
            await tx.saveFolder(next);
            const moved = next.segment !== current.segment || next.parentId !== current.parentId;
            if (!moved) return { folder: next, changes: [] };
            const subtree = subtreeIds(indexFolders([...all.filter(f => f.id !== id), next]), id);
            return { folder: next, changes: await this.recompute(tx, subtree) };
        });
    }

    async deleteFolder(id: string): Promise<void> {
        await inTransaction(this.store, async tx => {
            const all = await tx.listFolders(this.tenant);
            if (!all.some(f => f.id === id)) throw new ContentError('not_found', `Folder ${id} not found`);
            const children = all.filter(f => f.parentId === id).length;
            const pages = await tx.countPages({ tenant: this.tenant, folderId: id });
            if (children || pages) throw new ContentError('folder_not_empty', 'Folder is not empty', { children, pages });
            await tx.deleteFolder(id, this.tenant);
        });
    }

    async resolve(slug: string, { publishedOnly = true }: { publishedOnly?: boolean } = {}): Promise<Resolution> {
        const visible = (page: StoredPage | null): page is StoredPage =>
            !!page && this.model.hasKind(page.type) && (!publishedOnly || page.status === 'published');
        const page = await this.store.getPageBySlug(slug, this.tenant);
        if (page) return visible(page) ? { page } : null;
        if (!this.model.usesSlugHistory()) return null;
        const id = await this.store.resolveFormerSlug(slug, this.tenant);
        if (!id) return null;
        const target = await this.store.getPageById(id, this.tenant, 'index');
        return visible(target) && target.slug !== slug ? { redirectTo: target.slug } : null;
    }

    private async recompute(tx: PageStore, folderIds: string[]): Promise<PageChange[]> {
        const pages = await collectPages(tx, { tenant: this.tenant, folderIds });
        const changes: PageChange[] = [];
        for (const page of pages) {
            if (!this.model.hasKind(page.type)) continue;
            const slug = await slugFor(tx, this.model, this.tenant, {
                type: page.type,
                category: page.category,
                folderId: page.folderId ?? null,
                segment: pageSegment(page),
            });
            if (slug === page.slug) continue;
            await renamePage(tx, this.model, this.tenant, page, slug);
            const updated = stillThere(await tx.updatePage(page.id, { slug }, this.tenant), page.id);
            changes.push(pageChange(updated, 'renamed', page.slug));
        }
        return changes;
    }

    private assertSiblingFree(folders: Iterable<StoredFolder>, parentId: string | null, segment: string): void {
        for (const folder of folders) {
            if (folder.parentId === parentId && folder.segment === segment) {
                throw new ContentError('folder_conflict', `Folder "${segment}" already exists here`, { segment });
            }
        }
    }
}
