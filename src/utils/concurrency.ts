export async function mapWithConcurrency<TItem, TResult>(
	items: TItem[],
	maxConcurrency: number,
	worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
	if (items.length === 0) {
		return [];
	}

	const concurrency = normalizeConcurrency(maxConcurrency, items.length);
	const results = new Array<TResult>(items.length);
	let nextIndex = 0;

	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (nextIndex < items.length) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
			}
		}),
	);

	return results;
}

function normalizeConcurrency(maxConcurrency: number, itemCount: number): number {
	if (!Number.isFinite(maxConcurrency)) {
		return 1;
	}

	return Math.max(1, Math.min(itemCount, Math.floor(maxConcurrency)));
}
