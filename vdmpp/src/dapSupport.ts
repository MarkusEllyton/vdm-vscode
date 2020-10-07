import * as dialect from "./dialect"
import * as vscode from "vscode";

export function initDebugConfig(context: vscode.ExtensionContext, port:number){
	// register a configuration provider for 'vdm' debug type
	const provider = new VdmConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('vdm', provider));

	// run the debug adapter as a server inside the extension and communicating via a socket
	let factory = new VdmDebugAdapterDescriptorFactory(port);

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('vdm', factory));
	if ('dispose' in factory) {
		context.subscriptions.push(factory);
	}
}

export class VdmConfigurationProvider implements vscode.DebugConfigurationProvider {
	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === dialect.vdmDialect) {
				config.type = 'vdm';
				config.name = 'Launch';
				config.request = 'launch';
				config.stopOnEntry = true;
				config.noDebug = false;
			}
		}

		return config;
	}
}

export class VdmDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	constructor(
		private dapPort: number
		){}

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer(this.dapPort);
	}
}