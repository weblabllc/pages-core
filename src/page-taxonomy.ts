import { ContentError } from './addressing.js';
import { canDeleteAuthor, isValidAuthorSlug, validateAuthorCreate, validateAuthorPatch } from './authors.js';
import { ContentModel } from './content-model.js';
import { sanitizeMlt } from './mlt.js';
import { PageStore, StoredAuthor, StoredCategory } from './store.js';

export const CATEGORY_LIMITS = { slug: 64, name: 100 } as const;

const CATEGORY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const invalid = (field: string, message: string): never => {
    throw new ContentError('invalid_page', message, { field });
};

export class PageTaxonomy {
    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {}

    async categories(kind: string, options: { enabledOnly?: boolean } = {}): Promise<StoredCategory[]> {
        return this.store.listCategories(kind, { tenant: this.tenant, enabledOnly: options.enabledOnly });
    }

    async saveCategory(kind: string, raw: unknown): Promise<StoredCategory> {
        this.assertCategoryKind(kind);
        if (typeof raw !== 'object' || raw === null) return invalid('body', 'Category input must be an object');
        const input = raw as Record<string, unknown>;
        if (typeof input.slug !== 'string' || input.slug.length > CATEGORY_LIMITS.slug || !CATEGORY_SLUG_RE.test(input.slug)) {
            invalid('slug', 'slug must be lowercase letters, digits and dashes, up to 64 characters');
        }
        const current = await this.store.getCategory(kind, input.slug as string, this.tenant);
        let name = current?.name ?? null;
        if (input.name !== undefined) {
            const result = sanitizeMlt(input.name, { langs: this.model.langs(), maxLen: CATEGORY_LIMITS.name });
            if ('error' in result) invalid('name', `name: ${result.error}`);
            else name = result.value;
        }
        if (input.sortOrder !== undefined && !Number.isInteger(input.sortOrder)) invalid('sortOrder', 'sortOrder must be an integer');
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') invalid('enabled', 'enabled must be true or false');
        return this.store.upsertCategory({
            slug: input.slug as string,
            tenant: this.tenant,
            kind,
            name,
            sortOrder: (input.sortOrder as number | undefined) ?? current?.sortOrder ?? 0,
            enabled: (input.enabled as boolean | undefined) ?? current?.enabled ?? true,
        });
    }

    async deleteCategory(kind: string, slug: string): Promise<void> {
        this.assertCategoryKind(kind);
        const kinds = this.model.kinds().filter(k => this.model.usesTaxonomy(k) && (this.model.categoryKind(k) ?? k) === kind);
        const used = await this.store.countPages({ tenant: this.tenant, types: kinds, category: slug });
        if (used) throw new ContentError('category_in_use', `Category "${slug}" is used by ${used} page(s)`, { slug, pages: used });
        if (!(await this.store.deleteCategory(kind, slug, this.tenant))) {
            throw new ContentError('not_found', `Category "${slug}" not found`, { slug });
        }
    }

    async authors(options: { enabledOnly?: boolean } = {}): Promise<StoredAuthor[]> {
        return this.store.listAuthors({ tenant: this.tenant, enabledOnly: options.enabledOnly });
    }

    async createAuthor(raw: unknown): Promise<StoredAuthor> {
        const result = validateAuthorCreate((raw ?? {}) as Record<string, unknown>, { mltLangs: this.model.langs() });
        if ('error' in result) return invalid('author', result.error);
        if (await this.store.getAuthor(result.value.slug, this.tenant)) invalid('slug', `Author "${result.value.slug}" already exists`);
        return this.store.upsertAuthor({ ...result.value, tenant: this.tenant });
    }

    async updateAuthor(slug: string, raw: unknown): Promise<StoredAuthor> {
        const current = isValidAuthorSlug(slug) ? await this.store.getAuthor(slug, this.tenant) : null;
        if (!current) throw new ContentError('not_found', `Author "${slug}" not found`, { slug });
        const result = validateAuthorPatch((raw ?? {}) as Record<string, unknown>, { mltLangs: this.model.langs() });
        if ('error' in result) return invalid('author', result.error);
        return this.store.upsertAuthor({ ...current, ...result.value, slug, tenant: this.tenant });
    }

    async deleteAuthor(slug: string): Promise<void> {
        const used = await this.store.countPages({ tenant: this.tenant, authorSlug: slug });
        const verdict = canDeleteAuthor(used);
        if (!verdict.ok) throw new ContentError('author_in_use', verdict.reason, { slug, pages: used });
        if (!(await this.store.deleteAuthor(slug, this.tenant))) {
            throw new ContentError('not_found', `Author "${slug}" not found`, { slug });
        }
    }

    private assertCategoryKind(kind: string): void {
        const known = this.model.kinds().some(k => this.model.usesTaxonomy(k) && (this.model.categoryKind(k) ?? k) === kind);
        if (!known) invalid('kind', `No content type uses "${kind}" categories`);
    }
}
