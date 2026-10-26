"""Local .f3d files instead of the Fusion cloud (for the Personal Use limit of 10 active documents).

Three commands in the Utilities tab > Add-Ins panel:
  Save Local Copy   exports the open design as <name>.f3d into the local folder (written to a hidden temporary file first and then moved
                    over the old copy, so a failed export never damages the file that is there). With "Add version" ticked the file is
                    called <name>_v<N>.f3d, where N is one more than the highest version of that name already in the folder
  Open Local File   opens a local .f3d as a new, unsaved document (it is never put in the cloud unless you save it there; when you close it,
                    choose "Don't save")
  Local Folder      chooses the folder (default ~/Documents/FUSION360, remembered in localf3d.json next to this file)
Assign keyboard shortcuts to them in Fusion (Preferences > General > Keyboard shortcuts, or right-click a command).
"""
import json
import os
import re
import time
import traceback

import adsk.core
import adsk.fusion

SAVE_ID, OPEN_ID, FOLDER_ID = 'rasterfaster_localf3d_save', 'rasterfaster_localf3d_open', 'rasterfaster_localf3d_folder'
PANEL_ID = 'SolidScriptsAddinsPanel'
CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'localf3d.json')
DEFAULT_FOLDER = os.path.expanduser('~/Documents/FUSION360')

app = None
ui = None
handlers = []
# where each document came from, by the token of its root component (a document that was opened from a file saves back to that file)
sources = {}


def settings():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(**changes):
    values = settings()
    values.update(changes)
    with open(CONFIG, 'w') as f:
        json.dump(values, f)


def addin_version():
    """The version in the manifest (the same as the Rasterfaster app's: `npm run bump:version` keeps them equal)."""
    try:
        with open(os.path.splitext(os.path.abspath(__file__))[0] + '.manifest') as f:
            return json.load(f).get('version', '')
    except (OSError, ValueError):
        return ''


def folder():
    return settings().get('folder') or DEFAULT_FOLDER


def set_folder(path):
    save_settings(folder=path)


def active_design():
    return adsk.fusion.Design.cast(app.activeProduct)


def token(design):
    return design.rootComponent.entityToken


def clean_name(name):
    """A document called `RF14 v4` (Fusion adds the version) is saved as `RF14.f3d`; characters that are not allowed in a file name are dropped."""
    name = re.sub(r'\s+v\d+$', '', name.strip())
    name = re.sub(r'[\\/:\0]', '-', name).strip('. ')
    return name or 'Untitled'


VERSION_SUFFIX = re.compile(r'[\s_]+v\d+$', re.IGNORECASE)


def base_name(name):
    """`RF14_v2` and `RF14 v4` are both versions of `RF14`."""
    return VERSION_SUFFIX.sub('', clean_name(name)) or 'Untitled'


def versions_on_disk(directory, base):
    """The version numbers of `<base>_v<N>.f3d` (or `<base> v<N>.f3d`) files in the folder."""
    pattern = re.compile('^' + re.escape(base) + r'[ _]v(\d+)\.f3d$', re.IGNORECASE)
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    return sorted(int(m.group(1)) for m in (pattern.match(n) for n in names) if m)


def planned_target(directory, name, versioned):
    """(file path, highest version already on disk or None): a versioned save always makes a new file, one version higher."""
    if versioned:
        base = base_name(name)
        found = versions_on_disk(directory, base)
        highest = found[-1] if found else 0
        return os.path.join(directory, f'{base}_v{highest + 1}.f3d'), highest
    return os.path.join(directory, clean_name(name) + '.f3d'), None


def describe(target, highest):
    text = os.path.basename(target)
    if highest is not None:
        text += f'   (latest on disk: v{highest})' if highest else '   (no version on disk yet)'
    elif os.path.exists(target):
        text += '   (replaces the file on disk)'
    return text


