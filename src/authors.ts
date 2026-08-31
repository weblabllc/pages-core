import { isMltObject, MultiLangText, sanitizeMlt } from './mlt.js';
import { isValidImageUrl } from './validation.js';

export interface AuthorRecord {
    slug: string;
    name: string | MultiLangText;
    photo: string | null;
    role: string | MultiLangText | null;
    enabled: boolean;
}

export interface AuthorValidationOptions {
    mltLangs?: readonly string[];
    nameMaxLen?: number;
}

const AUTHOR_SLUG_RE = /^[a-z0-9-]+$/;

export function isValidAuthorSlug(slug: unknown): slug is string {
    return typeof slug === 'string' && slug.length > 0 && slug.length <= 64 && AUTHOR_SLUG_RE.test(slug);
}

function sanitizeTextOrMlt(
    value: unknown,
    field: string,
    { mltLangs = [], nameMaxLen = 120 }: AuthorValidationOptions,
    required: boolean,
): { value: string | MultiLangText | null } | { error: string } {
    if (value === undefined || value === null) {
        return required ? { error: `${field} is required` } : { value: null };
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (required && !trimmed) return { error: `${field} is required` };
        if (trimmed.length > nameMaxLen) return { error: `${field} exceeds ${nameMaxLen} chars` };
        return { value: trimmed || null };
    }
    if (mltLangs.length && isMltObject(value, mltLangs)) {
        const result = sanitizeMlt(value, { langs: mltLangs, maxLen: nameMaxLen });
        if ('error' in result) return { error: `${field}: ${result.error}` };
        if (required && (!result.value || !Object.values(result.value).some(v => v))) {
            return { error: `${field} is required` };
        }
        return { value: result.value };
    }
    return { error: `${field} must be a string${mltLangs.length ? ' or MLT object' : ''}` };
}

export function validateAuthorCreate(
    input: { slug?: unknown; name?: unknown; photo?: unknown; role?: unknown },
    options: AuthorValidationOptions = {},
): { value: AuthorRecord } | { error: string } {
    if (!isValidAuthorSlug(input.slug)) return { error: 'Invalid slug' };
    const name = sanitizeTextOrMlt(input.name, 'name', options, true);
    if ('error' in name) return name;
    if (input.photo !== undefined && input.photo !== null && !isValidImageUrl(input.photo)) {
        return { error: 'Invalid photo' };
    }
    const role = sanitizeTextOrMlt(input.role, 'role', options, false);
    if ('error' in role) return role;
    return {
        value: {
            slug: input.slug,
            name: name.value as string | MultiLangText,
            photo: (input.photo as string | null | undefined) ?? null,
            role: role.value,
            enabled: true,
        },
    };
}

export function validateAuthorPatch(
    input: { name?: unknown; photo?: unknown; role?: unknown; enabled?: unknown },
    options: AuthorValidationOptions = {},
): { value: Partial<AuthorRecord> } | { error: string } {
    const patch: Partial<AuthorRecord> = {};
    if (input.name !== undefined) {
        const name = sanitizeTextOrMlt(input.name, 'name', options, true);
        if ('error' in name) return name;
        patch.name = name.value as string | MultiLangText;
    }
    if (input.photo !== undefined) {
        if (input.photo !== null && !isValidImageUrl(input.photo)) return { error: 'Invalid photo' };
        patch.photo = input.photo as string | null;
    }
    if (input.role !== undefined) {
        const role = sanitizeTextOrMlt(input.role, 'role', options, false);
        if ('error' in role) return role;
        patch.role = role.value;
    }
    if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
        patch.enabled = input.enabled;
    }
    return { value: patch };
}

export function canDeleteAuthor(linkedPagesCount: number): { ok: true } | { ok: false; reason: string } {
    if (linkedPagesCount > 0) return { ok: false, reason: 'Author has articles, cannot delete' };
    return { ok: true };
}

export function authorPageSlug(authorSlug: string): string {
    return `blog/author/${authorSlug}`;
}

export function authorComparator(a: AuthorRecord, b: AuthorRecord, lang = 'en'): number {
    const nameOf = (r: AuthorRecord) => (typeof r.name === 'string' ? r.name : r.name[lang] ?? Object.values(r.name)[0] ?? '');
    return nameOf(a).localeCompare(nameOf(b));
}

export function enabledAuthors(authors: AuthorRecord[], lang = 'en'): AuthorRecord[] {
    return authors.filter(a => a.enabled).sort((a, b) => authorComparator(a, b, lang));
}
