## Syntax Highlighting

VDM keywords are automatically highlighted.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/syntax_highlighting.png" width="700">

## Syntax- and Type-checking

Syntax- and type-errors and warnings are highligthed in the editor and detailed in the terminal or by hovering on the highlighted section.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/syntax_checking.gif" width="700">

## Smart Navigation

Mutiple actions exists for navigating to the definition of a given identifier in a specification: Ctrl + click, the right-click context menu or pressing F12 while hovering on the identifier.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/smart_navigation.gif" width="700">

## Debugging

A debugging session can be initiated using the standard VS Code debug interface. This launches the VDMJ interpreter enabling commands to be issued through the terminal. For a list of the available commands type `help`.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/debugging.gif" width="700">

## Proof Obligation Generation

Proof obligation generation can be performed for a specification by accessing the editor context menu (right-clicking in the editor window). Alternatively the explorer contex menu can be used by right-clicking a VDM file in the explorer window.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/POG.gif" width="700">

## Combinatiorial Testing

Combinatorial testing can be performed for a given specification by accessing the "Combinatorial Testing" menu in the activity bar.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/CT.gif" width="700">

## Translation to LaTeX and Word

A specification can be translated to LaTex or Word formats by accessing the editor context menu by right-clicking in the editor.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/translation.gif" width="700">

## Java Code Generation

From a specification you can generate Java code by accessing the editor context menu by right-clicking in the editor.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/java_code_generation.gif" width="700">

## Dependency Graph Generation

dependency graph of the specification can be generated by accessing the editor context menu by right-clicking in the editor. This will generate a graphviz file (.dot) which can be displayed graphically elsewhere, e.g. by installing a graphviz extension such as [vscode-graphviz](https://marketplace.visualstudio.com/items?itemName=joaompinto.vscode-graphviz) or [graphviz-interactive-preview](https://marketplace.visualstudio.com/items?itemName=tintinweb.graphviz-interactive-preview).

<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/dependency_graph_generation.gif" width="700">

## Coverage Report

An execution coverage report can be generated by accessing the editor context menu by right-clicking in the editor.
The results from the latest coverage report or a user defined coverage report (configurable in the settings) can be overlayed the visible editors by a toggle in the focused editor title.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/coverage.gif" width="700">

## Import of Project Examples

VDM-SL, VDM++, and VDM-RT project examples can be imported by accessing the explorer context menu by right-clicking in the explorer.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/import_project_examples.gif" width="700">

## Import of VDM libraries

VDM libraries can be added to a project by accessing the context menu by right-clicking in the explorer or the editor. Libraries to choose from can be configured in the settings.
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/import_VDM_libraries.gif" width="700">

## Remote Control

You can use remote control option by adding a new configuration and selecting "VDM Debug: Remote Control (VDM-SL/++/RT).
<br><br> <img src="https://github.com/jonaskrask/vdm-vscode/raw/master/screenshots/remote_control.gif" width="700">