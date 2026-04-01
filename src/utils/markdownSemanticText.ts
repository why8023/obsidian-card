import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface MarkdownAstNode {
	type?: string;
	value?: string;
	alt?: string;
	url?: string;
	title?: string;
	label?: string;
	identifier?: string;
	children?: MarkdownAstNode[];
}

export function extractSemanticMarkdownText(markdown: string): string {
	if (markdown.trim().length === 0) {
		return "";
	}

	try {
		const tree = fromMarkdown(markdown, {
			extensions: [gfm()],
			mdastExtensions: [gfmFromMarkdown()],
		}) as MarkdownAstNode;
		return collapseSemanticWhitespace(renderNode(tree));
	} catch {
		return "";
	}
}

function renderNode(node: MarkdownAstNode | undefined): string {
	if (!node) {
		return "";
	}

	switch (node.type) {
		case "root":
		case "blockquote":
		case "list":
		case "footnoteDefinition":
			return joinBlocks(node.children);
		case "paragraph":
		case "heading":
		case "strong":
		case "emphasis":
		case "delete":
		case "link":
		case "linkReference":
		case "tableCell":
			return joinInline(node.children);
		case "listItem":
			return joinBlocks(node.children);
		case "table":
			return (node.children ?? [])
				.map((child) => renderNode(child))
				.filter((value) => value.length > 0)
				.join("\n");
		case "tableRow":
			return (node.children ?? [])
				.map((child) => renderNode(child))
				.filter((value) => value.length > 0)
				.join(" | ");
		case "text":
			return normalizeTextValue(node.value ?? "");
		case "inlineCode":
		case "code":
			return normalizeLooseWhitespace(node.value ?? "");
		case "image":
		case "imageReference":
			return normalizeTextValue(node.alt ?? "");
		case "footnoteReference":
			return normalizeTextValue(node.label ?? node.identifier ?? "");
		case "html":
			return normalizeHtmlValue(node.value ?? "");
		case "break":
			return "\n";
		case "definition":
		case "thematicBreak":
			return "";
		default:
			if (Array.isArray(node.children) && node.children.length > 0) {
				return joinBlocks(node.children);
			}

			return normalizeTextValue(node.value ?? "");
	}
}

function joinBlocks(children: MarkdownAstNode[] | undefined): string {
	return (children ?? [])
		.map((child) => renderNode(child))
		.filter((value) => value.length > 0)
		.join("\n");
}

function joinInline(children: MarkdownAstNode[] | undefined): string {
	return (children ?? [])
		.map((child) => renderNode(child))
		.filter((value) => value.length > 0)
		.join("");
}

function normalizeTextValue(value: string): string {
	return normalizeLooseWhitespace(
		value
			.replace(/!\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
			.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
			.replace(/!\[\[([^\]]+)\]\]/g, "$1")
			.replace(/\[\[([^\]]+)\]\]/g, "$1")
			.replace(/^\s*\[![^\]]+\][+-]?\s*/gm, ""),
	);
}

function normalizeHtmlValue(value: string): string {
	if (/^<!--[\s\S]*-->$/.test(value.trim())) {
		return "";
	}

	return normalizeLooseWhitespace(
		value
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<[^>]+>/g, " "),
	);
}

function normalizeLooseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ");
}

function collapseSemanticWhitespace(value: string): string {
	return normalizeLooseWhitespace(value).trim();
}
