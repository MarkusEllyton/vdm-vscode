// SPDX-License-Identifier: GPL-3.0-or-later

import {
    WorkspaceFolder,
    Uri,
    WebviewPanel,
    Disposable,
    window,
    ViewColumn,
    workspace,
    Webview,
    Location,
    Event,
    ExtensionContext,
    commands,
    DocumentSelector,
    debug,
    ProgressLocation,
    Progress,
    TabInputWebview,
} from "vscode";
import { ClientManager } from "../../ClientManager";
import * as util from "../../util/Util";
import { isSameUri, isSameWorkspaceFolder } from "../../util/WorkspaceFoldersUtil";
import { VdmDapSupport } from "../../dap/VdmDapSupport";
import { ProofObligationCounterExample, ProofObligationWitness, QuickCheckInfo } from "../protocol/ProofObligationGeneration";
import { CancellationToken } from "vscode-languageclient";

export interface ProofObligation {
    id: number;
    kind: string;
    name: string[];
    location: Location;
    source: string | string[];
    status?: string;
    provedBy?: string;
    message?: string;
    counterexample?: ProofObligationCounterExample;
    witness?: ProofObligationWitness;
}

export interface ProofObligationProvider {
    onDidChangeProofObligations: Event<boolean>;
    provideProofObligations(uri: Uri): Thenable<ProofObligation[]>;
    quickCheckProvider: boolean;
    runQuickCheck(
        wsFolder: Uri,
        poIds: number[],
        token?: CancellationToken,
        progress?: Progress<{
            message?: string;
            increment?: number;
        }>
    ): Thenable<QuickCheckInfo[]>;
}

interface Message {
    command: string;
    data?: any;
}

class OnReady {
    private _used: boolean;

    constructor(private _resolve: () => void, private _reject: (error: any) => void) {
        this._used = false;
    }

    public get isUsed(): boolean {
        return this._used;
    }

    public resolve(): void {
        this._used = true;
        this._resolve();
    }

    public reject(error: any): void {
        this._used = true;
        this._reject(error);
    }
}

export class ProofObligationPanel implements Disposable {
    private static _providers: { selector: DocumentSelector; provider: ProofObligationProvider }[] = [];

    private _panel: WebviewPanel;
    private _lastWsFolder: WorkspaceFolder;
    private _lastUri: Uri;
    private _disposables: Disposable[] = [];
    private _pos: ProofObligation[];

    private onReady: Promise<void>;
    private _onReadyCallbacks: OnReady;

    constructor(private readonly _context: ExtensionContext, clientManager: ClientManager) {
        this.onReady = new Promise<void>((resolve, reject) => {
            this._onReadyCallbacks = new OnReady(resolve, reject);
        });

        // Workaround to bug: https://github.com/microsoft/vscode/issues/188257
        // disposing of the WebviewPanel on extension deactivation does not close the panel,
        // leaving it orphaned and unresponsive when the extension activates again.
        const orphanedTabs = window.tabGroups.all
            .flatMap((tabGroup) => tabGroup.tabs)
            .filter((tab) => {
                if (tab.input instanceof TabInputWebview) {
                    return tab.input.viewType.includes(this.viewType);
                }

                return false;
            });

        window.tabGroups.close(orphanedTabs);

        this._disposables.push(
            commands.registerCommand(
                `vdm-vscode.pog.run`,
                async (uri: Uri) => {
                    if (Object.values(uri).length === 0) {
                        window.showWarningMessage(
                            "Proof Obligation Generation failed. POG cannot be run on multiple folders in a multi-root workspace, choose a more specific target."
                        );
                        return;
                    }

                    const wsFolder: WorkspaceFolder = workspace.getWorkspaceFolder(uri);
                    if (!wsFolder) {
                        throw Error(`[POG]: Cannot find workspace folder for uri: ${uri.toString()}`);
                    }
                    // If in a multi project workspace environment the user could utilise the pog.run command on a project for which no client (and therefore server) has been started.
                    // So check if a client is present for the workspacefolder or else start it.
                    if (!clientManager.get(wsFolder)) {
                        await clientManager.launchClientForWorkspace(wsFolder);
                    }
                    this.onRunPog(uri);
                },
                this
            )
        );
        this._disposables.push(commands.registerCommand(`vdm-vscode.pog.update`, this.onUpdate, this));
    }

    public get viewType(): string {
        return `${this._context.extension.id}.proofObligationPanel`;
    }

    private get _resourcesUri(): Uri {
        return Uri.joinPath(this._context.extensionUri, "resources");
    }

    private get _webviewsUri(): Uri {
        return Uri.joinPath(this._context.extensionUri, "dist", "webviews");
    }

