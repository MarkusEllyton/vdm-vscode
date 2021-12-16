// SPDX-License-Identifier: GPL-3.0-or-later

import * as util from "./Util"
import * as vscode from "vscode"
import { commands, ConfigurationTarget, DebugConfiguration, ExtensionContext, RelativePattern, Uri, window, workspace, WorkspaceFolder } from "vscode";
import { SpecificationLanguageClient } from "./SpecificationLanguageClient";
import { VdmDebugConfiguration } from "./VdmDapSupport";

interface VdmArgument {
    name: string,
    type: string,
    value?: string
}

interface VdmLaunchLensConfiguration {
    name: string,
    defaultName: string,
    type: string,
    request: string
    noDebug: boolean,
    remoteControl: string | null,
    constructors?: [VdmArgument[]]
    applyName: string,
    applyArgs: VdmArgument[]
}

export class AddRunConfigurationHandler {
    static showArgumentTypeWarning = true;

    // Argument storage, map from workspacefolder name to arguments
    private lastConfigCtorArgs: Map<string, VdmArgument[]> = new Map;
    private lastConfigApplyArgs: Map<string, VdmArgument[]> = new Map;

    constructor(
        private readonly clients: Map<string, SpecificationLanguageClient>,
        private context: ExtensionContext
    ) {
        commands.executeCommand('setContext', 'add-runconf-show-button', true);
        this.context = context;
        util.registerCommand(this.context, "vdm-vscode.addRunConfiguration", (inputUri: Uri) => this.addRunConfiguration(workspace.getWorkspaceFolder(inputUri)))
        util.registerCommand(this.context, "vdm-vscode.addLensRunConfiguration", (input: VdmLaunchLensConfiguration) => this.addLensRunConfiguration(input))
        util.registerCommand(this.context, "vdm-vscode.addLensRunConfigurationWarning", () => this.addLensRunConfigurationWarning())
    }

    private async addRunConfiguration(wsFolder: WorkspaceFolder) {
        window.setStatusBarMessage(`Adding Run Configuration.`, new Promise(async (resolve, reject) => {
            let dialect = await this.getDialect(wsFolder);
            if (dialect == null) {
                // TODO could insert a selection window here so that the user can manually choose the dialect if we can't guess
                window.showInformationMessage(`Add run configuration failed! Unable to guess VDM dialect for workspace`);
                return reject()
            }

            // Prompt user for entry point class/module and function/operation   
            let selectedClass: string;
            let selectedCommand: string;
            if (dialect == "vdmsl") {
                selectedClass = await window.showInputBox({
                    prompt: "Input entry point Module",
                    placeHolder: "Module",
                    value: "DEFAULT",
                });
            } else {
                selectedClass = await window.showInputBox({
                    prompt: "Input name of the entry Class",
                    placeHolder: "Class(args)"
                });
            }
            if (selectedClass != undefined) {
                selectedCommand = await window.showInputBox({
                    prompt: "Input entry point function/operation",
                    placeHolder: "Run(args)"
                });
            }

            // None selected 
            if (selectedClass === undefined || selectedCommand === undefined) return resolve(`Empty selection. Add run configuration completed.`)

            // Make sure class and command has parenthesis
            if (!selectedClass.includes('(') && !selectedClass.includes(')'))
                selectedClass += "()";
            if (!selectedCommand.includes('(') && !selectedCommand.includes(')'))
                selectedCommand += "()";

            // Create run configuration
            let debugConfiguration: DebugConfiguration = {
                name: `Launch VDM Debug from ${selectedClass.substr(0, selectedClass.indexOf('('))}\`${selectedCommand}`,    // The name of the debug session.
                type: "vdm",               // The type of the debug session.
                request: "launch",         // The request type of the debug session.
                noDebug: false,
                dynamicTypeChecks: true,
                invariantsChecks: true,
                preConditionChecks: true,
                postConditionChecks: true,
                measureChecks: true
            }
            if (dialect == "vdmsl") {
                debugConfiguration.defaultName = `${selectedClass}`;
                debugConfiguration.command = `print ${selectedCommand}`;
            } else {
                debugConfiguration.defaultName = null;
                debugConfiguration.command = `print new ${selectedClass}.${selectedCommand}`;
            }

            // Save run configuration
            this.saveRunConfiguration(wsFolder, debugConfiguration);

            // Open launch file
            window.showTextDocument(
                Uri.joinPath(wsFolder.uri, ".vscode", "launch.json"),
                { preview: true, preserveFocus: true }
            )
        }));
    }

    private async addLensRunConfiguration(input: VdmLaunchLensConfiguration) {
        const wsFolder: WorkspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);
        if (wsFolder === undefined) {
            window.showInformationMessage("Could not find workspacefolder");
            return;
        }

