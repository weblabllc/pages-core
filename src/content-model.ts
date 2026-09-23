import { AddressingMode, ContentError } from './addressing.js';
import { DataCodec, PUCK_DATA } from './data-codecs.js';
import { DEFAULT_RESERVED_BLOG_SLUGS } from './validation.js';
import { PageOrder } from './store.js';
import { SchemaFeatures } from './store.js';

export interface KindConfig {
    taxonomy?: boolean;
    authors?: boolean;
    readingTime?: boolean;
    categoryKind?: string;
    addressing?: AddressingMode;
    categoryInPath?: boolean;
    comments?: boolean;
    data?: DataCodec;
    segment?: 'slug' | 'path';
    reservedSlugs?: readonly string[];
    categoryRequired?: boolean;
    listing?: KindListing;
}

export interface KindListing {
    order: readonly PageOrder[];
    pageSize: number;
}

export interface PageLimits {
    title: number;
    titleMlt: number;
    annotation: number;
    seoTitle: number;
    seoDescription: number;
}

export const PAGE_LIMITS: PageLimits = { title: 512, titleMlt: 300, annotation: 1000, seoTitle: 300, seoDescription: 1000 };

export type PublishPolicy = 'first' | 'latest';

const DEFAULT_LISTING: KindListing = { order: [{ field: 'updatedAt', direction: 'desc' }], pageSize: 25 };

const LANG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]+)?$/;

export interface ContentModelConfig {
    kinds: Record<string, KindConfig>;
    folders?: boolean;
    roles?: readonly string[];
    langs?: readonly string[];
    primaryLang?: string;
    limits?: Partial<PageLimits>;
    publishedAt?: PublishPolicy;
    slugHistory?: boolean;
    maxPageSize?: number;
    defaultAuthor?: string | null;
}

export const DEFAULT_PAGE_ROLES = ['offer', 'privacy', 'returns'] as const;

const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const PAGE_KIND: KindConfig = { addressing: 'nested' };

export const ARTICLE_KIND: KindConfig = {
    taxonomy: true,
    readingTime: true,
    categoryKind: 'article',
    addressing: 'nested',
    categoryInPath: true,
    categoryRequired: true,
    listing: { order: [{ field: 'publishedAt', direction: 'desc' }], pageSize: 9 },
};

export const BLOG_KIND: KindConfig = {
    taxonomy: true,
    authors: true,
    readingTime: true,
    categoryKind: 'blog',
    addressing: 'flat',
    comments: true,
    categoryRequired: true,
    reservedSlugs: DEFAULT_RESERVED_BLOG_SLUGS,
    listing: {
        order: [
            { field: 'pinned', direction: 'desc' },
            { field: 'publishedAt', direction: 'desc' },
        ],
        pageSize: 9,
    },
};

export class ContentModel {
    constructor(private config: ContentModelConfig) {
        if (!Object.keys(config.kinds).length) {
            throw new Error('ContentModel requires at least one kind');
        }
        const langs = config.langs ?? ['en'];
        if (!langs.length || !langs.every(lang => LANG_PATTERN.test(lang))) {
            throw new Error(`Invalid language list: ${JSON.stringify(langs)}`);
        }
        if (config.primaryLang !== undefined && !langs.includes(config.primaryLang)) {
            throw new Error(`The primary language "${config.primaryLang}" is not in the language list`);
        }
        for (const role of config.roles ?? []) {
            if (!ROLE_PATTERN.test(role)) throw new Error(`Invalid page role "${role}": lowercase latin, digits, dashes, up to 32 chars`);
        }
    }

    kinds(): string[] {
        return Object.keys(this.config.kinds);
    }

    hasKind(kind: string): boolean {
        return kind in this.config.kinds;
    }

    assertKind(kind: string): void {
        if (!this.hasKind(kind)) {
            throw new Error(`Content kind "${kind}" is not enabled (enabled: ${this.kinds().join(', ')})`);
        }
    }

    kindConfig(kind: string): KindConfig {
        this.assertKind(kind);
        return this.config.kinds[kind];
    }

