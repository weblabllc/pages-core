import {
    buildFolderTree,
    composeSlug,
    ContentError,
    FolderNode,
    folderPath,
    indexFolders,
    isValidFolderSegment,
    isValidPageSegment,
    RenamedPage,
    StoredFolder,
    subtreeIds,
    wouldCreateCycle,
} from './addressing.js';
import { ContentModel } from './content-model.js';
import { MultiLangText } from './mlt.js';
import { PageStore, StoredPage } from './store.js';
import { PageType } from './types.js';

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

export class PageAddressing {
    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {}

    async tree(): Promise<FolderNode[]> {
        return buildFolderTree(await this.store.listFolders(this.tenant));
    }

    async createFolder(input: FolderInput): Promise<StoredFolder> {
        const folders = indexFolders(await this.store.listFolders(this.tenant));
        const parentId = input.parentId ?? null;
        this.assertFolderSegment(input.segment);
        if (parentId && !folders.has(parentId)) throw new ContentError('not_found', `Folder ${parentId} not found`);
        this.assertSiblingFree(folders.values(), parentId, input.segment);
        const folder: StoredFolder = {
            id: globalThis.crypto.randomUUID(),
            tenant: this.tenant,
            parentId,
            name: input.name,
            nameMlt: input.nameMlt ?? null,
            segment: input.segment,
            sortOrder: input.sortOrder ?? 0,
        };
        return this.store.saveFolder(folder);
    }

    async updateFolder(id: string, patch: Partial<FolderInput>): Promise<{ folder: StoredFolder; renamedPages: RenamedPage[] }> {
        const all = await this.store.listFolders(this.tenant);
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
        this.assertFolderSegment(next.segment);
        if (next.parentId && !folders.has(next.parentId)) throw new ContentError('not_found', `Folder ${next.parentId} not found`);
        if (wouldCreateCycle(folders, id, next.parentId)) {
            throw new ContentError('folder_cycle', 'A folder cannot be moved into its own subtree');
        }
        this.assertSiblingFree(all.filter(f => f.id !== id), next.parentId, next.segment);
        await this.store.saveFolder(next);
        const moved = next.segment !== current.segment || next.parentId !== current.parentId;
        const renamedPages = moved ? await this.recompute(subtreeIds(indexFolders([...all.filter(f => f.id !== id), next]), id)) : [];
        return { folder: next, renamedPages };
    }

    async deleteFolder(id: string): Promise<void> {
        const all = await this.store.listFolders(this.tenant);
        if (!all.some(f => f.id === id)) throw new ContentError('not_found', `Folder ${id} not found`);
        const children = all.filter(f => f.parentId === id).length;
        const pages = (await this.store.listPagesInFolders([id], this.tenant)).length;
        if (children || pages) {
            throw new ContentError('folder_not_empty', 'Folder is not empty', { children, pages });
        }
        await this.store.deleteFolder(id, this.tenant);
    }

    async slugFor(placement: Placement): Promise<string> {
        if (!isValidPageSegment(placement.segment)) {
            throw new ContentError('invalid_segment', `Invalid page segment "${placement.segment}"`);
        }
        const { mode, categoryInPath } = this.model.addressing(placement.type);
        const path = mode === 'nested' && placement.folderId
            ? folderPath(indexFolders(await this.store.listFolders(this.tenant)), placement.folderId)
            : [];
        return composeSlug({ mode, categoryInPath, category: placement.category, folderPath: path, segment: placement.segment });
    }

    async assertAvailable(slug: string, exceptSlug: string | null = null): Promise<void> {
        if (slug === exceptSlug) return;
        if (await this.store.getPage(slug, this.tenant)) {
            throw new ContentError('slug_conflict', `Slug "${slug}" is already used by another page`, { slug });
        }
    }

    async prepareNew(placement: Placement): Promise<{ slug: string; folderId: string | null; segment: string }> {
        const slug = await this.slugFor(placement);
        await this.assertAvailable(slug);
        await this.store.releaseFormerSlug(slug, this.tenant);
        return { slug, folderId: placement.folderId ?? null, segment: placement.segment };
    }

    async place(currentSlug: string, placement: Placement): Promise<string> {
        const slug = await this.slugFor(placement);
        await this.assertAvailable(slug, currentSlug);
        await this.store.updatePage(currentSlug, { folderId: placement.folderId ?? null, segment: placement.segment }, this.tenant);
        await this.store.renamePage(currentSlug, slug, this.tenant);
        return slug;
    }

    async movePage(slug: string, folderId: string | null): Promise<string> {
        const page = await this.store.getPage(slug, this.tenant);
        if (!page) throw new ContentError('not_found', `Page "${slug}" not found`);
        return this.place(slug, {
            type: page.type,
            category: page.category,
            folderId,
            segment: page.segment ?? slug.split('/').pop()!,
        });
    }

    async resolve(slug: string): Promise<Resolution> {
        const page = await this.store.getPage(slug, this.tenant);
        if (page) return { page };
        const current = await this.store.resolveFormerSlug(slug, this.tenant);
        return current ? { redirectTo: current } : null;
    }

    private async recompute(folderIds: string[]): Promise<RenamedPage[]> {
        const pages = await this.store.listPagesInFolders(folderIds, this.tenant);
        const renamed: RenamedPage[] = [];
        for (const page of pages) {
            if (!page.segment) continue;
            const slug = await this.slugFor({ type: page.type, category: page.category, folderId: page.folderId ?? null, segment: page.segment });
            if (slug === page.slug) continue;
            await this.assertAvailable(slug, page.slug);
            await this.store.renamePage(page.slug, slug, this.tenant);
            renamed.push({ from: page.slug, to: slug });
        }
        return renamed;
    }

    private assertFolderSegment(segment: string): void {
        if (!isValidFolderSegment(segment)) {
            throw new ContentError('invalid_segment', `Invalid folder segment "${segment}": lowercase letters, digits, dashes`);
        }
    }

    private assertSiblingFree(folders: Iterable<StoredFolder>, parentId: string | null, segment: string): void {
        for (const folder of folders) {
            if (folder.parentId === parentId && folder.segment === segment) {
                throw new ContentError('folder_conflict', `Folder "${segment}" already exists here`, { segment });
            }
        }
    }
}
