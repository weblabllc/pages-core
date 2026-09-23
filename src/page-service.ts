import { ContentError } from './addressing.js';
import { uuidv7 } from './comments.js';
import { ContentModel } from './content-model.js';
import { applyPublish, applyUnpublish } from './domain.js';
import { Actor, PageChange, pageChange, PageMutation } from './page-changes.js';
import { assertSlugFree, pageSegment, renamePage, slugFor } from './page-addressing.js';
import { assignRoleIn } from './page-roles.js';
import { PageDraft, validatePageInput } from './page-rules.js';
import { assertPortableIdentity, exportPortablePage, PortablePage } from './portable.js';
import { PagePatch, PageStore, StoredPage } from './store.js';
import { inTransaction, stillThere } from './writes.js';

export interface PageServiceOptions {
    tenant?: string;
    now?: () => Date;
    newId?: () => string;
    wordsPerMinute?: number;
}

const CONTENT_FIELDS = ['title', 'titleMlt', 'annotation', 'data', 'category', 'pinned', 'authorSlug', 'coverImage', 'seoTitle', 'seoDescription'] as const;

const invalid = (field: string, message: string): never => {
    throw new ContentError('invalid_page', message, { field });
};

export class PageService {
    private tenant: string;
    private now: () => Date;
    private newId: () => string;
    private wordsPerMinute: number;

    constructor(
        private store: PageStore,
        private model: ContentModel,
        options: PageServiceOptions = {},
    ) {
        this.tenant = options.tenant ?? '';
        this.now = options.now ?? (() => new Date());
        this.newId = options.newId ?? (() => uuidv7());
        this.wordsPerMinute = options.wordsPerMinute ?? 200;
    }

    async create(raw: unknown, actor: Actor = { id: null }): Promise<PageMutation> {
        const draft = validatePageInput(raw, { model: this.model, mode: 'create' });
        const kind = draft.type!;
        if (this.model.usesAuthors(kind) && !draft.authorSlug) draft.authorSlug = this.model.defaultAuthor();
        return inTransaction(this.store, async tx => {
            await this.checkReferences(tx, kind, draft, null);
            const folderId = draft.folderId ?? null;
            const slug = await slugFor(tx, this.model, this.tenant, { type: kind, category: draft.category, folderId, segment: draft.segment! });
            await assertSlugFree(tx, this.tenant, slug, null);
            if (this.model.usesSlugHistory()) await tx.releaseFormerSlug(slug, this.tenant);
            const now = this.now();
            const record: StoredPage = {
                id: this.newId(),
                slug,
                tenant: this.tenant,
                type: kind,
                status: 'draft',
                title: draft.title ?? null,
                titleMlt: draft.titleMlt ?? null,
                annotation: draft.annotation ?? null,
                data: draft.data ?? null,
                category: draft.category ?? null,
                pinned: draft.pinned ?? false,
                authorSlug: draft.authorSlug ?? null,
                coverImage: draft.coverImage ?? null,
                readingTime: draft.data === undefined ? null : this.readingTime(kind, draft.data),
                publishedAt: null,
                seoTitle: draft.seoTitle ?? null,
                seoDescription: draft.seoDescription ?? null,
                createdBy: actor.id,
                createdAt: now,
                updatedAt: now,
                ...(this.model.usesFolders() ? { folderId, segment: draft.segment } : {}),
            };
            let page = await tx.createPage(record);
            const changes: PageChange[] = [pageChange(page, 'created')];
            if (draft.role) {
                const released = await assignRoleIn(tx, this.model, this.tenant, page.id, draft.role);
                if (released) changes.push(pageChange(released, 'role_released'));
                page = (await tx.getPageById(page.id, this.tenant))!;
            }
            return { page, changes };
        });
    }

    async update(id: string, raw: unknown): Promise<PageMutation> {
        const current = await this.require(this.store, id);
        const draft = validatePageInput(raw, { model: this.model, mode: 'update', current });
        return inTransaction(this.store, async tx => this.applyDraft(tx, await this.require(tx, id), draft, 'updated'));
    }

    async move(id: string, folderId: string | null): Promise<PageMutation> {
        if (!this.model.usesFolders()) invalid('folderId', 'Folders are not enabled');
        return inTransaction(this.store, async tx => this.applyDraft(tx, await this.require(tx, id), { folderId }, 'moved'));
    }

    async publish(id: string): Promise<PageMutation> {
        return this.lifecycle(id, 'published');
    }

    async unpublish(id: string): Promise<PageMutation> {
        return this.lifecycle(id, 'unpublished');
    }

