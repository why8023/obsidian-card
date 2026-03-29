import type { ExistingCardEntry, SidebarTableColumnId } from "../types";

export interface SidebarTableColumnDefinition {
	id: SidebarTableColumnId;
	label: string;
	description: string;
	previewLength: number;
	getValue: (card: ExistingCardEntry) => string;
}

export const SIDEBAR_TABLE_COLUMNS: SidebarTableColumnDefinition[] = [
	{
		id: "target",
		label: "Target",
		description: "Show the heading path or selection target for each card.",
		previewLength: 56,
		getValue: (card) => getCardTargetLabel(card),
	},
	{
		id: "tags",
		label: "Tags",
		description: "Show the tags stored on the card-start marker.",
		previewLength: 36,
		getValue: (card) => card.tags.join(", "),
	},
	{
		id: "kind",
		label: "Type",
		description: "Show the source block type from the card metadata.",
		previewLength: 18,
		getValue: (card) => getCardKindLabel(card.metadata.kind),
	},
	{
		id: "sectionKey",
		label: "Section key",
		description: "Show the internal section key stored on the card metadata.",
		previewLength: 42,
		getValue: (card) => card.metadata.sectionKey,
	},
];

export function getCardTargetLabel(card: ExistingCardEntry): string {
	if (card.metadata.headingPath.length > 0) {
		return card.metadata.headingPath.join(" > ");
	}

	if (card.metadata.kind === "selection") {
		return "Selection";
	}

	return card.titleHint;
}

export function getSearchableCardValues(card: ExistingCardEntry): string[] {
	return [
		card.front,
		getCardTargetLabel(card),
		card.tags.join(" "),
		getCardKindLabel(card.metadata.kind),
		card.metadata.sectionKey,
	];
}

export function findSidebarTableColumn(columnId: SidebarTableColumnId): SidebarTableColumnDefinition | undefined {
	return SIDEBAR_TABLE_COLUMNS.find((column) => column.id === columnId);
}

function getCardKindLabel(kind: ExistingCardEntry["metadata"]["kind"]): string {
	switch (kind) {
		case "heading":
			return "Heading";
		case "preamble":
			return "Preamble";
		case "selection":
			return "Selection";
		default:
			return kind;
	}
}
