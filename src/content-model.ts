import { AddressingMode } from './addressing.js';
import { SchemaFeatures } from './store.js';

export interface KindConfig {
    taxonomy?: boolean;
    authors?: boolean;
    readingTime?: boolean;
    categoryKind?: string;
    addressing?: AddressingMode;
    categoryInPath?: boolean;
}

export interface ContentModelConfig {
    kinds: Record<string, KindConfig>;
    folders?: boolean;
}

export const PAGE_KIND: KindConfig = { addressing: 'nested' };

export const ARTICLE_KIND: KindConfig = {
    taxonomy: true,
    readingTime: true,
    categoryKind: 'article',
    addressing: 'nested',
    categoryInPath: true,
};

export const BLOG_KIND: KindConfig = {
    taxonomy: true,
    authors: true,
    readingTime: true,
    categoryKind: 'blog',
    addressing: 'flat',
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
