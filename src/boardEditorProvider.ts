import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Custom text editor that renders .board / .brd files as a visual notes board.
 *
 * The document itself stays a plain JSON text file, which means save, dirty
 * indicators, undo/redo, git diffs and hot exit all work out of the box.
 */
export class BoardEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'notesBoards.boardEditor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      BoardEditorProvider.viewType,
      new BoardEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // Guard so our own edits don't bounce back into the webview as "external".
    let pendingWebviewEdit = false;

    const postDocument = () => {
      webviewPanel.webview.postMessage({
        type: 'load',
        text: document.getText(),
      });
    };

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (pendingWebviewEdit) {
        pendingWebviewEdit = false;
        return;
      }
      // External change (git checkout, text editor, undo, ...) -> refresh view.
      postDocument();
    });

    webviewPanel.onDidDispose(() => changeSubscription.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          postDocument();
          break;
        case 'update': {
          const newText: string = message.text;
          if (newText === document.getText()) {
            return;
          }
          pendingWebviewEdit = true;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            newText
          );
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            pendingWebviewEdit = false;
          }
          break;
        }
        case 'error':
          vscode.window.showErrorMessage(`Notes Boards: ${message.message}`);
          break;
        case 'info':
          vscode.window.showInformationMessage(`Notes Boards: ${message.message}`);
          break;
        case 'openLink': {
          const uri = vscode.Uri.parse(message.url);
          if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
            vscode.env.openExternal(uri);
          }
          break;
        }
        case 'exportPng': {
          const base64 = (message.dataUrl as string).replace(/^data:image\/png;base64,/, '');
          const buffer = Buffer.from(base64, 'base64');
          const baseName = path.basename(document.uri.fsPath).replace(/\.[^.]+$/, '') || 'board';
          const defaultUri = vscode.Uri.file(
            path.join(path.dirname(document.uri.fsPath), `${baseName}.png`)
          );
          const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'PNG Image': ['png'] },
          });
          if (saveUri) {
            await vscode.workspace.fs.writeFile(saveUri, buffer);
            vscode.window.showInformationMessage(`Board exported to ${path.basename(saveUri.fsPath)}.`);
          }
          break;
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'board.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'board.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Notes Board</title>
</head>
<body>
  <div id="board" tabindex="0"></div>
  <button id="export-png-btn" title="Export board as PNG" aria-label="Export board as PNG">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
      <circle cx="12" cy="13" r="4"></circle>
    </svg>
  </button>
  <button id="add-note-btn" title="Add note" aria-label="Add note">+</button>
  <div id="context-menu" class="context-menu" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