    async delete(id: string): Promise<PageMutation> {
        const features = this.model.schemaFeatures();
        return inTransaction(this.store, async tx => {
            const page = await this.require(tx, id);
            if (features.slugHistory) await tx.deleteSlugHistory(id, this.tenant);
            if (features.comments) await tx.deleteCommentsByPage(id, this.tenant);
            await tx.deletePage(id, this.tenant);
            return { page: null, changes: [pageChange(page, 'deleted')] };
        });
    }

    async exportPortable(id: string): Promise<PortablePage> {
        return exportPortablePage(await this.require(this.store, id));
    }

    async importPortable(id: string, body: unknown): Promise<PageMutation> {
        const current = await this.require(this.store, id);
        const input = assertPortableIdentity(body, { slug: current.slug, type: current.type });
        const draft = validatePageInput(input, { model: this.model, mode: 'import', current });
        return inTransaction(this.store, async tx => this.applyDraft(tx, await this.require(tx, id), draft, 'updated'));
    }

    private async lifecycle(id: string, reason: 'published' | 'unpublished'): Promise<PageMutation> {
        return inTransaction(this.store, async tx => {
            const current = await this.require(tx, id);
            const next = { status: current.status, publishedAt: current.publishedAt };
            if (reason === 'published') applyPublish(next, this.now(), this.model.publishPolicy());
            else applyUnpublish(next, this.model.publishPolicy());
            const page = stillThere(await tx.updatePage(id, next, this.tenant), id);
            return { page, changes: [pageChange(page, reason)] };
        });
    }

    private async applyDraft(tx: PageStore, current: StoredPage, draft: PageDraft, reason: 'updated' | 'moved'): Promise<PageMutation> {
        await this.checkReferences(tx, current.type, draft, current);
        const patch: PagePatch = {};
        for (const field of CONTENT_FIELDS) {
            if (draft[field] !== undefined) (patch as Record<string, unknown>)[field] = draft[field];
        }
        if (draft.data !== undefined) patch.readingTime = this.readingTime(current.type, draft.data);

        const folders = this.model.usesFolders();
        const folderId = folders && draft.folderId !== undefined ? draft.folderId : (current.folderId ?? null);
        const segment = draft.segment ?? pageSegment(current);
        const category = draft.category !== undefined ? draft.category : current.category;
        const slug = await slugFor(tx, this.model, this.tenant, { type: current.type, category, folderId, segment });
        if (slug !== current.slug) {
            await renamePage(tx, this.model, this.tenant, current, slug);
            patch.slug = slug;
        }
        if (folders) {
            if (draft.folderId !== undefined) patch.folderId = draft.folderId;
            if (draft.segment !== undefined) patch.segment = draft.segment;
        }

        let page = stillThere(await tx.updatePage(current.id, patch, this.tenant), current.id);
        const renamed = slug !== current.slug;
        const changes: PageChange[] = [pageChange(page, renamed && reason === 'updated' ? 'renamed' : reason, current.slug)];
        if (draft.role !== undefined && draft.role !== (current.role ?? null)) {
            const released = await assignRoleIn(tx, this.model, this.tenant, current.id, draft.role);
            if (released) changes.push(pageChange(released, 'role_released'));
            page = stillThere(await tx.getPageById(current.id, this.tenant), current.id);
        }
        return { page, changes };
    }

    private async checkReferences(tx: PageStore, kind: string, draft: PageDraft, current: StoredPage | null): Promise<void> {
        const config = this.model.kindConfig(kind);
        if (config.taxonomy) {
            const category = draft.category !== undefined ? draft.category : (current?.category ?? null);
            if (config.categoryRequired && !category) invalid('category', 'A category is required');
            if (draft.category) {
                const found = await tx.getCategory(this.model.categoryKind(kind) ?? kind, draft.category, this.tenant);
                if (!found || !found.enabled) invalid('category', `Category "${draft.category}" does not exist or is disabled`);
            }
        }
        if (config.authors && draft.authorSlug) {
            const author = await tx.getAuthor(draft.authorSlug, this.tenant);
            if (!author || !author.enabled) invalid('authorSlug', `Author "${draft.authorSlug}" does not exist or is disabled`);
        }
    }

    private readingTime(kind: string, data: unknown): number | null {
        if (!this.model.usesReadingTime(kind) || data === null) return null;
        const words = this.model.dataCodec(kind).words(data, this.model.primaryLang(), this.model.langs());
        return Math.max(1, Math.ceil(words / this.wordsPerMinute));
    }

    private async require(store: PageStore, id: string): Promise<StoredPage> {
        const page = await store.getPageById(id, this.tenant);
        if (!page || !this.model.hasKind(page.type)) throw new ContentError('not_found', `Page ${id} not found`, { id });
        return page;
    }
}
