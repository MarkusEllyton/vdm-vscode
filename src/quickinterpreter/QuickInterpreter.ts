import { ShellExecution, Task, TaskScope, commands, tasks, window, workspace } from "vscode";
import AutoDisposable from "../helper/AutoDisposable";

export class QuickInterpreter extends AutoDisposable {
    protected _disposables = [];

    constructor() {
        super();
        this._disposables.push(commands.registerCommand("vdm-vscode.run-quick-interpreter", this.runQuickInterpreter));
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
