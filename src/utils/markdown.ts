export interface HeadingInfo {
	level: number;
	title: string;
	from: number;
	lineEnd: number;
}

export interface LineInfo {
	text: string;
	start: number;
	end: number;
}

export function detectNewline(content: string): string {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

export function findFrontmatterEnd(content: string): number {
	const lines = collectLineInfos(content);
	const firstLine = lines[0];
	if (!firstLine || firstLine.text.trim() !== "---") {
		return 0;
	}

	for (let index = 1; index < lines.length; index += 1) {
		const currentLine = lines[index];
		if (!currentLine) {
			continue;
		}

		const value = currentLine.text.trim();
		if (value === "---" || value === "...") {
			return currentLine.end;
		}
	}

	return 0;
}

export function collectMarkdownHeadings(content: string): HeadingInfo[] {
	const lines = collectLineInfos(content);
	const headings: HeadingInfo[] = [];
	let fenceMarker: string | null = null;

	for (const line of lines) {
		const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!marker) {
				continue;
			}

			if (fenceMarker === null) {
				fenceMarker = marker;
			} else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
				fenceMarker = null;
			}
			continue;
		}

		if (fenceMarker !== null) {
			continue;
		}

		const headingMatch = line.text.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (!headingMatch) {
			continue;
		}

		const hashes = headingMatch[1];
		const title = headingMatch[2];
		if (!hashes || title === undefined) {
			continue;
		}

		headings.push({
			level: hashes.length,
			title: title.trim(),
			from: line.start,
			lineEnd: line.end,
		});
	}

	return headings;
}

export function trimContentRange(content: string, from: number, to: number): { text: string; from: number; to: number } {
	const rawValue = content.slice(from, to);
	const trimmedValue = rawValue.trim();

	if (trimmedValue.length === 0) {
		return {
			text: "",
			from,
			to: from,
		};
	}

	const leadingWhitespaceLength = getLeadingWhitespaceLength(rawValue);
	const trailingWhitespaceLength = getTrailingWhitespaceLength(rawValue);

	return {
		text: trimmedValue,
		from: from + leadingWhitespaceLength,
		to: to - trailingWhitespaceLength,
	};
}

export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function normalizeContentForHash(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function makePreview(value: string, maxLength = 240): string {
	const normalizedValue = collapseWhitespace(value);
	if (normalizedValue.length <= maxLength) {
		return normalizedValue;
	}

	return `${normalizedValue.slice(0, Math.max(maxLength - 3, 0)).trim()}...`;
}

export function sliceWithoutRanges(content: string, from: number, to: number, excludedRanges: Array<{ from: number; to: number }>): string {
	if (from >= to) {
		return "";
	}

	const overlappingRanges = excludedRanges
		.filter((range) => range.to > from && range.from < to)
		.sort((left, right) => left.from - right.from);

	if (overlappingRanges.length === 0) {
		return content.slice(from, to);
	}

	let cursor = from;
	let result = "";

	for (const range of overlappingRanges) {
		const rangeStart = Math.max(range.from, from);
		const rangeEnd = Math.min(range.to, to);

		if (rangeStart > cursor) {
			result += content.slice(cursor, rangeStart);
		}

		cursor = Math.max(cursor, rangeEnd);
		if (cursor >= to) {
			break;
		}
	}

	if (cursor < to) {
		result += content.slice(cursor, to);
	}

	return result;
}

export function slugifyHeading(value: string): string {
	const normalizedValue = value
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");

	if (normalizedValue.length > 0) {
		return normalizedValue;
	}

	return `section-${hashContent(value).slice(-8)}`;
}

export function hashContent(value: string): string {
	let hash = 0x811c9dc5;

	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

export function collectLineInfos(content: string): LineInfo[] {
	if (content.length === 0) {
		return [];
	}

	const lines: LineInfo[] = [];
	let offset = 0;

	while (offset < content.length) {
		const nextNewlineIndex = content.indexOf("\n", offset);
		const lineEnd = nextNewlineIndex === -1 ? content.length : nextNewlineIndex + 1;
		const rawLine = content.slice(offset, lineEnd);
		let text = rawLine;

		if (text.endsWith("\n")) {
			text = text.slice(0, -1);
		}
		if (text.endsWith("\r")) {
			text = text.slice(0, -1);
		}

		lines.push({
			text,
			start: offset,
			end: lineEnd,
		});

		offset = lineEnd;
	}

	return lines;
}

function getLeadingWhitespaceLength(value: string): number {
	const match = value.match(/^\s*/);
	return match ? match[0].length : 0;
}

function getTrailingWhitespaceLength(value: string): number {
	const match = value.match(/\s*$/);
	return match ? match[0].length : 0;
}
