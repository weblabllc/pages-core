export const DEFAULT_RESERVED_BLOG_SLUGS: readonly string[] = [
    'category',
    'categories',
    'author',
    'authors',
    'comments',
    'sitemap',
];

export function isReservedSlug(slug: string, reserved: readonly string[] = DEFAULT_RESERVED_BLOG_SLUGS): boolean {
    return reserved.includes(slug);
}

export function isValidImageUrl(value: unknown, maxLen = 512): boolean {
    return typeof value === 'string' && value.length <= maxLen && /^(https?:\/\/|\/(?!\/))/.test(value);
}