    public static registerProofObligationProvider(documentSelector: DocumentSelector, provider: ProofObligationProvider): Disposable {
        this._providers.push({ selector: documentSelector, provider: provider });
        commands.executeCommand("setContext", `vdm-vscode.pog.run`, true);

        let listener = provider.onDidChangeProofObligations((e) => commands.executeCommand(`vdm-vscode.pog.update`, e));

        return {
            dispose: () => {
                listener.dispose();
                this._providers = this._providers.filter((p) => p.selector !== documentSelector || p.provider !== provider);
                if (this._providers.length === 0) {
                    commands.executeCommand("setContext", `vdm-vscode.pog.run`, false);
                }
            },
        };
    }

    private getPOProvider(uri: Uri) {
        // There can only ever be one provider that matches a given URI as a provider is unique per client.
        // It's impossible for a file to be present in multiple workspace folders.
        return ProofObligationPanel._providers.find((p) => util.match(p.selector, uri));
    }

    protected async onRunPog(uri: Uri) {
        this._pos = [];

        const poProvider = this.getPOProvider(uri);
        try {
            let res = await poProvider.provider.provideProofObligations(uri);
            this._pos = [...res];
            this.clearWarning();
        } catch (e) {
            this.displayWarning();
            console.warn(`[Proof Obligation View] Provider failed with message: ${e}`);
        }

        let wsFolder = workspace.getWorkspaceFolder(uri);
        this.createWebView(poProvider.provider.quickCheckProvider, uri);
        this.updateContent();

        this._lastUri = uri;
        this._lastWsFolder = wsFolder;
    }

    protected async onRunQuickCheck(
        uri: Uri,
        poIds: number[],
        token?: CancellationToken,
        progress?: Progress<{
            message?: string;
            increment?: number;
        }>
    ) {
        const poProvider = this.getPOProvider(uri);

        try {
            return await poProvider.provider.runQuickCheck(this._lastWsFolder.uri, poIds, token, progress);
        } catch (e) {
            window.showErrorMessage(e);
            console.warn(`[Proof Obligation View] QuickCheck provider failed.`);
        }
    }

    protected onUpdate(canRun: boolean) {
        // Only perform actions if POG View exists
        if (this._panel) {
            let uri = this._lastUri;

            // Switch to active editor is on a file from the clients workspace
            const activeEditor = window.activeTextEditor?.document?.uri;

            if (activeEditor !== undefined) {
                let activeWsFolder = workspace.getWorkspaceFolder(activeEditor);
                if (!isSameWorkspaceFolder(activeWsFolder, this._lastWsFolder)) {
                    uri = activeWsFolder.uri;
                }
            }

            // If POG is possible
            if (canRun) {
                this.onRunPog(uri);
            } else {
                // Display warning that POs may be outdated
                this.displayWarning();
            }
        }
    }

    private deleteQcInfo(po: ProofObligation): ProofObligation {
        delete po["provedBy"];
        delete po["message"];
        delete po["counterexample"];
        delete po["witness"];

        return po;
    }

    private addQuickCheckInfoToPos(pos: Array<ProofObligation>, qcInfos: Array<QuickCheckInfo>): Array<ProofObligation> {
        const qcInfoMap: Record<number, QuickCheckInfo> = qcInfos.reduce((_qcInfoMap, _qcInfo) => {
            _qcInfoMap[_qcInfo.id] = _qcInfo;
            return _qcInfoMap;
        }, {});

        return pos.reduce((newPos, po) => {
            const matchingInfo = qcInfoMap[po.id];

            if (matchingInfo) {
                this.deleteQcInfo(po);
                newPos.push(Object.assign(po, matchingInfo));
            } else {
                newPos.push(po);
            }

            return newPos;
        }, []);
    }

    private getPanelTitle(uri: Uri): string {
        const wsFolder = workspace.getWorkspaceFolder(uri);
        const relPath = workspace.asRelativePath(uri, false);

        let title = `Proof Obligations` + (wsFolder ? ": " + wsFolder.name : "");

        if (!isSameUri(uri, wsFolder.uri)) {
            title += ` [${relPath}]`;
        }

        return title;
    }

