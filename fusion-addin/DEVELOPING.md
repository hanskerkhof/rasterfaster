# Writing Fusion 360 scripts and add-ins in Python

Notes from building `AddInRasterfasterLocalF3D`, checked against Fusion 2704.1.53 on macOS. They are a starting point, not a replacement for Autodesk's API reference (see the end).

## Script or add-in?

| | Script | Add-in |
|---|---|---|
| Runs | once, when you press Run, then ends | and stays loaded until you stop it (or on startup) |
| Entry points | `run(context)` | `run(context)` when it starts and `stop(context)` when it stops |
| Good for | a one-off job (export, batch change) | buttons in the toolbar, reacting to events |

Both are a **folder** with a Python file and a `.manifest` file, and **the folder name, the `.py` name and the `.manifest` name must be the same** (`MyThing/MyThing.py`, `MyThing/MyThing.manifest`). The manifest is JSON:

```json
{
  "autodeskProduct": "Fusion",
  "type": "addin",
  "id": "a-new-uuid",
  "author": "you",
  "description": { "": "What it does" },
  "version": "1.0.0",
  "runOnStartup": false,
  "supportedOS": "mac",
  "editEnabled": true
}
```

Use `"type": "script"` for a script.

## Where to put it and how to run it

- In Fusion press **Shift+S** (Scripts and Add-Ins). The **+** button makes a new one from a template or adds an existing folder (**Script or add-in from device**). The **Open File Location** link and the pencil show the files.
- Keep the folder in your own repository and add it with **+**. Fusion then runs it from there, so an edit is live after you stop and run it again.
- Do **not** also put a copy or a link in Fusion's own folder (`~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns` or `.../API/Scripts`): Fusion then lists it twice.
- Fusion reads the Python file when the add-in starts. After an edit, switch the add-in off and on again (a script is read each time you run it). If it still looks old, restart Fusion. You cannot stop an add-in while one of its dialogs is open.
- Fusion creates a `.vscode` debug folder inside your folder. Put it in `.gitignore`.

## The skeleton of an add-in

```python
import adsk.core, adsk.fusion, traceback

handlers = []          # keep every event handler alive here, or Python throws it away and the event never fires

def run(context):
    app = adsk.core.Application.get()
    ui = app.userInterface
    try:
        definition = ui.commandDefinitions.addButtonDefinition('my_id', 'My command', 'tooltip')
        definition.commandCreated.add(created_handler)        # see the next section
        ui.allToolbarPanels.itemById('SolidScriptsAddinsPanel').controls.addCommand(definition)
    except Exception:
        ui.messageBox(traceback.format_exc())

def stop(context):
    # remove what run() added: the toolbar control and the command definition
    ...
```

`SolidScriptsAddinsPanel` is the Add-Ins panel of the Utilities tab in the Design workspace. Setting `control.isPromoted = True` shows the command as a button in the panel instead of only in the dropdown, **but only when the command has an icon**: pass a resource folder as the fourth argument of `addButtonDefinition(id, name, tooltip, folder)`, with `16x16.png`, `32x32.png` (and `@2x`/`64x64` versions) in it. With the icons the commands also show up in Fusion's **S** command search (the Model Toolbox); that was not the case before the icons were added and Fusion restarted. The dropdown has no right-click "Pin to Toolbar"; to give a command a keyboard shortcut hover over it, click the three dots and choose Change keyboard shortcut.

## Events: the handler class must match the event

An event needs a handler of exactly the right class. A wrong one fails at start-up with `TypeError: in method 'CommandCreatedEvent_add', argument 2 of type ...` (this is the error the first version of the add-in gave):

| Event | Handler class |
|---|---|
| `commandDefinition.commandCreated` | `adsk.core.CommandCreatedEventHandler` |
| `command.execute` (OK pressed) | `adsk.core.CommandEventHandler` |
| `command.inputChanged` (a dialog field changed) | `adsk.core.InputChangedEventHandler` |
| `app.documentSaved`, `documentOpened`, `documentClosing`, `documentActivated` | `adsk.core.DocumentEventHandler` |

Write a small subclass with `notify(self, args)`, add it to the event and **append it to a list that lives as long as the add-in** (the `handlers` list above). Wrap `notify` in `try/except` and show `traceback.format_exc()` with `ui.messageBox`, otherwise an error disappears silently.

## Dialogs

In the `commandCreated` handler add inputs to `args.command.commandInputs`:

```python
inputs.addStringValueInput('name', 'File name', 'default')
inputs.addBoolValueInput('versioned', 'Add version', True, '', True)   # id, label, isCheckBox, resourceFolder, initial value
box = inputs.addTextBoxCommandInput('info', 'Save as', '', 1, True)    # id, label, text, rows, read only
box.text = 'plain text'
```

