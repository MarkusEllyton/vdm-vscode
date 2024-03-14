import { ShellExecution, Task, TaskScope, commands, tasks, window, workspace } from "vscode";
import AutoDisposable from "../helper/AutoDisposable";

export class QuickInterpreter extends AutoDisposable {
    protected _disposables = [];

    constructor() {
        super();
        this._registerTerminalProfileProvider();
    }

    private _registerTerminalProfileProvider() {
        const _disp = commands.registerCommand("vdm-vscode.run-quick-interpreter", this.runQuickInterpreter);
        // const _disp = window.registerTerminalProfileProvider("vdm-vscode.quick-interpreter-profile", {
        //     provideTerminalProfile() {
        //         return {
        //             options: {
        //                 name: "VDM Quick Interpreter",
        //                 shellPath: "bash",
        //                 shellArgs: [
        //                     "-c",
        //                     "java -Xmx2g -cp /home/mark_el/.vscode/extensions/overturetool.vdm-vscode-1.3.7/resources/jars/vdmj/vdmj-4.5.0-SNAPSHOT.jar VDMJ -i",
        //                 ],
        //             },
        //         };
        //     },
        // });

        this._disposables.push(_disp);
    }

    private runQuickInterpreter() {
        const qiTask: Task = new Task(
            {
                type: "shell",
            },
            TaskScope.Workspace,
            "VDM: Quick Interpreter",
            "name",
            new ShellExecution(
                "java -Xmx2g -cp /home/mark_el/Documents/Programming/VDM/vdm-vscode-fork/resources/jars/vdmj/vdmj-4.5.0-SNAPSHOT.jar VDMJ -i"
            )
        );

        tasks.executeTask(qiTask);
    }
}