def export_to(design, target):
    """Exports to a hidden temporary file in the same folder, then moves it over `target` (an export that fails leaves the old file alone)."""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temporary = os.path.join(os.path.dirname(target), '.' + os.path.basename(target)[:-4] + '.saving.f3d')
    if os.path.exists(temporary):
        os.remove(temporary)
    options = design.exportManager.createFusionArchiveExportOptions(temporary)
    if not design.exportManager.execute(options) or not os.path.isfile(temporary) or os.path.getsize(temporary) == 0:
        if os.path.exists(temporary):
            os.remove(temporary)
        raise RuntimeError('Fusion could not export this design')
    os.replace(temporary, target)


def guarded(action, args):
    try:
        action(args)
    except Exception:
        ui.messageBox('Local .f3d: ' + traceback.format_exc(limit=3))


class CreatedHandler(adsk.core.CommandCreatedEventHandler):
    """For the commandCreated event of a command definition (it needs its own handler class, not the execute one)."""

    def __init__(self, action):
        super().__init__()
        self.action = action

    def notify(self, args):
        guarded(self.action, args)


class ChangedHandler(adsk.core.InputChangedEventHandler):
    """For the inputChanged event of a command (the live preview of the file name)."""

    def __init__(self, action):
        super().__init__()
        self.action = action

    def notify(self, args):
        guarded(self.action, args)


class Handler(adsk.core.CommandEventHandler):
    """For the events of a command itself (execute)."""

    def __init__(self, action):
        super().__init__()
        self.action = action

    def notify(self, args):
        guarded(self.action, args)


def keep(handler):
    handlers.append(handler)
    return handler


def export_with_progress(design, target):
    """Shows a dialog while the file is written. The export blocks Fusion until it is done (and the dialog cannot be updated meanwhile),
    so the dialog has an empty bar, the name and the time the last save took. Returns the seconds it took."""
    message = f'Writing {os.path.basename(target)} ...\nFusion does not respond until the file is saved.'
    last = settings().get('last_export')
    if last:
        message += f'\nThe last save ({last["mb"]} MB) took {last["seconds"]} s.'
    dialog = ui.createProgressDialog()
    dialog.isCancelButtonShown = False
    dialog.show('Save Local Copy', message, 0, 100, 0)  # the bar stays empty: the value cannot be updated while the export runs (minimum = maximum is refused)
    adsk.doEvents()  # let Fusion draw the dialog before the export starts
    started = time.time()
    try:
        export_to(design, target)
    finally:
        dialog.hide()
    return time.time() - started


def save_directory(design):
    known = sources.get(token(design))
    return os.path.dirname(known) if known else folder()


def on_save_created(args):
    design = active_design()
    if not design:
        ui.messageBox('There is no design to save.')
        return
    command = args.command
    known = sources.get(token(design))
    default = os.path.splitext(os.path.basename(known))[0] if known else clean_name(app.activeDocument.name)
    versioned = bool(settings().get('versioned', True))
    inputs = command.commandInputs
    inputs.addStringValueInput('name', 'File name', default)
    inputs.addBoolValueInput('versioned', 'Add version (v<N>)', True, '', versioned)
    # the text is set through .text, which takes it as plain text (the constructor argument is read as HTML: a "&" in a name would break)
    inputs.addTextBoxCommandInput('preview', 'Save as', '', 1, True).text = describe(*planned_target(save_directory(design), default, versioned))
    inputs.addTextBoxCommandInput('where', 'Folder', '', 1, True).text = save_directory(design)
    inputs.addTextBoxCommandInput('about', 'Add-in', '', 1, True).text = 'Rasterfaster Local F3D v' + addin_version()
    command.okButtonText = 'Save'
    command.inputChanged.add(keep(ChangedHandler(on_save_changed)))
    command.execute.add(keep(Handler(on_save_execute)))


def on_save_changed(args):
    inputs = args.inputs
    target, highest = planned_target(save_directory(active_design()), inputs.itemById('name').value, inputs.itemById('versioned').value)
    inputs.itemById('preview').text = describe(target, highest)


