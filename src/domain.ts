import type { PublishPolicy } from './content-model.js';
import { BlogFields, PageLifecycle, PageListEntry, PageType } from './types.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CYRILLIC_TRANSLIT: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie',
    ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l',
    м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '',
    ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '',
};

export function isValidSlug(slug: string): boolean {
    return SLUG_RE.test(slug) && slug.length <= 255;
}

export function slugify(value: string): string {
    return value
        .toLowerCase()
        .trim()
        .replace(/['ʼ`]/g, '')
        .split('')
        .map(ch => CYRILLIC_TRANSLIT[ch] ?? ch)
        .join('')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 255);
}

export function assertTypeImmutable(current: PageType, next: PageType | undefined): void {
    if (next !== undefined && next !== current) {
        throw new Error(`Page type is immutable after creation (${current} → ${next})`);
    }
}

export function blogFieldsFor(type: PageType, fields: Partial<BlogFields>): BlogFields {
    if (type !== 'blog') {
        return { category: null, pinned: false, authorSlug: fields.authorSlug ?? null, coverImage: null };
    }
    return {
        category: fields.category ?? null,
        pinned: fields.pinned ?? false,
        authorSlug: fields.authorSlug ?? null,
        coverImage: fields.coverImage ?? null,
    };
}

export function applyPublish<T extends PageLifecycle>(page: T, now: Date = new Date(), policy: PublishPolicy = 'first'): T {
    page.status = 'published';
    page.publishedAt = policy === 'latest' ? now : (page.publishedAt ?? now);
    return page;
}

export function applyUnpublish<T extends PageLifecycle>(page: T, policy: PublishPolicy = 'first'): T {
    page.status = 'draft';
    if (policy === 'latest') page.publishedAt = null;
    return page;
}

export function isPubliclyVisible(page: PageLifecycle): boolean {
    return page.status === 'published';
}

export function pageListComparator(a: PageListEntry, b: PageListEntry): number {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const at = a.publishedAt?.getTime() ?? 0;
    const bt = b.publishedAt?.getTime() ?? 0;
    return bt - at;
}

export function puckRootMeta(data: { root?: { props?: Record<string, unknown> } } | null | undefined): {
    title?: string;
    slug?: string;
} {
    const props = data?.root?.props ?? {};
    const meta: { title?: string; slug?: string } = {};
    if (typeof props.title === 'string') meta.title = props.title;
    if (typeof props.slug === 'string' && props.slug) meta.slug = props.slug;
    return meta;
}