    protected createWebView(withQuickCheck: boolean, uri?: Uri) {
        // Define which column the po view should be in
        const column = window.activeTextEditor ? ViewColumn.Beside : ViewColumn.Two;

        // Check if a panel already exists
        if (this._panel) {
            // Check if panel is for another workspace folder
            if (uri && !isSameUri(uri, this._lastUri)) {
                this._panel.title = this.getPanelTitle(uri);
            }

            this._panel.reveal(column, true);
        } else {
            // Create panel
            if (this._onReadyCallbacks.isUsed) {
                this.onReady = new Promise<void>((resolve, reject) => {
                    this._onReadyCallbacks = new OnReady(resolve, reject);
                });
            }

            this._panel =
                this._panel ||
                window.createWebviewPanel(
                    this.viewType,
                    this.getPanelTitle(uri),
                    {
                        viewColumn: column,
                        preserveFocus: true,
                    },
                    {
                        enableScripts: true, // Enable javascript in the webview
                        localResourceRoots: [this._resourcesUri, this._webviewsUri], // Restrict the webview to only load content from the extension's `resources` directory.
                        retainContextWhenHidden: true, // Retain state when PO view goes into the background
                    }
                );

            // Listen for when the panel is disposed
            // This happens when the user closes the panel or when the panel is closed programatically
            this._panel.onDidDispose(this.clearPanelInfo, this, this._disposables);

            // Handle messages from the webview
            this._panel.webview.onDidReceiveMessage(
                async (message: Message) => {
                    console.log(`[Proof Obligation View] Received new message: ${message.command}`);
                    switch (message.command) {
                        case "readyToReceive":
                            this._onReadyCallbacks.resolve();
                            break;
                        case "goToSymbol":
                            // Find path of po with id
                            let po = this._pos.find((d) => d.id.toString() === message.data.toString());
                            let path = Uri.parse(po.location.uri.toString()).path;

                            // Open the specification file with the symbol responsible for the po
                            let doc = await workspace.openTextDocument(path);

                            // Show the file
                            window.showTextDocument(doc.uri, { selection: po.location.range, viewColumn: 1 });
                            break;
                        case "debugQCRun":
                            const requestBody = {
                                expression: message.data,
                                context: "repl",
                            };

                            VdmDapSupport.getAdHocVdmDebugger(this._lastWsFolder, false).then((ds) => {
                                setTimeout(() => ds.customRequest("evaluate", requestBody).then(() => debug.stopDebugging(ds)), 100);
                            });
                            break;
                        case "runQC":
                            window.withProgress(
                                {
                                    location: ProgressLocation.Notification,
                                    title: `Running QuickCheck`,
                                    cancellable: true,
                                },
                                async (_progress, _token) => {
                                    try {
                                        const qcInfos = await this.onRunQuickCheck(
                                            this._lastUri,
                                            message.data.poIds ?? [],
                                            _token,
                                            _progress
                                        );
                                        const posWithQc = this.addQuickCheckInfoToPos(this._pos, qcInfos);

                                        await this._panel.webview.postMessage({ command: "newPOs", pos: posWithQc });
                                    } catch (err) {
                                        await this._panel.webview.postMessage({ command: "newPOs", pos: this._pos });
                                        throw err;
                                    }
                                }
                            );

                            break;
                    }
                },
                null,
                this._disposables
            );

            // Generate the html for the webview
            this._panel.webview.html = this.buildHtmlForWebview(this._panel.webview, withQuickCheck);
        }
    }

    private clearPanelInfo() {
        this._panel = undefined;
        this._lastWsFolder = undefined;
        this._lastUri = undefined;
    }

    private displayWarning() {
        // Display warning that PO generation failed in webview
        this.onReady.then(() => {
            this._panel.webview.postMessage({ command: "posInvalid" });
        });
    }

    private clearWarning() {
        // HIde warning that PO generation failed in webview
        this.onReady.then(() => {
            this._panel.webview.postMessage({ command: "posValid" });
        });
    }

    protected updateContent() {
        this.onReady.then(() => {
            this._panel.webview.postMessage({ command: "newPOs", pos: this._pos });
        });
    }

    public dispose() {
        commands.executeCommand("setContext", `vdm-vscode.pog.run`, false);

        // Clean up our resources
        if (this._panel) {
            this._panel.dispose();
        }

        while (this._disposables.length) {
            this._disposables.pop().dispose();
        }
    }

    private buildHtmlForWebview(webview: Webview, withQuickCheck: boolean) {
        const scriptUri = webview.asWebviewUri(Uri.joinPath(this._webviewsUri, "webviews.js"));
        const styleUri = webview.asWebviewUri(Uri.joinPath(this._resourcesUri, "webviews", "poView", "poView.css"));
        const codiconsUri = webview.asWebviewUri(Uri.joinPath(this._webviewsUri, "codicons", "codicon.css"));

        // Use a nonce to only allow specific scripts to be run
        const scriptNonce = this.generateNonce();

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${scriptNonce}'; font-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${styleUri}" rel="stylesheet">
            <link href="${codiconsUri}" rel="stylesheet">
        </head>
        <body>
            <div id="root"></div>
            <script type="module" nonce="${scriptNonce}">
                import { renderWebview} from "${scriptUri}"; 
                
                renderWebview("root", "ProofObligations", acquireVsCodeApi(), "${scriptNonce}", {
                    "enableQuickCheck": ${withQuickCheck}
                });
            </script>
        </body>
        </html>`;
    }

    private generateNonce() {
        let text = "";
        const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
