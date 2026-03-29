import { type App, type Editor, type MarkdownFileInfo, TAbstractFile, TFile, TFolder } from "obsidian";

import type { GenerationTarget } from "../types";

const FOLDER_SELECTION_SELECTORS = [
	".workspace-leaf-content[data-type='file-explorer'] .nav-folder-title.is-active[data-path]",
	".workspace-leaf-content[data-type='file-explorer'] .nav-folder-title.mod-active[data-path]",
	".workspace-leaf-content[data-type='file-explorer'] .tree-item-self.nav-folder-title.is-selected[data-path]",
	".workspace-leaf-content[data-type='file-explorer'] .tree-item-self.nav-folder-title.is-focused[data-path]",
];

export function resolveSelectionTarget(editor: Editor, ctx: MarkdownFileInfo): GenerationTarget | null {
	const file = ctx.file;
	if (!isMarkdownFile(file)) {
		return null;
	}

	const selectionText = editor.getSelection().trim();
	if (selectionText.length === 0) {
		return null;
	}

	const from = editor.posToOffset(editor.getCursor("from"));
	const to = editor.posToOffset(editor.getCursor("to"));

	return {
		file,
		filePath: file.path,
		mode: "selection",
		selectedRange: {
			from,
			to,
		},
	};
}

export function resolveCursorTarget(editor: Editor, ctx: MarkdownFileInfo): GenerationTarget | null {
	const file = ctx.file;
	if (!isMarkdownFile(file)) {
		return null;
	}

	return {
		file,
		filePath: file.path,
		mode: "cursor-file",
		cursorOffset: editor.posToOffset(editor.getCursor()),
	};
}

export function resolveCurrentFileTarget(app: App): GenerationTarget | null {
	const file = app.workspace.getActiveFile();
	if (!isMarkdownFile(file)) {
		return null;
	}

	return {
		file,
		filePath: file.path,
		mode: "file",
	};
}

export function resolveFolderTarget(app: App): TFolder | null {
	const explorerFolder = resolveFolderFromExplorer(app);
	if (explorerFolder !== null) {
		return explorerFolder;
	}

	const activeFile = app.workspace.getActiveFile();
	return activeFile?.parent ?? null;
}

export function listMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];

	collectMarkdownFiles(folder, files);

	files.sort((left, right) => left.path.localeCompare(right.path));
	return files;
}

function resolveFolderFromExplorer(app: App): TFolder | null {
	const rootDocument = app.workspace.containerEl.doc;

	for (const selector of FOLDER_SELECTION_SELECTORS) {
		const selectedElement = rootDocument.querySelector<HTMLElement>(selector);
		const path = selectedElement?.getAttr("data-path");
		if (!path) {
			continue;
		}

		const abstractFile = app.vault.getAbstractFileByPath(path);
		if (abstractFile instanceof TFolder) {
			return abstractFile;
		}
	}

	return null;
}

function collectMarkdownFiles(node: TAbstractFile, results: TFile[]): void {
	if (node instanceof TFile) {
		if (node.extension.toLowerCase() === "md") {
			results.push(node);
		}
		return;
	}

	if (!(node instanceof TFolder)) {
		return;
	}

	for (const child of node.children) {
		collectMarkdownFiles(child, results);
	}
}

function isMarkdownFile(file: TFile | null): file is TFile {
	return file !== null && file.extension.toLowerCase() === "md";
}
