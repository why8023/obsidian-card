import type { ExistingKnowledgeAnnotation, KnowledgeAnnotationData } from "../types";
import { KNOWLEDGE_ANNOTATION_VERSION } from "../types";
import type { TextRange } from "../types";
import { collapseWhitespace } from "../utils/markdown";

const KNOWLEDGE_START_PREFIX = "<!-- obcd-knowledge-start:";
const KNOWLEDGE_END_MARKER = "<!-- obcd-knowledge-end -->";

export function collectKnowledgeAnnotations(content: string): ExistingKnowledgeAnnotation[] {
	const annotations: ExistingKnowledgeAnnotation[] = [];
	let searchOffset = 0;

	while (searchOffset < content.length) {
		const start = content.indexOf(KNOWLEDGE_START_PREFIX, searchOffset);
		if (start === -1) {
			break;
		}

		const startCommentEnd = content.indexOf("-->", start);
		if (startCommentEnd === -1) {
			break;
		}

		const end = content.indexOf(KNOWLEDGE_END_MARKER, startCommentEnd + 3);
		if (end === -1) {
			break;
		}

		const data = parseKnowledgeStartComment(content.slice(start, startCommentEnd + 3));
		if (data !== null) {
			annotations.push({
				blockRange: {
					from: start,
					to: end + KNOWLEDGE_END_MARKER.length,
				},
				bodyRange: {
					from: startCommentEnd + 3,
					to: end,
				},
				data,
			});
		}

		searchOffset = end + KNOWLEDGE_END_MARKER.length;
	}

	return annotations;
}

export function renderKnowledgeAnnotationStart(data: KnowledgeAnnotationData): string {
	const payload = JSON.stringify({
		version: KNOWLEDGE_ANNOTATION_VERSION,
		hash: data.hash,
		summary: collapseWhitespace(data.summary),
		group: collapseWhitespace(data.group),
	});
	return `${KNOWLEDGE_START_PREFIX} ${payload} -->`;
}

export function renderKnowledgeAnnotationEnd(): string {
	return KNOWLEDGE_END_MARKER;
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
		const parsed = JSON.parse(jsonPayload) as Partial<KnowledgeAnnotationData>;
		const summary = typeof parsed.summary === "string" ? collapseWhitespace(parsed.summary) : "";
		const group = typeof parsed.group === "string" ? collapseWhitespace(parsed.group) : "";
		const hash = typeof parsed.hash === "string" ? parsed.hash.trim() : "";
		if (summary.length === 0 || group.length === 0 || hash.length === 0) {
			return null;
		}

		return {
			version: typeof parsed.version === "number" ? parsed.version : KNOWLEDGE_ANNOTATION_VERSION,
			hash,
			summary,
			group,
		};
	} catch {
		return null;
	}
}
