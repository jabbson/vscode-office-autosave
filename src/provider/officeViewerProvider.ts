import { ReactApp } from '@/common/reactApp';
import { getFileSuffix } from '@/common/fileSuffix';
import * as vscode from 'vscode';
import { Handler } from '../common/handler';
import { Util } from '../common/util';
import { handleImage, isImage } from './handlers/imageHanlder';
import { handleSvg } from './handlers/svgHandler';
import { emitFileOfficeOpen, isVirtualUri, readUriText } from './handlers/officeContent';
import { handleCommonEvent } from './compress/commonHandler';
import { TelemetryService } from '@/service/telemetryService';
import { extensionResource, getExtensionResourceRoots, readExtensionText } from '@/common/extensionResource';
import { isUriReadOnly } from '@/common/fileReadOnly';
import {
	beginSave,
	getHandler,
	isEditable,
	provideBytes,
	registerDoc,
	requestBytes,
	unregisterDoc,
} from '@/common/saveBridge';

/** Suffixes whose route renders an editable editor with its own save round-trip. */
const EDITABLE_SUFFIXES = new Set(['.docx', '.dotx']);

/**
 * support view office files
 *
 * Writable custom editor: editable routes (docx/dotx) get a real VS Code working
 * copy so `files.autoSave` (afterDelay / onFocusChange / onWindowChange) drives
 * saves. Non-editable routes (pdf/image/font/zip/parquet/html/...) never fire a
 * change event, so they stay clean and every save call is a no-op for them.
 */
export class OfficeViewerProvider implements vscode.CustomEditorProvider<vscode.CustomDocument> {

	private readonly _onDidChangeCustomDocument =
		new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<vscode.CustomDocument>>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	constructor(private context: vscode.ExtensionContext) { }

	bindCustomEditors(viewOption: { webviewOptions: vscode.WebviewPanelOptions }) {
		return [
			vscode.window.registerCustomEditorProvider('cweijan.officeViewer', this, viewOption),
			vscode.window.registerCustomEditorProvider('cweijan.htmlViewer', this, viewOption),
			vscode.window.registerCustomEditorProvider('cweijan.imageViewer', this, viewOption),
			vscode.window.registerCustomEditorProvider('cweijan.parquetViewer', this, viewOption),
		];
	}