- A text box reads the `formattedText` argument as **HTML**: a `&` or `<` in a file name breaks it. Create it empty and set `.text` (plain text) instead.
- Read the values in the `execute` handler from `args.command.commandInputs.itemById('name').value`.
- A command with no inputs shows no dialog: its `execute` runs at once (the Open and Folder commands do this).
- `ui.createFileDialog()` (`showOpen()`, `filename`, `filter`, `initialDirectory`) and `ui.createFolderDialog()` (`showDialog()`, `folder`) give the standard macOS dialogs. `ui.messageBox(text, title, buttons, icon)` shows a message or a question.

## Working with designs and files

- `app.activeProduct` is the design when a design is open: `adsk.fusion.Design.cast(app.activeProduct)`. `app.activeDocument.name` is the document name (Fusion adds ` v4` for the cloud version).
- **Export `.f3d`:** `options = design.exportManager.createFusionArchiveExportOptions(path)` then `design.exportManager.execute(options)`. It writes the open design without saving it in the cloud. Write to a temporary file and `os.replace` it into place so a failed export cannot damage an existing file.
- **Import `.f3d`:** `importManager = app.importManager; importManager.importToNewDocument(importManager.createFusionArchiveImportOptions(path))` opens it as a **new, unsaved document**. Only `.f3d` can be imported this way, not `.f3z`.
- `design.rootComponent.entityToken` is a stable id for a design while Fusion runs (useful as a key for "where did this document come from").
- Fusion is single-threaded for the API: a long export blocks the user interface until it ends.
- Units in the API are centimetres, not millimetres.

## Never wait for input inside an event handler

The `documentClosing` event (and other events that Fusion fires in the middle of an operation) runs while Fusion is busy: clicks and keys in other windows are ignored (every click beeps) and only a message box (`ui.messageBox`) takes input. A command dialog started from the handler and awaited with a loop of `adsk.doEvents()` is drawn but cannot be used, and the loop never ends: Fusion has to be force-quit (this happened with version 0.10.18 of this add-in). So in an event handler: ask with a message box if you must ask, do bounded work (a fixed pause is fine), and never `while not finished:`. For anything with fields or a long wait, start it from a custom event or from a command of its own (see "A long job with a progress dialog").

`ui.commandStarting` fires before any command (built-in ones too) and `args.isCanceled = True` cancels it: the way to put your own dialog in front of a built-in action. The command's id is in `args.commandId`; to find it, log the ids (this add-in does with `"log_commands": true` in `localf3d.json`) and do the action once. Closing a document is `CloseDocumentCommand`. The recipe used here: cancel the command, start your own dialog a moment later from a custom event (not from the handler), and when it is done run the built-in command again (`ui.commandDefinitions.itemById('CloseDocumentCommand').execute()`), this time letting it through.

## A long job with a progress dialog

An export blocks Fusion's main thread, and Fusion draws a dialog from that thread, so a dialog shown right before a long call is not on screen until the call is over (`adsk.doEvents()` did not help). What works:

1. In the click handler show the dialog (`ui.createProgressDialog()`, `show(title, message, 0, 100, 0)`; minimum = maximum is refused) and return.
2. Start a thread that waits a moment (0.4 s) and calls `app.fireCustomEvent('my_event', '')`. That is the one API call you may make from another thread.
3. The handler of that custom event (`adsk.core.CustomEventHandler`, registered with `app.registerCustomEvent('my_event').add(handler)`) runs on Fusion's main thread, after Fusion has drawn the dialog: do the long job there.
4. Update the dialog (`message`, `progressValue`) when it is done, wait a moment with a loop of `adsk.doEvents()` and `time.sleep(0.05)`, and `hide()` it. While the job runs the bar and text cannot change.
5. Unregister the event in `stop()` (`app.unregisterCustomEvent`).

## Finding your way in the API

- The **Fusion MCP server**, if it is connected to Claude Code, can search the API reference (`apiDocumentation` with a name pattern) and run a short Python script in the open design. It refuses to run a script while a command dialog is open.
- A quick way to try a call without an add-in: make a **script** with the **+** button, put the code in `run(context)`, press Run.
- Look at the samples listed in Scripts and Add-Ins (`CommandSample` for dialogs and events, `AddInSample`, `SpurGear`) with **Open File Location**.

## Testing outside Fusion

`adsk` only exists inside Fusion. Keep the logic that does not need it (file names, versions, parsing) in plain functions, and in a test replace the modules with stand-ins before importing the add-in, as `test_addin.py` does:

```python
for name in ("adsk", "adsk.core", "adsk.fusion"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["adsk.core"].CommandEventHandler = type("CommandEventHandler", (), {})   # the base classes the add-in subclasses
```

The dialogs and events themselves can only be tried in Fusion.

## Autodesk's documentation

- The API reference and user's manual are on [help.autodesk.com](https://help.autodesk.com): search for "Fusion API Reference Manual". It documents every class, with Python and C++ samples.
- Autodesk University class: [Getting Started with the Fusion 360 API](https://www.autodesk.com/autodesk-university/class/Getting-Started-Fusion-360-API-2020) (2020, so some details are old).
- The Fusion Help menu links to the same material.
