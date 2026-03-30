import type { TextRange } from "./types";

const OBAR_CUSTOM_NOTE_START_PATTERN =
	/<!--\s*OBAR-CUSTOM-NOTE-START:([A-Za-z0-9-]+)\s*-->/g;
const OBAR_CUSTOM_NOTE_END_PATTERN =
	/<!--\s*OBAR-CUSTOM-NOTE-END:([A-Za-z0-9-]+)\s*-->/g;
const OBAR_NOTE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_OBAR_NOTE_ID_LENGTH = 12;

export const DEFAULT_OBAR_FRONTMATTER_KEYS = [
	"obar_session_id",
	"obar_session_key",
	"obar_session_url",
];

export const DEFAULT_OBAR_NOTE_HEADING_LEVEL = 2;
export const DEFAULT_OBAR_NOTE_HEADING_TEXT = "Flashcards";

export interface ObarCompatibilityConfig {
	enabled: boolean;
	frontmatterKeys: string[];
	noteHeadingLevel: number;
	noteHeadingText: string;
}

interface MarkerMatch {
	id: string;
	start: number;
	end: number;
}

export function normalizeObarFrontmatterKeys(
	value: unknown,
	fallback = DEFAULT_OBAR_FRONTMATTER_KEYS,
): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	const normalizedKeys = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.filter((entry, index, items) => items.indexOf(entry) === index);

	return normalizedKeys.length > 0 ? normalizedKeys : [...fallback];
}

export function isObarRecordContent(
	content: string,
	config: Pick<ObarCompatibilityConfig, "enabled" | "frontmatterKeys">,
): boolean {
	if (!config.enabled) {
		return false;
	}

	const frontmatter = extractFrontmatter(content);
	if (frontmatter === null) {
		return false;
	}

	return config.frontmatterKeys.some((key) => (
		new RegExp(`(^|\\n)${escapeRegExp(key)}\\s*:`, "m").test(frontmatter)
	));
}

export function renderObarWrappedBlock(
	block: string,
	newline: string,
	config: Pick<ObarCompatibilityConfig, "noteHeadingLevel" | "noteHeadingText">,
): string {
	const headingText = config.noteHeadingText.trim();
	const sections: string[] = [];

	if (headingText.length > 0) {
		sections.push(`${"#".repeat(clampHeadingLevel(config.noteHeadingLevel))} ${headingText}`);
	}

	sections.push(block.replace(/\r\n/g, "\n").replace(/\n/g, newline));

	const innerContent = sections.join(`${newline}${newline}`);
	const noteId = createObarCustomNoteId();

	return [
		`<!-- OBAR-CUSTOM-NOTE-START:${noteId}-->`,
		innerContent,
		`<!-- OBAR-CUSTOM-NOTE-END:${noteId}-->`,
	].join(newline);
}

export function expandRangeToIncludeObarCustomNote(
	content: string,
	range: TextRange,
): TextRange {
	const startMarker = findLastMarkerBefore(content, OBAR_CUSTOM_NOTE_START_PATTERN, range.from);
	if (startMarker === null) {
		return range;
	}

	const endMarkerBeforeRange = findLastMarkerBefore(content, OBAR_CUSTOM_NOTE_END_PATTERN, range.from);
	if (endMarkerBeforeRange !== null && endMarkerBeforeRange.start > startMarker.start) {
		return range;
	}

	const endMarker = findFirstMarkerAfter(content, OBAR_CUSTOM_NOTE_END_PATTERN, range.to, startMarker.id);
	if (endMarker === null) {
		return range;
	}

	return {
		from: startMarker.start,
		to: endMarker.end,
	};
}

function extractFrontmatter(content: string): string | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
	return match?.[1] ?? null;
}

function createObarCustomNoteId(length = DEFAULT_OBAR_NOTE_ID_LENGTH): string {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi?.getRandomValues) {
		const bytes = new Uint8Array(length);
		cryptoApi.getRandomValues(bytes);
		return [...bytes]
			.map((value) => OBAR_NOTE_ID_ALPHABET[value & 31] ?? "")
			.join("");
	}

	let output = "";

	for (let index = 0; index < length; index += 1) {
		const randomIndex = Math.floor(Math.random() * OBAR_NOTE_ID_ALPHABET.length);
		output += OBAR_NOTE_ID_ALPHABET[randomIndex] ?? "";
	}

	return output;
}

function clampHeadingLevel(value: number): number {
	if (!Number.isFinite(value)) {
		return DEFAULT_OBAR_NOTE_HEADING_LEVEL;
	}

	return Math.max(1, Math.min(6, Math.round(value)));
}

function findLastMarkerBefore(
	content: string,
	pattern: RegExp,
	offset: number,
): MarkerMatch | null {
	pattern.lastIndex = 0;

	let result: MarkerMatch | null = null;
	let match = pattern.exec(content);
	while (match) {
		if (match.index >= offset) {
			break;
		}

		const markerId = match[1];
		if (markerId) {
			result = {
				id: markerId,
				start: match.index,
				end: pattern.lastIndex,
			};
		}

		match = pattern.exec(content);
	}

	return result;
}

function findFirstMarkerAfter(
	content: string,
	pattern: RegExp,
	offset: number,
	id: string,
): MarkerMatch | null {
	pattern.lastIndex = offset;

	let match = pattern.exec(content);
	while (match) {
		const markerId = match[1];
		if (markerId === id) {
			return {
				id: markerId,
				start: match.index,
				end: pattern.lastIndex,
			};
		}

		match = pattern.exec(content);
	}

	return null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