	public openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): vscode.CustomDocument | Thenable<vscode.CustomDocument> {
		return { uri, dispose: (): void => { } };
	}
	public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
		const uri = document.uri;
		const webview = webviewPanel.webview;
		const folderPath = vscode.Uri.joinPath(uri, '..');
		webview.options = {
			enableScripts: true,
			localResourceRoots: [...getExtensionResourceRoots(this.context), folderPath],
		};

		const handler = Handler.bind(webviewPanel, uri);

		let route: string;
		const suffix = getFileSuffix(uri.fsPath);
		const isSvg = /\.svg$/i.test(suffix);
		// A doc is editable only for word routes AND when the file itself is
		// writable. Read-only docx keeps the existing out-of-band Save-As flow.
		const editable = EDITABLE_SUFFIXES.has(suffix) && !(await isUriReadOnly(uri));
		if (editable) {
			this.bindEditableDocument(document, webviewPanel, handler);
		}
		handleCommonEvent(uri, handler, { skipOpen: isSvg, editable });
		if (isSvg) {
			route = 'svg';
			handleSvg(handler, uri);
		} else if (isImage(suffix)) {
			handleImage(handler, uri, webview);
			route = 'image';
		}
		switch (suffix) {
			case '.xlsx':
			case '.xlsm':
			case '.xls':
			case '.csv':
			case '.tsv':
			case '.ods':
				route = 'excel';
				break;
			case '.docx':
			case '.dotx':
				route = 'word';
				break;
			case '.pptx':
			case '.pptm':
				route = 'ppt';
				break;
			case '.ttf':
			case '.woff':
			case '.woff2':
			case '.otf':
				route = 'font';
				break;
			case '.pdf':
				void this.loadPdfViewer(webview);
				break;
			case '.epub':
				route = 'epub';
				break;
			case '.icns':
				route = 'icns';
				break;
			case '.psd':
				route = 'psd';
				break;
			case '.xmind':
				route = 'xmind';
				break;
			case '.parquet':
				route = 'parquet';
				break;
			case '.htm':
			case '.html':
			case '.xhtml':
				if (isVirtualUri(uri)) {
					void this.loadVirtualHtml(webviewPanel, uri, folderPath);
				} else {
					void this.loadWorkspaceHtml(webviewPanel, uri, folderPath);
				}
				break;
			default:
				if (route) break;
				vscode.commands.executeCommand('vscode.openWith', uri, 'default');
		}
		const fileType = suffix.startsWith('.') ? suffix.slice(1) : suffix;
		TelemetryService.get()?.trackOfficeViewOpen(uri.fsPath, route, fileType);
		if (route) return ReactApp.view(webview, { route });
	}

	/**
	 * Bridge the per-panel Handler to this document's working copy: edits mark it
	 * dirty, and host-driven save/backup round-trips flow through the shared
	 * registry. `change`/`save` remain owned by commonHandler's single listeners;
	 * we only add the new `bytes`/`triggerVscodeSave` events here.
	 */
	private bindEditableDocument(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, handler: Handler) {
		const uriStr = document.uri.toString();
		registerDoc(uriStr, {
			handler,
			onChange: () => this._onDidChangeCustomDocument.fire({ document }),
		});
		handler
			.on('bytes', (content: number[]) => {
				provideBytes(uriStr, new Uint8Array(content));
			})
			.on('triggerVscodeSave', () => {
				// Route a webview manual save (Ctrl+S / editor Save UI) through VS
				// Code so it and auto-save share one write path and dirty state stays
				// truthful. No-op when the doc isn't dirty.
				void vscode.commands.executeCommand('workbench.action.files.save');
			});
		webviewPanel.onDidDispose(() => unregisterDoc(uriStr));
	}

	public async saveCustomDocument(document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		const uriStr = document.uri.toString();
		if (!isEditable(uriStr)) {
			return;
		}
		const handler = getHandler(uriStr);
		if (!handler) {
			return;
		}
		const done = beginSave(uriStr);
		handler.emit('requestSave');
		await done;
	}

	public async saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
		const bytes = await requestBytes(document.uri.toString());
		if (!bytes) {
			return;
		}
		await vscode.workspace.fs.writeFile(destination, bytes);
	}

	public async revertCustomDocument(document: vscode.CustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		const handler = getHandler(document.uri.toString());
		if (!handler) {
			return;
		}
		// Re-send the on-disk bytes; the webview remounts the editor with them,
		// discarding in-memory edits.
		await emitFileOfficeOpen(handler, document.uri, handler.panel.webview);
	}

	public async backupCustomDocument(document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
		const bytes = await requestBytes(document.uri.toString());
		if (bytes) {
			await vscode.workspace.fs.writeFile(context.destination, bytes);
		}
		return {
			id: context.destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(context.destination);
				} catch {
					// backup already removed — nothing to clean up
				}
			},
		};
	}

	private async loadPdfViewer(webview: vscode.Webview) {
		const html = await readExtensionText(this.context, 'resource', 'pdf', 'viewer.html');
		webview.html = html.replace('{{baseUrl}}', this.getBaseUrl(webview, 'pdf'));
	}

	private async loadWorkspaceHtml(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri, folderPath: vscode.Uri) {
		const webview = webviewPanel.webview;
		const render = async () => {
			const content = await readUriText(uri);
			webview.html = Util.buildPath(content, webview, folderPath);
		};
		await render();
		Util.listen(webviewPanel, uri, () => {
			void render();
		});
	}

	private async loadVirtualHtml(webviewPanel: vscode.WebviewPanel, uri: vscode.Uri, folderPath: vscode.Uri) {
		try {
			const content = await readUriText(uri);
			webviewPanel.webview.html = Util.buildPath(content, webviewPanel.webview, folderPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to read HTML';
			webviewPanel.webview.html = `<pre>${message}</pre>`;
		}
	}

	private getBaseUrl(webview: vscode.Webview, path: string) {
		const baseUrl = webview.asWebviewUri(extensionResource(this.context, 'resource', path))
			.toString().replace(/\?.+$/, '').replace('https://git', 'https://file');
		return baseUrl;
	}

}