        window.setStatusBarMessage(`Adding Run Configuration`, new Promise(async (resolve, reject) => {
            try {
                // Transfer argument values if possible
                this.transferArguments(input, wsFolder.name);

                // Create run configuration
                let runConfig: VdmDebugConfiguration = {
                    name: "Launch VDM Debug from Code Lens",
                    type: input.type,
                    request: input.request,
                    noDebug: input.noDebug,
                };

                // Add remote control
                if (input.remoteControl)
                    runConfig.remoteControl = input.remoteControl

                // Add command
                if (input.applyName) {
                    // Warn user that types might be unresolved for projects with unsaved files
                    if (AddRunConfigurationHandler.showArgumentTypeWarning &&
                        (input.applyArgs.length > 0 || input.constructors.some(c => c.length > 0)) &&
                        workspace.textDocuments.some(doc => doc.isDirty && workspace.getWorkspaceFolder(doc.uri) == wsFolder)) {
                        window.showInformationMessage("Types might be unresolved until all documents have been saved", "Do not show again").then(
                            v => { if (v) AddRunConfigurationHandler.showArgumentTypeWarning = false })
                    }

                    // Command start
                    let command = "p ";

                    // Set class and default name
                    if (input.constructors === undefined)
                        runConfig.defaultName = input.defaultName
                    else {
                        runConfig.defaultName = null;
                        let cIndex = 0;

                        // If multiple constructors to select from request the user to select one
                        if (input.constructors.length > 1) {
                            await this.requestConstructor(input.defaultName, input.constructors).then(
                                i => { cIndex = i },
                                () => { throw new Error("No constructor selected") }
                            )
                        }

                        // Add class initialisation
                        await this.requestArgumentValues(input.constructors[cIndex], input.defaultName, "constructor").then(
                            () => {
                                command += `new ${this.getCommandString(input.defaultName, input.constructors[cIndex])}.`;
                                this.lastConfigCtorArgs[wsFolder.name] = input.constructors[cIndex];
                            },
                            () => { throw new Error("Constructor arguments missing") }
                        )
                    }

                    // Add function/operation call to command
                    await this.requestArgumentValues(input.applyArgs, input.applyName, "operation/function").then(
                        () => {
                            command += this.getCommandString(input.applyName, input.applyArgs);
                            this.lastConfigApplyArgs[wsFolder.name] = input.applyArgs;
                        },
                        () => { throw new Error("Operation/function arguments missing") }
                    )

                    // Set command
                    runConfig.command = command;
                }

                // Save configuration
                this.saveRunConfiguration(wsFolder, runConfig);

                // Start debug session with custom debug configurations
                resolve("Launching");
                vscode.debug.startDebugging(wsFolder, runConfig);
            } catch (e) {
                reject(e)
            }
        }))
    }

    private addLensRunConfigurationWarning() {
        window.showInformationMessage("Cannot launch until saved")
    }

    private saveRunConfiguration(wsFolder: WorkspaceFolder, runConf: DebugConfiguration) {
        // Get existing configurations
        const launchConfigurations = workspace.getConfiguration("launch", wsFolder);
        const rawConfigs: DebugConfiguration[] = launchConfigurations.configurations;

        // Only save one configuration with the same name
        let i = rawConfigs.findIndex(c => c.name == runConf.name)
        if (i >= 0)
            rawConfigs[i] = runConf;
        else
            rawConfigs.push(runConf);

        // Update settings file
        launchConfigurations.update("configurations", rawConfigs, ConfigurationTarget.WorkspaceFolder);
    }

    private async getDialect(wsFolder: WorkspaceFolder) {
        const dialects = ["vdmsl", "vdmpp", "vdmrt"];
        let dialect = null;

        let client = this.clients.get(wsFolder.uri.toString());
        if (client) {
            dialect = client.dialect;
        }
        else {
            console.log(`No client found for the folder: ${wsFolder.name}`);

            // Guess dialect
            for (const d in dialects) {
                let pattern = new RelativePattern(wsFolder.uri.path, "*." + d);
                let res = await workspace.findFiles(pattern, null, 1);
                if (res.length == 1) dialect = d;
            }
        }
        return dialect;
    }

    private async requestArgumentValues(args: VdmArgument[], name: string, type: string): Promise<void> {
        // Request arguments from user
        const commandString = this.getCommandOutlineString(name, args)
        for await (let a of args) {
            let value = await window.showInputBox({
                prompt: `Input argument for ${type}`,
                title: commandString,
                ignoreFocusOut: true,
                placeHolder: `${a.name}: ${a.type}`,
                value: a.value
            })

            if (value === undefined)
                return Promise.reject();

            a.value = value;
        }

        return Promise.resolve();
    }

    private async requestConstructor(className: string, constructors: [VdmArgument[]]): Promise<number> {
        // Create strings of constructors to pick from
        let ctorStrings: string[] = constructors.map(ctor => this.getCommandOutlineString(className, ctor));

        let pick = await window.showQuickPick(ctorStrings, {
            canPickMany: false,
            ignoreFocusOut: false,
            title: "Select constructor"
        });

        if (pick === undefined)
            return Promise.reject();
        else
            return Promise.resolve(ctorStrings.indexOf(pick))
    }

    private transferArguments(config: VdmLaunchLensConfiguration, ws: string) {
        // Transfer constructor arguments
        this.lastConfigCtorArgs[ws]?.forEach(lastArg => {
            config.constructors?.forEach(ctor => {
                ctor.forEach(arg => {
                    if (lastArg.name == arg.name && lastArg.type == arg.type)
                        arg.value = lastArg.value
                })
            });
        })

        // Transfer function/operation arguments
        this.lastConfigApplyArgs[ws]?.forEach(lastArg => {
            config.applyArgs.forEach(arg => {
                if (lastArg.name == arg.name && lastArg.type == arg.type)
                    arg.value = lastArg?.value
            })
        })
    }

    private getCommandOutlineString(name: string, args: VdmArgument[]): string {
        let argOutlines: string[] = args.map(a => `${a.name}: ${a.type}`);
        let command = `${name}(${argOutlines.join(', ')})`;
        return command;
    }

    private getCommandString(name: string, args: VdmArgument[]): string {
        let command = `${name}(${args.map(x => x.value).join(', ')})`;
        return command;
    }
}