    usesTaxonomy(kind: string): boolean {
        return Boolean(this.kindConfig(kind).taxonomy);
    }

    usesAuthors(kind: string): boolean {
        return Boolean(this.kindConfig(kind).authors);
    }

    usesReadingTime(kind: string): boolean {
        return Boolean(this.kindConfig(kind).readingTime);
    }

    langs(): string[] {
        return [...(this.config.langs ?? ['en'])];
    }

    primaryLang(): string {
        return this.config.primaryLang ?? this.langs()[0];
    }

    limits(): PageLimits {
        return { ...PAGE_LIMITS, ...this.config.limits };
    }

    publishPolicy(): PublishPolicy {
        return this.config.publishedAt ?? 'first';
    }

    usesSlugHistory(): boolean {
        return this.config.slugHistory ?? Boolean(this.config.folders);
    }

    maxPageSize(): number {
        return this.config.maxPageSize ?? 100;
    }

    defaultAuthor(): string | null {
        return this.config.defaultAuthor ?? null;
    }

    dataCodec(kind: string): DataCodec {
        return this.kindConfig(kind).data ?? PUCK_DATA;
    }

    listing(kind: string): KindListing {
        return this.kindConfig(kind).listing ?? DEFAULT_LISTING;
    }

    roles(): string[] {
        return [...(this.config.roles ?? [])];
    }

    usesRoles(): boolean {
        return this.roles().length > 0;
    }

    assertRole(role: string | null): void {
        if (role === null) return;
        if (!this.roles().includes(role)) {
            throw new ContentError('invalid_role', `Page role "${role}" is not enabled (enabled: ${this.roles().join(', ') || 'none'})`, { role });
        }
    }

    usesComments(kind: string): boolean {
        return this.hasKind(kind) && Boolean(this.kindConfig(kind).comments);
    }

    usesFolders(): boolean {
        return Boolean(this.config.folders);
    }

    addressing(kind: string): { mode: AddressingMode; categoryInPath: boolean } {
        const config = this.kindConfig(kind);
        const mode = this.config.folders ? (config.addressing ?? 'nested') : 'flat';
        return { mode, categoryInPath: mode === 'nested' && Boolean(config.categoryInPath) };
    }

    categoryKind(kind: string): string | null {
        return this.kindConfig(kind).categoryKind ?? null;
    }

    schemaFeatures(): SchemaFeatures {
        const configs = Object.values(this.config.kinds);
        return {
            pages: true,
            authors: configs.some(c => c.authors),
            categories: configs.some(c => c.taxonomy),
            folders: Boolean(this.config.folders),
            roles: this.usesRoles(),
            comments: configs.some(c => c.comments),
            slugHistory: this.usesSlugHistory(),
        };
    }

    taxonomyFieldsFor(
        kind: string,
        fields: { category?: string | null; pinned?: boolean; authorSlug?: string | null; coverImage?: string | null },
    ): { category: string | null; pinned: boolean; authorSlug: string | null; coverImage: string | null } {
        const config = this.kindConfig(kind);
        if (!config.taxonomy) {
            return { category: null, pinned: false, authorSlug: null, coverImage: null };
        }
        return {
            category: fields.category ?? null,
            pinned: fields.pinned ?? false,
            authorSlug: config.authors ? (fields.authorSlug ?? null) : null,
            coverImage: fields.coverImage ?? null,
        };
    }
}

export interface ModelOptions {
    folders?: boolean;
    roles?: readonly string[];
}

export function articlesOnlyModel(options: ModelOptions = {}): ContentModel {
    return new ContentModel({ kinds: { page: PAGE_KIND, article: ARTICLE_KIND }, ...options });
}

export function blogOnlyModel(options: ModelOptions = {}): ContentModel {
    return new ContentModel({ kinds: { page: PAGE_KIND, blog: BLOG_KIND }, ...options });
}

export function fullBlogModel(options: ModelOptions = {}): ContentModel {
    return new ContentModel({ kinds: { page: PAGE_KIND, article: ARTICLE_KIND, blog: BLOG_KIND }, ...options });
}
