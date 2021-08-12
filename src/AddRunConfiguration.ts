// SPDX-License-Identifier: GPL-3.0-or-later

import * as vscode from "vscode";
import { commands, DebugConfiguration, ExtensionContext, RelativePattern, Uri, window, workspace, WorkspaceFolder } from "vscode";
import { SpecificationLanguageClient } from "./SpecificationLanguageClient";
import * as util from "./Util"


export class AddRunConfigurationHandler {

    constructor(
        private readonly clients: Map<string, SpecificationLanguageClient>,
        private context: ExtensionContext
    ) {
        this.context = context;
        this.registerCommand((inputUri: Uri) => this.addRunConfiguration(workspace.getWorkspaceFolder(inputUri)));
    }

    private registerCommand = (callback: (...args: any[]) => any) => {
        let disposable = commands.registerCommand("vdm-vscode.addRunConfiguration", callback)
        this.context.subscriptions.push(disposable);
        return disposable;
    };

    private async addRunConfiguration(wsFolder: WorkspaceFolder) {

        let dialect = null;
        const dialects = {"vdmsl" : "SL", "vdmpp" : "PP", "vdmrt" : "RT"}

        window.setStatusBarMessage(`Adding Run Configuration.`, new Promise(async (resolve, reject) => {
            let client = this.clients.get(wsFolder.uri.toString());
            if (client) {
                dialect = dialects[client.dialect];
            } else {
                console.log(`No client found for the folder: ${wsFolder.name}`);

                // Guess dialect
                for (var dp in dialects){
                   let pattern = new RelativePattern(wsFolder.uri.path, "*." + dp);
                   let res = await workspace.findFiles(pattern,null,1)
                   if(res.length == 1) dialect = dialects[dp];
                } 

                if(dialect == null)
                {
                    // TODO could insert a selection window here so that the user can manually choose the dialect if we can't guess
                    window.showInformationMessage(`Add library failed! Unable to guess VDM dialect for workspace`); 
                    reject();
                    return;
                }
            }

            let selectedClass: string;
            let selectedCommand: string;

            // Prompt user for entry point class/module and function/operation       
            if(dialect == "SL") {
                selectedClass = await window.showInputBox({
                    prompt: "Input entry point Module",
                    placeHolder: "Module",
                    value: "DEFAULT",
                });
            } else {
                selectedClass = await window.showInputBox({
                    prompt: "Input name of the entry Class",
                    placeHolder: "Class"
                });
            }
            if (selectedClass != undefined) {
                selectedCommand = await window.showInputBox({
                    prompt: "Input entry point function/operation",
                    placeHolder: "Run()"
                }); 
            }

            // None selected 
            if(selectedClass === undefined || selectedCommand === undefined) return resolve(`Empty selection. Add run configuration completed.`)

            // Check for command arguments
            let selectedCommandArguments: string = null
            if (selectedCommand.includes("(")){
                selectedCommandArguments = selectedCommand.slice(selectedCommand.indexOf("(")+1,selectedCommand.lastIndexOf(")"));
                selectedCommand = selectedCommand.slice(0,selectedCommand.indexOf("("))
            }


            // Create run configuration
            let debugConfiguration: DebugConfiguration;
            if(dialect == "SL") {
                debugConfiguration = {
                    name: "Launch VDM Debug from Entry Point",    // The name of the debug session.
                    type: "vdm",               // The type of the debug session.
                    request: "launch",         // The request type of the debug session.
                    noDebug: false,
                    defaultName: `${selectedClass}`,
                    command: `print ${selectedCommand}(${selectedCommandArguments})`
                }
                
            } else {
                debugConfiguration = {
                    name: "Launch VDM Debug from Entry Point",    // The name of the debug session.
                    type: "vdm",               // The type of the debug session.
                    request: "launch",         // The request type of the debug session.
                    noDebug: false,
                    defaultName: null,
                    command: `print new ${selectedClass}().${selectedCommand}()`,
                    arguments: (selectedCommandArguments == null ? null : `${selectedCommandArguments}`)
                }
            }

            // Save run configuration
            let position = util.saveRunConfiguration(debugConfiguration, wsFolder);

            // Open launch file
            vscode.window.showTextDocument(
                Uri.joinPath(wsFolder.uri, ".vscode", "launch.json"),
                {preview: true, preserveFocus: true}
            )
        }));
    }
}
