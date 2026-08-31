import { PuckData } from './types.js';

export function emptyPuckData(): PuckData {
    return { content: [], root: { props: {} } };
}

export function isPuckData(value: unknown): value is PuckData {
    return (
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as PuckData).content) &&
        typeof (value as PuckData).root === 'object' &&
        (value as PuckData).root !== null
    );
}

export function normalizePuckData(value: unknown): PuckData {
    if (isPuckData(value)) return value;
    return emptyPuckData();
}
