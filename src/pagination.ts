export interface PaginationMeta {
    total_count: number;
    total_pages: number;
    current_page: number;
    page_size: number;
    has_next_page: boolean;
    has_prev_page: boolean;
}

export function clampPage(page: unknown, fallback = 1): number {
    const n = Number(page);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function paginationMeta(totalCount: number, currentPage: number, pageSize: number): PaginationMeta {
    const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;
    return {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: currentPage,
        page_size: pageSize,
        has_next_page: currentPage < totalPages,
        has_prev_page: currentPage > 1,
    };
}

export function pageOffset(currentPage: number, pageSize: number): number {
    return (currentPage - 1) * pageSize;
}
