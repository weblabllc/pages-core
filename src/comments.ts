import { ContentError } from './addressing.js';

export type CommentStatus = 'pending' | 'approved' | 'rejected';

export const COMMENT_STATUSES: readonly CommentStatus[] = ['pending', 'approved', 'rejected'];

export interface StoredComment {
    id: string;
    tenant: string;
    pageId: string;
    userId: string | null;
    authorName: string;
    authorEmail: string | null;
    content: string;
    rating: number | null;
    status: CommentStatus;
    moderatedBy: string | null;
    moderatedAt: Date | null;
    ip: string | null;
    createdAt: Date;
}

export interface CommentInput {
    authorName: string;
    authorEmail: string | null;
    content: string;
    rating: number | null;
}


export interface RatingSummary {
    avg: number;
    count: number;
}

export const COMMENT_LIMITS = { authorName: 120, authorEmail: 255, content: 4000 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const KEPT_CONTROL = new Set([9, 10, 13]);

export function cleanCommentText(value: string): string {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0)!;
        if ((code < 32 && !KEPT_CONTROL.has(code)) || code === 127) continue;
        out += char;
    }
    return out.trim();
}

export function validateCommentInput(raw: unknown): CommentInput {
    const fail = (field: string, message: string): never => {
        throw new ContentError('invalid_comment', message, { field });
    };
    if (typeof raw !== 'object' || raw === null) fail('body', 'Comment must be an object');
    const body = raw as Record<string, unknown>;

    const authorName = typeof body.authorName === 'string' ? cleanCommentText(body.authorName) : '';
    if (!authorName) fail('authorName', 'authorName is required');
    if (authorName.length > COMMENT_LIMITS.authorName) fail('authorName', `authorName is longer than ${COMMENT_LIMITS.authorName} characters`);

    const content = typeof body.content === 'string' ? cleanCommentText(body.content) : '';
    if (!content) fail('content', 'content is required');
    if (content.length > COMMENT_LIMITS.content) fail('content', `content is longer than ${COMMENT_LIMITS.content} characters`);

    let authorEmail: string | null = null;
    if (body.authorEmail !== undefined && body.authorEmail !== null && body.authorEmail !== '') {
        const email = typeof body.authorEmail === 'string' ? cleanCommentText(body.authorEmail) : '';
        if (!EMAIL_RE.test(email) || email.length > COMMENT_LIMITS.authorEmail) fail('authorEmail', 'authorEmail is not a valid address');
        authorEmail = email;
    }

    let rating: number | null = null;
    if (body.rating !== undefined && body.rating !== null) {
        if (!Number.isInteger(body.rating) || (body.rating as number) < 1 || (body.rating as number) > 5) {
            fail('rating', 'rating must be an integer between 1 and 5');
        }
        rating = body.rating as number;
    }

    return { authorName, authorEmail, content, rating };
}

export function ratingFromTotals(count: number, sum: number): RatingSummary | null {
    if (!count) return null;
    return { avg: Math.round((sum / count) * 10) / 10, count };
}

export function ratingSummary(ratings: ReadonlyArray<number | null>): RatingSummary | null {
    const values = ratings.filter((r): r is number => typeof r === 'number');
    return ratingFromTotals(values.length, values.reduce((sum, r) => sum + r, 0));
}

export function uuidv7(now: number = Date.now()): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let ms = now;
    for (let i = 5; i >= 0; i--) {
        bytes[i] = ms & 0xff;
        ms = Math.floor(ms / 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
