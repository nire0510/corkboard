import * as vscode from 'vscode';
import { BoardEditorProvider } from './boardEditorProvider';

const EMPTY_BOARD = JSON.stringify({ version: 1, notes: [] }, null, 2) + '\n';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(BoardEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('notesBoards.createBoard', async (resource?: vscode.Uri) => {
      const targetDir = await resolveTargetDirectory(resource);
      if (!targetDir) {
        vscode.window.showErrorMessage('Corkboard: open a folder or workspace first.');
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Board name',
        value: 'notes',
        validateInput: (value) => {
          if (!value.trim()) {
            return 'Name must not be empty.';
          }
          if (/[\\/:*?"<>|]/.test(value)) {
            return 'Name contains invalid file characters.';
          }
          return undefined;
        },
      });
      if (name === undefined) {
        return; // cancelled
      }

      const fileName = name.trim().endsWith('.board') || name.trim().endsWith('.brd')
        ? name.trim()
        : `${name.trim()}.board`;
      const fileUri = vscode.Uri.joinPath(targetDir, fileName);

      if (await fileExists(fileUri)) {
        vscode.window.showErrorMessage(
          `Corkboard: "${fileName}" already exists. Choose another name.`
        );
        return;
      }

      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(EMPTY_BOARD));
      await vscode.commands.executeCommand(
        'vscode.openWith',
        fileUri,
        BoardEditorProvider.viewType
      );
    })
  );
}

async function resolveTargetDirectory(resource?: vscode.Uri): Promise<vscode.Uri | undefined> {
  // Invoked from the explorer context menu on a folder or file.
  if (resource) {
    try {
      const stat = await vscode.workspace.fs.stat(resource);
      if (stat.type & vscode.FileType.Directory) {
        return resource;
      }
      return vscode.Uri.joinPath(resource, '..');
    } catch {
      // fall through to workspace folders
    }
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }
  const picked = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select a workspace folder for the new board',
  });
  return picked?.uri;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export function deactivate(): void {
  // nothing to clean up
}
