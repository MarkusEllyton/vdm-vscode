// SPDX-License-Identifier: GPL-3.0-or-later

// import { Uri, WorkspaceFolder, commands, workspace } from "vscode";
// import { ClientManager } from "../ClientManager";
// import AutoDisposable from "../helper/AutoDisposable";

// import * as Util from "../util/Util";

// // TODO: Write base class with shared logic for annotations and plugins.
// export abstract class ManagementBase extends AutoDisposable {
//     constructor(protected readonly clientManager: ClientManager, contextKey: string, command: string) {
//         super();
//         commands.executeCommand("setContext", contextKey, true);
//         Util.registerCommand(this._disposables, command, (inputUri: Uri) => this.handleManage(workspace.getWorkspaceFolder(inputUri)));
//     }

//     protected handleManage(wsFolder: WorkspaceFolder): Promise<void> {
//         return;
//     }
// }
