import { folderChain, indexFolders, StoredFolder } from './addressing.js';
import { RatingSummary, ratingFromTotals } from './comments.js';
import { ContentModel, KindListing } from './content-model.js';
import { parseListParams, ParsedPageList } from './list-params.js';
import { MultiLangText } from './mlt.js';
import { PageAddressing } from './page-addressing.js';
import { PaginationMeta } from './pagination.js';
import { collectPages } from './scan.js';
import { PageListQuery, PageProjection, PageSearch, PageStore, StoredAuthor, StoredPage } from './store.js';
import { PageStatus } from './types.js';

export const ADMIN_LISTING: KindListing = { order: [{ field: 'updatedAt', direction: 'desc' }], pageSize: 25 };

export interface ListOptions {
    projection?: Exclude<PageProjection, 'index'>;
}

export interface PageCard extends StoredPage {
    author?: StoredAuthor | null;
    rating?: RatingSummary | null;
}

export interface PageListing<T = StoredPage> {
    rows: T[];
    pagination: PaginationMeta;
}

export interface PublishedPageMeta {
    folders: StoredFolder[];
    author: StoredAuthor | null;
    rating: RatingSummary | null;
}

export type PublishedPageResult = { page: StoredPage; meta: PublishedPageMeta } | { redirectTo: string } | null;

export interface LocalizedPageView {
    languageCode: string;
    title: string | null;
    annotation: string | null;
    seoTitle: string | null;
    seoDescription: string | null;
    data: unknown;
}

const pick = (text: MultiLangText | null | undefined, lang: string): string | null => (text && lang in text ? text[lang] : null);

export class PageQueries {
    private addressing: PageAddressing;

    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {
        this.addressing = new PageAddressing(store, model, tenant);
    }

    async get(id: string): Promise<StoredPage | null> {
        return this.registered(await this.store.getPageById(id, this.tenant));
    }

    async getBySlug(slug: string): Promise<StoredPage | null> {
        return this.registered(await this.store.getPageBySlug(slug, this.tenant));
    }

    async adminList(raw: Record<string, unknown>, options: ListOptions = {}): Promise<PageListing> {
        const kind = typeof raw.type === 'string' && this.model.hasKind(raw.type) ? raw.type : null;
        const parsed = parseListParams(raw, ADMIN_LISTING, this.model);
        return this.store.listPages(this.query(parsed, kind ? [kind] : this.model.kinds(), parsed.filter.status, options.projection ?? 'card'));
    }

    async list(kind: string, raw: Record<string, unknown>, options: ListOptions = {}): Promise<PageListing<PageCard>> {
        this.model.assertKind(kind);
        const parsed = parseListParams(raw, this.model.listing(kind), this.model);
        const result = await this.store.listPages(this.query(parsed, [kind], 'published', options.projection ?? 'card'));
        return { rows: await this.decorate(kind, result.rows), pagination: result.pagination };
    }

    async publishedIndex(): Promise<StoredPage[]> {
        return collectPages(this.store, { tenant: this.tenant, types: this.model.kinds(), status: 'published' }, 'index');
    }

    async publishedPage(slug: string): Promise<PublishedPageResult> {
        const resolved = await this.addressing.resolve(slug);
        if (!resolved || 'redirectTo' in resolved) return resolved;
        const page = resolved.page;
        const folders = page.folderId ? folderChain(indexFolders(await this.store.listFolders(this.tenant)), page.folderId) : [];
        const [card] = await this.decorate(page.type, [page]);
        return { page, meta: { folders, author: card.author ?? null, rating: card.rating ?? null } };
    }

    localizedView(page: StoredPage, lang: string): LocalizedPageView {
        const primary = this.model.primaryLang();
        const languageCode = page.titleMlt && lang in page.titleMlt ? lang : primary;
        const codec = this.model.hasKind(page.type) ? this.model.dataCodec(page.type) : null;
        return {
            languageCode,
            title: page.titleMlt && languageCode in page.titleMlt ? page.titleMlt[languageCode] : page.title,
            annotation: pick(page.annotation, languageCode),
            seoTitle: pick(page.seoTitle, languageCode),
            seoDescription: pick(page.seoDescription, languageCode),
            data: codec?.localize ? codec.localize(page.data, languageCode, primary) : page.data,
        };
    }

    private registered(page: StoredPage | null): StoredPage | null {
        return page && this.model.hasKind(page.type) ? page : null;
    }

    private search(term: string | undefined): PageSearch | undefined {
        if (!term) return undefined;
        return { term, columns: ['title', 'slug'], mlt: ['titleMlt', 'annotation'], langs: this.model.langs() };
    }

    private query(parsed: ParsedPageList, types: string[], status: PageStatus | undefined, projection: PageProjection): PageListQuery {
        const { search, ...filter } = parsed.filter;
        return {
            ...filter,
            tenant: this.tenant,
            types,
            status,
            search: this.search(search),
            order: parsed.order,
            page: parsed.page,
            pageSize: parsed.pageSize,
            projection,
        };
    }

    private async decorate(kind: string, pages: StoredPage[]): Promise<PageCard[]> {
        if (!pages.length || !this.model.hasKind(kind)) return pages;
        const withAuthors = this.model.usesAuthors(kind);
        const withRatings = this.model.usesComments(kind);
        const slugs = [...new Set(pages.map(p => p.authorSlug).filter((s): s is string => Boolean(s)))];
        const [authors, ratings] = await Promise.all([
            withAuthors && slugs.length ? this.store.getAuthorsBySlugs(slugs, this.tenant) : Promise.resolve([]),
            withRatings ? this.store.aggregateApprovedRatings(pages.map(p => p.id), this.tenant) : Promise.resolve([]),
        ]);
        const authorBySlug = new Map(authors.filter(a => a.enabled).map(a => [a.slug, a]));
        const ratingById = new Map(ratings.map(r => [r.pageId, ratingFromTotals(r.count, r.sum)]));
        return pages.map(page => ({
            ...page,
            ...(withAuthors ? { author: page.authorSlug ? (authorBySlug.get(page.authorSlug) ?? null) : null } : {}),
            ...(withRatings ? { rating: ratingById.get(page.id) ?? null } : {}),
        }));
    }
}
