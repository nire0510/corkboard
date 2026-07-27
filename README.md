# Corkboard

Visual sticky-note boards that live inside your codebase. Each board is a plain JSON file (`.board` / `.brd`) you can commit, diff, and share with your team.

## Features

- **Create boards** — run `Corkboard: Create New Board` from the Command Palette or the Explorer context menu. Creates a `<name>.board` file (refuses to overwrite an existing one).
- **Visual editor** — clicking a `.board`/`.brd` file opens it as a visual board.
- **Add notes** — click the floating **+** button (bottom-right), or right-click an empty spot → *Create a note*. New notes are immediately editable.
- **Edit text** — double-click a note to edit; click outside or press `Esc` to commit.
- **Move & resize** — drag notes anywhere; drag the bottom-right corner handle to resize.
- **Note context menu** — right-click a note for *Delete note* and *Change colors…* (hover reveals 5 color swatches: yellow, pink, blue, green, orange).
- **Board context menu** — right-click empty space for *Create a note* and *Delete all notes*.
- **Plain-text storage** — save, dirty indicator, undo/redo (`Cmd/Ctrl+Z`), git diffs, and hot exit all work because the board is a regular text document. You can even open the raw JSON via *Reopen Editor With… → Text Editor*.

## File format

```json
{
  "version": 1,
  "notes": [
    {
      "id": "n-abc123",
      "text": "Refactor the auth module",
      "x": 120,
      "y": 80,
      "width": 200,
      "height": 140,
      "color": "yellow",
      "z": 3
    }
  ]
}
```

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code (Run Extension) to launch an Extension Development Host, or package it:

```bash
npx @vscode/vsce package   # produces corkboard-0.1.0.vsix
code --install-extension corkboard-0.1.0.vsix
```

## Project structure

- `src/extension.ts` — activation + `createBoard` command
- `src/boardEditorProvider.ts` — `CustomTextEditorProvider` wiring the JSON document to the webview
- `media/board.js` / `media/board.css` — the board UI (notes, drag, resize, context menus)
