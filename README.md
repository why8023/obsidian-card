# OBCD

OBCD is an Obsidian community plugin for generating, reviewing, and managing BASIC flashcards directly inside Markdown notes.

## Features

- Generate flashcards from the current selection, current file, content up to the cursor, or an entire folder.
- Review generated candidates in the sidebar before inserting them into the note.
- Track inserted cards in the sidebar, reveal them in the editor, delete them in bulk, and undo deletions.
- Configure provider presets, request settings, and folder-specific prompt templates.

## Development

This project uses `npm` and `esbuild`.

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

## Local testing

The release artifacts are:

- `main.js`
- `manifest.json`
- `styles.css`

For local testing, copy those files into:

```text
<Vault>/.obsidian/plugins/obcd/
```

If you develop inside the vault directly, keep the plugin folder name aligned with `manifest.json`'s `id`.
