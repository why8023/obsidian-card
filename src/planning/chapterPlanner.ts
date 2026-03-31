import type { ContentChunk, PlanningResult, PlanningSection, ScopeEstimate } from "../types";
import { makePreview } from "../utils/markdown";

export function buildChapterPlan(
	chunks: ContentChunk[],
	estimate: ScopeEstimate,
	reason: string,
): PlanningResult {
	const groupedSections = groupChunksByTopLevelSection(chunks);
	const sections = groupedSections
		.map((group) => buildPlanningSection(group.chunks))
		.sort((left, right) => right.estimatedCardValueDensity - left.estimatedCardValueDensity);

	const recommendedCount = Math.min(3, sections.length);
	const markedSections = sections.map((section, index) => ({
		...section,
		recommended: index < recommendedCount,
	}));

	return {
		strategy: "chapter-planning",
		reason,
		estimate,
		sections: markedSections,
	};
}

function groupChunksByTopLevelSection(chunks: ContentChunk[]): Array<{ key: string; chunks: ContentChunk[] }> {
	const grouped = new Map<string, ContentChunk[]>();

	for (const chunk of chunks) {
		const topLevelHeading = chunk.headingPath[0] ?? chunk.titleHint ?? chunk.sectionKey;
		const group = grouped.get(topLevelHeading) ?? [];
		group.push(chunk);
		grouped.set(topLevelHeading, group);
	}

	return Array.from(grouped.entries()).map(([key, groupedChunks]) => ({
		key,
		chunks: groupedChunks,
	}));
}

function buildPlanningSection(chunks: ContentChunk[]): PlanningSection {
	const firstChunk = chunks[0]!;
	const combinedLength = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
	const averageChunkLength = combinedLength / Math.max(chunks.length, 1);
	const subsectionCount = new Set(
		chunks
			.map((chunk) => chunk.headingPath.join(" > "))
			.filter((value) => value.length > 0),
	).size;
	const density = normalizeDensityScore(combinedLength, averageChunkLength, subsectionCount);

	return {
		sectionKey: firstChunk.sectionKey,
		title: firstChunk.headingPath[0] ?? firstChunk.titleHint ?? firstChunk.file.basename,
		headingPath: [...firstChunk.headingPath],
		summary: makePreview(chunks.map((chunk) => chunk.text).join(" "), 180),
		estimatedCardValueDensity: density,
		recommended: false,
	};
}

function normalizeDensityScore(totalLength: number, averageChunkLength: number, subsectionCount: number): number {
	const lengthScore = Math.min(totalLength / 3000, 1);
	const chunkScore = Math.min(averageChunkLength / 1200, 1);
	const structureScore = Math.min(subsectionCount / 6, 1);
	return Number.parseFloat(((lengthScore * 0.45) + (chunkScore * 0.25) + (structureScore * 0.3)).toFixed(2));
}
