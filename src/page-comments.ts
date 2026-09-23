import { ContentError } from './addressing.js';
import { CommentStatus, RatingSummary, ratingFromTotals, StoredComment, uuidv7, validateCommentInput } from './comments.js';
import { ContentModel } from './content-model.js';
import { parseCommentListParams } from './list-params.js';
import { PaginationMeta } from './pagination.js';
import { PageStore, StoredPage } from './store.js';

export const PUBLIC_COMMENTS_PAGE_SIZE = 20;

export interface PublicComment {
    id: string;
    authorName: string;
    content: string;
    rating: number | null;
    createdAt: Date;
}

export interface QueuedComment extends StoredComment {
    page: { id: string; slug: string; title: string | null } | null;
}

export function publicComment(comment: StoredComment): PublicComment {
    return {
        id: comment.id,
        authorName: comment.authorName,
        content: comment.content,
        rating: comment.rating,
        createdAt: comment.createdAt,
    };
}

export class PageComments {
    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {}

    async submit(slug: string, raw: unknown, meta: { userId?: string | null; ip?: string | null } = {}): Promise<StoredComment> {
        const page = await this.commentablePage(slug, true);
        const input = validateCommentInput(raw);
        return this.store.createComment({
            id: uuidv7(),
            tenant: this.tenant,
            pageId: page.id,
            userId: meta.userId ?? null,
            ...input,
            status: 'pending',
            moderatedBy: null,
            moderatedAt: null,
            ip: meta.ip ? meta.ip.slice(0, 64) : null,
            createdAt: new Date(),
        });
    }

    async approved(
        slug: string,
        raw: Record<string, unknown> = {},
    ): Promise<{ rows: PublicComment[]; rating: RatingSummary | null; pagination: PaginationMeta }> {
        const page = await this.commentablePage(slug, false);
        const parsed = parseCommentListParams({ ...raw, pageSize: raw.pageSize ?? raw.limit ?? PUBLIC_COMMENTS_PAGE_SIZE }, this.model);
        const [result, rating] = await Promise.all([
            this.store.listComments({
                tenant: this.tenant,
                pageId: page.id,
                status: 'approved',
                order: [
                    { field: 'createdAt', direction: 'desc' },
                    { field: 'id', direction: 'desc' },
                ],
                page: parsed.page,
                pageSize: parsed.pageSize,
            }),
            this.ratings([page.id]),
        ]);
        return { rows: result.rows.map(publicComment), rating: rating[page.id] ?? null, pagination: result.pagination };
    }

    async queue(raw: Record<string, unknown> = {}): Promise<{ rows: QueuedComment[]; pagination: PaginationMeta }> {
        const parsed = parseCommentListParams(raw, this.model);
        const result = await this.store.listComments({
            tenant: this.tenant,
            ...parsed.filter,
            order: parsed.order,
            page: parsed.page,
            pageSize: parsed.pageSize,
        });
        const pages = await this.store.getPagesByIds(
            result.rows.map(c => c.pageId),
            this.tenant,
            'index',
        );
        const byId = new Map(pages.map(p => [p.id, p]));
        const rows = result.rows.map(comment => {
            const page = byId.get(comment.pageId);
            return { ...comment, page: page ? { id: page.id, slug: page.slug, title: page.title } : null };
        });
        return { rows, pagination: result.pagination };
    }

    async moderate(id: string, status: Exclude<CommentStatus, 'pending'>, moderatedBy: string | null): Promise<StoredComment> {
        if (status !== 'approved' && status !== 'rejected') {
            throw new ContentError('invalid_comment', 'status must be approved or rejected', { field: 'status' });
        }
        const updated = await this.store.setCommentStatus(id, status, moderatedBy, this.tenant);
        if (!updated) throw new ContentError('not_found', `Comment "${id}" not found`, { id });
        return updated;
    }

    async remove(id: string): Promise<void> {
        if (!(await this.store.deleteComment(id, this.tenant))) {
            throw new ContentError('not_found', `Comment "${id}" not found`, { id });
        }
    }

    async ratings(pageIds: readonly string[]): Promise<Record<string, RatingSummary>> {
        const rows = await this.store.aggregateApprovedRatings(pageIds, this.tenant);
        const result: Record<string, RatingSummary> = {};
        for (const row of rows) {
            const summary = ratingFromTotals(row.count, row.sum);
            if (summary) result[row.pageId] = summary;
        }
        return result;
    }

    private async commentablePage(slug: string, explain: boolean): Promise<StoredPage> {
        const page = await this.store.getPageBySlug(slug, this.tenant, 'index');
        const missing = () => new ContentError('not_found', `Page "${slug}" not found`, { slug });
        if (!page || page.status !== 'published' || !this.model.hasKind(page.type)) throw missing();
        if (!this.model.usesComments(page.type)) {
            if (!explain) throw missing();
            throw new ContentError('comments_disabled', `Comments are not enabled for "${page.type}"`, { type: page.type });
        }
        return page;
    }
}
