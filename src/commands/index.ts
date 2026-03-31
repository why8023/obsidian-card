import type ObcdPlugin from "../main";
import { resolveCurrentFileTarget, resolveCursorTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";

export function registerCommands(plugin: ObcdPlugin): void {
	plugin.addCommand({
		id: "open-flashcard-sidebar",
		name: "Open flashcard sidebar",
		callback: () => {
			void plugin.sidebar.open();
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-from-selection",
		name: "Generate basic flashcards from selection",
		editorCheckCallback: (checking, editor, ctx) => {
			if (resolveSelectionTarget(editor, ctx) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateFromSelection(editor, ctx);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-for-current-file",
		name: "Generate basic flashcards for current file",
		checkCallback: (checking) => {
			if (resolveCurrentFileTarget(plugin.app) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateForCurrentFile();
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-up-to-cursor",
		name: "Generate basic flashcards up to cursor",
		editorCheckCallback: (checking, editor, ctx) => {
			if (resolveCursorTarget(editor, ctx) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateUpToCursor(editor, ctx);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-for-current-section",
		name: "Generate basic flashcards for current section",
		editorCheckCallback: (checking, editor, ctx) => {
			if (resolveCursorTarget(editor, ctx) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateForCurrentSection(editor, ctx);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-for-folder",
		name: "Generate basic flashcards for folder",
		checkCallback: (checking) => {
			if (resolveFolderTarget(plugin.app) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateForFolder();
			}

			return true;
		},
	});
}
