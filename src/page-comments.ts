import { ContentError } from './addressing.js';
import { CommentListQuery, CommentStatus, RatingSummary, ratingSummary, StoredComment, uuidv7, validateCommentInput } from './comments.js';
import { ContentModel } from './content-model.js';
import { PageStore } from './store.js';

export interface PublicComment {
    id: string;
    authorName: string;
    content: string;
    rating: number | null;
    createdAt: Date;
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

    async submit(pageSlug: string, raw: unknown, meta: { userId?: string | null; ip?: string | null } = {}): Promise<StoredComment> {
        const page = await this.store.getPage(pageSlug, this.tenant);
        if (!page || page.status !== 'published') throw new ContentError('not_found', `Page "${pageSlug}" not found`, { slug: pageSlug });
        if (!this.model.usesComments(page.type)) {
            throw new ContentError('comments_disabled', `Comments are not enabled for "${page.type}"`, { type: page.type });
        }
        const input = validateCommentInput(raw);
        return this.store.createComment({
            id: uuidv7(),
            tenant: this.tenant,
            pageSlug,
            userId: meta.userId ?? null,
            ...input,
            status: 'pending',
            moderatedBy: null,
            moderatedAt: null,
            ip: meta.ip ? meta.ip.slice(0, 64) : null,
            createdAt: new Date(),
        });
    }

    async approved(pageSlug: string, options: { page?: number; pageSize?: number } = {}) {
        const result = await this.store.listComments({ ...options, tenant: this.tenant, pageSlug, status: 'approved' });
        return { rows: result.rows.map(publicComment), pagination: result.pagination };
    }

    async queue(query: Omit<CommentListQuery, 'tenant'> = {}) {
        return this.store.listComments({ ...query, tenant: this.tenant });
    }

    async moderate(id: string, status: Exclude<CommentStatus, 'pending'>, moderatedBy: string | null): Promise<StoredComment> {
        const comment = await this.store.getComment(id, this.tenant);
        if (!comment) throw new ContentError('not_found', `Comment "${id}" not found`, { id });
        return (await this.store.setCommentStatus(id, status, moderatedBy, this.tenant))!;
    }

    async remove(id: string): Promise<void> {
        if (!(await this.store.deleteComment(id, this.tenant))) {
            throw new ContentError('not_found', `Comment "${id}" not found`, { id });
        }
    }

    async ratings(pageSlugs: readonly string[]): Promise<Record<string, RatingSummary>> {
        const rows = await this.store.listApprovedRatings(pageSlugs, this.tenant);
        const bySlug = new Map<string, number[]>();
        for (const row of rows) bySlug.set(row.pageSlug, [...(bySlug.get(row.pageSlug) ?? []), row.rating]);
        const result: Record<string, RatingSummary> = {};
        for (const [slug, ratings] of bySlug) {
            const summary = ratingSummary(ratings);
            if (summary) result[slug] = summary;
        }
        return result;
    }
}
