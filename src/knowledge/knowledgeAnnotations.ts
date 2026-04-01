import type { ExistingKnowledgeAnnotation, KnowledgeAnnotationData, TextRange } from "../types";
import { KNOWLEDGE_ANNOTATION_VERSION } from "../types";
import { collapseWhitespace } from "../utils/markdown";

const KNOWLEDGE_START_PREFIX = "<!-- obcd-knowledge-start:";
const KNOWLEDGE_END_MARKER = "<!-- obcd-knowledge-end -->";

export function collectKnowledgeAnnotations(content: string): ExistingKnowledgeAnnotation[] {
	const annotations: ExistingKnowledgeAnnotation[] = [];
	const openAnnotations: Array<{
		start: number;
		bodyStart: number;
		data: KnowledgeAnnotationData;
	}> = [];
	let searchOffset = 0;

	while (searchOffset < content.length) {
		const nextStart = content.indexOf(KNOWLEDGE_START_PREFIX, searchOffset);
		const nextEnd = content.indexOf(KNOWLEDGE_END_MARKER, searchOffset);
		if (nextStart === -1 && nextEnd === -1) {
			break;
		}

		if (nextStart !== -1 && (nextEnd === -1 || nextStart < nextEnd)) {
			const startCommentEnd = content.indexOf("-->", nextStart);
			if (startCommentEnd === -1) {
				searchOffset = nextStart + KNOWLEDGE_START_PREFIX.length;
				continue;
			}

			const data = parseKnowledgeStartComment(content.slice(nextStart, startCommentEnd + 3));
			if (data !== null) {
				openAnnotations.push({
					start: nextStart,
					bodyStart: startCommentEnd + 3,
					data,
				});
			}

			searchOffset = startCommentEnd + 3;
			continue;
		}

		const openAnnotation = openAnnotations.pop();
		if (openAnnotation) {
			annotations.push({
				blockRange: {
					from: openAnnotation.start,
					to: nextEnd + KNOWLEDGE_END_MARKER.length,
				},
				bodyRange: {
					from: openAnnotation.bodyStart,
					to: nextEnd,
				},
				data: openAnnotation.data,
			});
		}

		searchOffset = nextEnd + KNOWLEDGE_END_MARKER.length;
	}

	return annotations.sort((left, right) => (
		left.blockRange.from - right.blockRange.from
		|| left.blockRange.to - right.blockRange.to
	));
}

export function renderKnowledgeAnnotationStart(data: KnowledgeAnnotationData): string {
	const payload = JSON.stringify({
		version: KNOWLEDGE_ANNOTATION_VERSION,
		hash: data.hash,
		status: data.status,
		summary: collapseWhitespace(data.summary),
		topicHint: collapseWhitespace(data.topicHint),
		evidenceExcerpt: collapseWhitespace(data.evidenceExcerpt),
		rejectionReason: collapseWhitespace(data.rejectionReason),
		extractFingerprint: data.extractFingerprint.trim(),
		extractedAt: data.extractedAt.trim(),
	});
	return `${KNOWLEDGE_START_PREFIX} ${payload} -->`;
}

export function renderKnowledgeAnnotationEnd(): string {
	return KNOWLEDGE_END_MARKER;
}

export function stripKnowledgeAnnotationMarkers(value: string): string {
	return value
		.replace(/^\s*<!--\s*obcd-knowledge-start:[\s\S]*?-->\s*$/gm, "")
		.replace(/^\s*<!--\s*obcd-knowledge-end\s*-->\s*$/gm, "")
		.trim();
}

export function annotationContainsRange(annotation: ExistingKnowledgeAnnotation, range: TextRange): boolean {
	return annotation.bodyRange.from <= range.from && annotation.bodyRange.to >= range.to;
}

function parseKnowledgeStartComment(comment: string): KnowledgeAnnotationData | null {
	if (!comment.startsWith(KNOWLEDGE_START_PREFIX) || !comment.endsWith("-->")) {
		return null;
	}

	const jsonPayload = comment
		.slice(KNOWLEDGE_START_PREFIX.length, -3)
		.trim();
	if (jsonPayload.length === 0) {
		return null;
	}

	try {
		const parsed = JSON.parse(jsonPayload) as Partial<KnowledgeAnnotationData> & { group?: unknown };
		const summary = typeof parsed.summary === "string" ? collapseWhitespace(parsed.summary) : "";
		const legacyGroup = typeof parsed.group === "string" ? collapseWhitespace(parsed.group) : "";
		const topicHint = typeof parsed.topicHint === "string"
			? collapseWhitespace(parsed.topicHint)
			: legacyGroup;
		const evidenceExcerpt = typeof parsed.evidenceExcerpt === "string" ? collapseWhitespace(parsed.evidenceExcerpt) : "";
		const rejectionReason = typeof parsed.rejectionReason === "string" ? collapseWhitespace(parsed.rejectionReason) : "";
		const extractFingerprint = typeof parsed.extractFingerprint === "string" ? parsed.extractFingerprint.trim() : "";
		const extractedAt = typeof parsed.extractedAt === "string" ? parsed.extractedAt.trim() : "";
		const hash = typeof parsed.hash === "string" ? parsed.hash.trim() : "";
		if (summary.length === 0 || hash.length === 0) {
			return null;
		}

		return {
			version: typeof parsed.version === "number" ? parsed.version : KNOWLEDGE_ANNOTATION_VERSION,
			hash,
			status: parsed.status === "no-knowledge" ? "no-knowledge" : "knowledge",
			summary,
			topicHint,
			evidenceExcerpt,
			rejectionReason,
			extractFingerprint,
			extractedAt,
		};
	} catch {
		return null;
	}
}
