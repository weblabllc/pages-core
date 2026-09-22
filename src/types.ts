export type PageType = string;

export const KNOWN_PAGE_TYPES = ['page', 'blog', 'article'] as const;
export type PageStatus = 'draft' | 'published';

export interface PuckData {
    content: unknown[];
    root: { props?: Record<string, unknown> };
    zones?: Record<string, unknown[]>;
}

export interface SimpleBlock {
    type: 'heading' | 'paragraph' | 'quote' | 'image' | 'document' | 'contact-form' | 'manuscript-form';
    text: string;
    url?: string;
}

export interface BlogFields {
    category: string | null;
    pinned: boolean;
    authorSlug: string | null;
    coverImage: string | null;
}

export interface PageLifecycle {
    status: PageStatus;
    publishedAt: Date | null;
}

export interface PageListEntry extends PageLifecycle {
    pinned: boolean;
}