def on_save_execute(args):
    design = active_design()
    inputs = args.command.commandInputs
    versioned = inputs.itemById('versioned').value
    target, highest = planned_target(save_directory(design), inputs.itemById('name').value, versioned)
    if not versioned and os.path.exists(target) and target != sources.get(token(design)):
        answer = ui.messageBox(f'{os.path.basename(target)} already exists in that folder. Replace it?', 'Save Local Copy', adsk.core.MessageBoxButtonTypes.YesNoButtonType, adsk.core.MessageBoxIconTypes.WarningIconType)
        if answer != adsk.core.DialogResults.DialogYes:
            return
    save_settings(versioned=versioned)
    seconds = export_with_progress(design, target)
    sources[token(design)] = target
    size = os.path.getsize(target) / 1e6
    save_settings(last_export={'seconds': round(seconds), 'mb': round(size)})
    ui.messageBox(f'Saved {os.path.basename(target)}\n\n{target}\n{size:.0f} MB, {seconds:.0f} s', 'Save Local Copy')


def on_open_created(args):
    args.command.execute.add(keep(Handler(on_open_execute)))


def on_open_execute(args):
    dialog = ui.createFileDialog()
    dialog.title = 'Open a local Fusion archive'
    dialog.filter = 'Fusion archive (*.f3d)'
    dialog.isMultiSelectEnabled = False
    if os.path.isdir(folder()):
        dialog.initialDirectory = folder()
    if dialog.showOpen() != adsk.core.DialogResults.DialogOK:
        return
    path = dialog.filename
    document = app.importManager.importToNewDocument(app.importManager.createFusionArchiveImportOptions(path))
    if document is None:
        raise RuntimeError('Fusion could not open ' + path)
    design = adsk.fusion.Design.cast(document.products.itemByProductType('DesignProductType'))
    if design:
        sources[token(design)] = path


def on_folder_created(args):
    args.command.execute.add(keep(Handler(on_folder_execute)))


def on_folder_execute(args):
    dialog = ui.createFolderDialog()
    dialog.title = 'Folder for the local .f3d files'
    dialog.initialDirectory = folder() if os.path.isdir(folder()) else os.path.expanduser('~/Documents')
    if dialog.showDialog() == adsk.core.DialogResults.DialogOK:
        set_folder(dialog.folder)


def add_command(command_id, name, tooltip, icon, created):
    definitions = ui.commandDefinitions
    existing = definitions.itemById(command_id)
    if existing:
        existing.deleteMe()
    # the icons make Fusion show the command as a button in the toolbar (a promoted command without an icon stays in the dropdown)
    definition = definitions.addButtonDefinition(command_id, name, tooltip, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'resources', icon))
    definition.commandCreated.add(keep(CreatedHandler(created)))
    control = ui.allToolbarPanels.itemById(PANEL_ID).controls.addCommand(definition)
    control.isPromoted = True
    control.isPromotedByDefault = True


def run(context):
    global app, ui
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        add_command(SAVE_ID, 'Save Local Copy', 'Export the open design as a local .f3d file (no Fusion cloud)', 'save', on_save_created)
        add_command(OPEN_ID, 'Open Local File', 'Open a local .f3d file as a new, unsaved document', 'open', on_open_created)
        add_command(FOLDER_ID, 'Local Folder', 'Choose the folder for the local .f3d files', 'folder', on_folder_created)
    except Exception:
        if ui:
            ui.messageBox('Local .f3d failed to start:\n' + traceback.format_exc())


def stop(context):
    try:
        panel = ui.allToolbarPanels.itemById(PANEL_ID)
        for command_id in (SAVE_ID, OPEN_ID, FOLDER_ID):
            control = panel.controls.itemById(command_id)
            if control:
                control.deleteMe()
            definition = ui.commandDefinitions.itemById(command_id)
            if definition:
                definition.deleteMe()
    except Exception:
        if ui:
            ui.messageBox('Local .f3d failed to stop:\n' + traceback.format_exc())
