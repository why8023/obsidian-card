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
		description: "Show the stored target label for each generated card.",
		previewLength: 56,
		getValue: (card) => card.targetLabel,
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
		description: "Show the generated card type.",
		previewLength: 18,
		getValue: (card) => card.type.length > 0 ? card.type : "Card",
	},
];

export function getSearchableCardValues(card: ExistingCardEntry): string[] {
	return [
		card.front,
		card.targetLabel,
		card.tags.join(" "),
		card.type,
	];
}

export function findSidebarTableColumn(columnId: SidebarTableColumnId): SidebarTableColumnDefinition | undefined {
	return SIDEBAR_TABLE_COLUMNS.find((column) => column.id === columnId);
}
