import { ContentModel, KindListing } from './content-model.js';
import { CommentStatus, COMMENT_STATUSES } from './comments.js';
import { PageOrder, PageSortField } from './store.js';
import { PageStatus } from './types.js';

export interface PageListFilter {
    status?: PageStatus;
    category?: string;
    hasCategory?: boolean;
    authorSlug?: string;
    pinned?: boolean;
    folderId?: string | null;
    search?: string;
}

export interface ParsedPageList {
    order: PageOrder[];
    page: number;
    pageSize: number;
    filter: PageListFilter;
}

export type CommentSortField = 'createdAt' | 'status' | 'rating' | 'id';

export interface CommentOrder {
    field: CommentSortField;
    direction: 'asc' | 'desc';
}

export interface CommentListFilter {
    status?: CommentStatus;
    pageId?: string;
    rating?: number;
    search?: string;
}

export interface ParsedCommentList {
    order: CommentOrder[];
    page: number;
    pageSize: number;
    filter: CommentListFilter;
}

const PAGE_SORT_FIELDS: readonly PageSortField[] = ['publishedAt', 'updatedAt', 'readingTime', 'title'];
const COMMENT_SORT_FIELDS: readonly CommentSortField[] = ['createdAt', 'status', 'rating'];

function positiveInt(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
}

function bool(value: unknown): boolean | undefined {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
}

function text(value: unknown, max = 200): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
}

function paging(raw: Record<string, unknown>, defaultSize: number, model: ContentModel) {
    const page = positiveInt(raw.page) ?? 1;
    const requested = positiveInt(raw.limit ?? raw.pageSize);
    return { page, pageSize: Math.min(requested ?? defaultSize, model.maxPageSize()) };
}

function direction(value: unknown): 'asc' | 'desc' {
    return value === 'asc' ? 'asc' : 'desc';
}

export function parseListParams(raw: Record<string, unknown>, listing: KindListing, model: ContentModel): ParsedPageList {
    const sortBy = PAGE_SORT_FIELDS.find(field => field === raw.sortBy);
    const order: PageOrder[] = sortBy ? [{ field: sortBy, direction: direction(raw.sortOrder) }] : [...listing.order];
    const last = order[order.length - 1];
    order.push({ field: 'id', direction: last?.direction ?? 'desc' });

    const filter: PageListFilter = {};
    if (raw.status === 'draft' || raw.status === 'published') filter.status = raw.status;
    const category = text(raw.category, 64);
    if (category) filter.category = category;
    const hasCategory = bool(raw.hasCategory);
    if (hasCategory !== undefined) filter.hasCategory = hasCategory;
    const author = text(raw.author ?? raw.authorSlug, 64);
    if (author) filter.authorSlug = author;
    const pinned = bool(raw.pinned);
    if (pinned !== undefined) filter.pinned = pinned;
    if (raw.folderId === 'root') filter.folderId = null;
    else if (typeof raw.folderId === 'string' && raw.folderId) filter.folderId = raw.folderId;
    const search = text(raw.search);
    if (search) filter.search = search;

    return { order, ...paging(raw, listing.pageSize, model), filter };
}

export function parseCommentListParams(raw: Record<string, unknown>, model: ContentModel): ParsedCommentList {
    const sortBy = COMMENT_SORT_FIELDS.find(field => field === raw.sortBy);
    const dir = direction(raw.sortOrder);
    const order: CommentOrder[] = sortBy ? [{ field: sortBy, direction: dir }, { field: 'id', direction: dir }] : [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }];

    const filter: CommentListFilter = {};
    const status = COMMENT_STATUSES.find(s => s === raw.status);
    if (status) filter.status = status;
    const pageId = text(raw.pageId, 64);
    if (pageId) filter.pageId = pageId;
    const rating = positiveInt(raw.rating);
    if (rating !== null && rating <= 5) filter.rating = rating;
    const search = text(raw.search);
    if (search) filter.search = search;

    return { order, ...paging(raw, 25, model), filter };
}
