import { SchemaFeatures } from './store.js';

export interface KindConfig {
    taxonomy?: boolean;
    authors?: boolean;
    readingTime?: boolean;
    categoryKind?: string;
}

export interface ContentModelConfig {
    kinds: Record<string, KindConfig>;
}

export const PAGE_KIND: KindConfig = {};

export const ARTICLE_KIND: KindConfig = {
    taxonomy: true,
    readingTime: true,
    categoryKind: 'article',
};

export const BLOG_KIND: KindConfig = {
    taxonomy: true,
    authors: true,
    readingTime: true,
    categoryKind: 'blog',
};

export class ContentModel {
    constructor(private config: ContentModelConfig) {
        if (!Object.keys(config.kinds).length) {
            throw new Error('ContentModel requires at least one kind');
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

    categoryKind(kind: string): string | null {
        return this.kindConfig(kind).categoryKind ?? null;
    }

    schemaFeatures(): SchemaFeatures {
        const configs = Object.values(this.config.kinds);
        return {
            pages: true,
            authors: configs.some(c => c.authors),
            categories: configs.some(c => c.taxonomy),
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

export function articlesOnlyModel(): ContentModel {
    return new ContentModel({ kinds: { page: PAGE_KIND, article: ARTICLE_KIND } });
}

export function blogOnlyModel(): ContentModel {
    return new ContentModel({ kinds: { page: PAGE_KIND, blog: BLOG_KIND } });
}

export function fullBlogModel(): ContentModel {
    return new ContentModel({ kinds: { page: PAGE_KIND, article: ARTICLE_KIND, blog: BLOG_KIND } });
}
