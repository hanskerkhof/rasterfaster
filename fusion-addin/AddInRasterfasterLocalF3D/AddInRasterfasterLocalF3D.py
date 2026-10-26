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
import datetime
import re
import threading
import time
import traceback

import adsk.core
import adsk.fusion

SAVE_ID, OPEN_ID, FOLDER_ID = 'rasterfaster_localf3d_save', 'rasterfaster_localf3d_open', 'rasterfaster_localf3d_folder'
PANEL_ID = 'SolidScriptsAddinsPanel'
EXPORT_EVENT = 'rasterfaster_localf3d_export'  # fired a moment after Save is pressed, so that Fusion can draw the progress dialog first
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


ARCHIVE_DIR = 'VERSIONS'  # where the older versions of a design go when "Move older versions" is ticked


def version_files(directory, base):
    """[(N, path)] of the `<base>_v<N>.f3d` (or `<base> v<N>.f3d`) files directly in the folder."""
    pattern = re.compile('^' + re.escape(base) + r'[ _]v(\d+)\.f3d$', re.IGNORECASE)
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    return sorted((int(m.group(1)), os.path.join(directory, n)) for m, n in ((pattern.match(n), n) for n in names) if m)


def versions_on_disk(directory, base):
    """The version numbers of the design, in the folder and in its VERSIONS folder (a moved version still counts: the numbers never restart)."""
    found = version_files(directory, base) + version_files(os.path.join(directory, ARCHIVE_DIR), base)
    return sorted(number for number, _ in found)


def movable_files(directory, base, keep=None):
    """The files that "Move older versions" moves: the unversioned `<base>.f3d` (the original, from before versions were used) and the
    `<base>_v<N>.f3d` / `<base> v<N>.f3d` files, in the folder; never the file `keep` (the one just saved)."""
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    plain = [os.path.join(directory, n) for n in names if n.lower() == (base + '.f3d').lower()]
    return [path for path in plain + [p for _, p in version_files(directory, base)] if path != keep]


def archive_versions(directory, base, keep=None):
    """Moves the older files of the design (see movable_files) into the VERSIONS folder; returns how many were moved. A file is never
    overwritten there: a name that is taken gets ` (2)`. Each file's hierarchy file (.meta) goes with it."""
    moving = movable_files(directory, base, keep)
    if not moving:
        return 0
    destination = os.path.join(directory, ARCHIVE_DIR)
    os.makedirs(destination, exist_ok=True)
    for path in moving:
        target = os.path.join(destination, os.path.basename(path))
        number = 2
        while os.path.exists(target):
            stem, extension = os.path.splitext(os.path.basename(path))
            target = os.path.join(destination, f'{stem} ({number}){extension}')
            number += 1
        os.replace(path, target)
        if os.path.exists(sidecar_path(path)):  # the hierarchy file goes with its design: VERSIONS/.meta/
            os.makedirs(os.path.dirname(sidecar_path(target)), exist_ok=True)
            os.replace(sidecar_path(path), sidecar_path(target))
    return len(moving)


def real_folder(directory):
    """A design opened from the VERSIONS folder is saved next to that folder, not inside it."""
    return os.path.dirname(directory) if os.path.basename(directory).lower() == ARCHIVE_DIR.lower() else directory


META_DIR = '.meta'  # next to the .f3d files; RF14_v6.f3d has .meta/RF14_v6.tree.json (every saved file has its own: one per version)
TREE_SUFFIX = '.tree.json'  # the hierarchy of components and bodies, for f3dsearch


def sidecar_path(f3d_path):
    directory, name = os.path.split(f3d_path)
    return os.path.join(directory, META_DIR, os.path.splitext(name)[0] + TREE_SUFFIX)


def component_tree(component, name=None):
    """{name, component, bodies, children} of a component and everything below it. `name` is the occurrence's name (`Part:1`) when it has one.
    Mesh bodies are listed with a `[mesh] ` prefix."""
    return {
        'name': name or component.name,
        'component': component.name,
        'bodies': [b.name for b in component.bRepBodies] + ['[mesh] ' + m.name for m in component.meshBodies],
        'children': [component_tree(o.component, o.name) for o in component.occurrences],
    }


def tree_counts(node):
    """(components below the root, bodies in all of them)"""
    components, bodies = 0, len(node['bodies'])
    for child in node['children']:
        sub_components, sub_bodies = tree_counts(child)
        components += 1 + sub_components
        bodies += sub_bodies
    return components, bodies


def write_sidecar(root_component, f3d_path, document_name):
    """Writes the hierarchy next to the .f3d file (a hidden temporary file first, then moved into place). Returns (components, bodies)."""
    tree = component_tree(root_component, '(root)')
    components, bodies = tree_counts(tree)
    payload = {'version': 1, 'document': document_name, 'file': os.path.basename(f3d_path), 'savedAt': datetime.datetime.now().isoformat(timespec='seconds'),
               'components': components, 'bodies': bodies, 'tree': tree}
    target = sidecar_path(f3d_path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temporary = os.path.join(os.path.dirname(target), '.' + os.path.basename(target) + '.saving')
    with open(temporary, 'w') as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)
    os.replace(temporary, target)
    return components, bodies


def planned_target(directory, name, versioned):
    """(file path, highest version already on disk or None): a versioned save always makes a new file, one version higher."""
    if versioned:
        base = base_name(name)
        found = versions_on_disk(directory, base)
        highest = found[-1] if found else 0
        return os.path.join(directory, f'{base}_v{highest + 1}.f3d'), highest
    return os.path.join(directory, clean_name(name) + '.f3d'), None


def describe(target, highest, moving=0):
    text = os.path.basename(target)
    if highest is not None:
        text += f'   (latest on disk: v{highest})' if highest else '   (no version on disk yet)'
        if moving:
            text += f'   {moving} older to {ARCHIVE_DIR}'
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


class JobHandler(adsk.core.CustomEventHandler):
    """For the custom event that starts the export."""

    def __init__(self):
        super().__init__()

    def notify(self, args):
        guarded(run_job, args)


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


def pause(seconds):
    """Waits without freezing Fusion's window (it keeps handling events)."""
    end = time.time() + seconds
    while time.time() < end:
        adsk.doEvents()
        time.sleep(0.05)


job = {}  # the save that waits for the custom event: the design, the file, the progress dialog and when it started


def start_save(design, target, archive_base=None):
    """Shows the progress dialog at once and starts the export a moment later, from a custom event. If the export started right here, inside the
    click handler, Fusion would not have drawn the dialog yet (it would only show up when the file is already written)."""
    name = os.path.basename(target)
    message = f'Writing {name} ...\nFusion does not respond until the file is saved.'
    last = settings().get('last_export')
    if last:
        message += f'\nThe last save ({last["mb"]} MB) took {last["seconds"]} s.'
    dialog = ui.createProgressDialog()
    dialog.isCancelButtonShown = False
    dialog.show('Save Local Copy', message, 0, 100, 0)  # minimum = maximum is refused
    job.update(design=design, target=target, dialog=dialog, archive_base=archive_base)
    pause(0.1)

    def fire():
        time.sleep(0.4)  # the event loop of Fusion draws the dialog meanwhile
        app.fireCustomEvent(EXPORT_EVENT, '')  # the one call that may be made from another thread; the handler runs in Fusion's own thread

    threading.Thread(target=fire, daemon=True).start()


def run_job(args):
    """The custom event: write the file, say so in the same dialog, close it, and remember the file."""
    design, target, dialog, archive_base = job.pop('design'), job.pop('target'), job.pop('dialog'), job.pop('archive_base')
    name = os.path.basename(target)
    started = time.time()
    try:
        export_to(design, target)
        seconds = time.time() - started
        size = os.path.getsize(target) / 1e6
        try:
            components, bodies = write_sidecar(design.rootComponent, target, app.activeDocument.name)
            tree_note = f'{components} components, {bodies} bodies in {os.path.basename(sidecar_path(target))}'
        except Exception:
            tree_note = ''  # the hierarchy is a bonus: a failure here never fails the save
        moved = archive_versions(os.path.dirname(target), archive_base, keep=target) if archive_base else 0  # only after the new file is safely written
        dialog.progressValue = 100
        dialog.message = f'Saved {name}\n{size:.0f} MB in {seconds:.0f} s\n{os.path.dirname(target)}'
        if tree_note:
            dialog.message += f'\n{tree_note}'
        if moved:
            dialog.message += f'\nMoved {moved} older version{"s" if moved > 1 else ""} to {ARCHIVE_DIR}'
        app.log(f'Local F3D: saved {target} ({size:.0f} MB, {seconds:.0f} s)')
        pause(2.5)
    finally:
        dialog.hide()
    sources[token(design)] = target
    save_settings(last_export={'seconds': round(seconds), 'mb': round(size)})
    name_document(app.activeDocument, target)


def name_document(document, target):
    """Gives a document that was never saved in the cloud the name of its file (`RF14_v4`): it shows in the tab and is the default name if
    Fusion asks to save it. Fusion refuses a new name for a document that is saved in the cloud, so that one is left alone."""
    try:
        if not document.isSaved:
            document.name = os.path.splitext(os.path.basename(target))[0]
    except Exception:
        pass


def save_directory(design):
    known = sources.get(token(design))
    return real_folder(os.path.dirname(known)) if known else folder()


def on_save_created(args):
    design = active_design()
    if not design:
        ui.messageBox('There is no design to save.')
        return
    command = args.command
    known = sources.get(token(design))
    default = os.path.splitext(os.path.basename(known))[0] if known else clean_name(app.activeDocument.name)
    versioned = bool(settings().get('versioned', True))
    archive_setting = bool(settings().get('archive', False))
    inputs = command.commandInputs
    inputs.addStringValueInput('name', 'File name', default)
    inputs.addBoolValueInput('versioned', 'Add version (v<N>)', True, '', versioned)
    # the text is set through .text, which takes it as plain text (the constructor argument is read as HTML: a "&" in a name would break)
    inputs.addTextBoxCommandInput('preview', 'Save as', '', 1, True).text = preview_text(save_directory(design), default, versioned, archive_setting)
    inputs.addTextBoxCommandInput('where', 'Folder', '', 1, True).text = save_directory(design)
    archive = inputs.addBoolValueInput('archive', f'Move older versions to {ARCHIVE_DIR}', True, '', archive_setting)
    archive.isEnabled = versioned
    inputs.addTextBoxCommandInput('about', 'Add-in', '', 1, True).text = 'Rasterfaster Local F3D v' + addin_version()
    command.okButtonText = 'Save'
    command.inputChanged.add(keep(ChangedHandler(on_save_changed)))
    command.execute.add(keep(Handler(on_save_execute)))


def preview_text(directory, name, versioned, archive):
    target, highest = planned_target(directory, name, versioned)
    moving = len(movable_files(directory, base_name(name), target)) if versioned and archive else 0
    return describe(target, highest, moving)


def on_save_changed(args):
    inputs = args.inputs
    versioned = inputs.itemById('versioned').value
    inputs.itemById('archive').isEnabled = versioned  # moving older versions only makes sense with versions
    inputs.itemById('preview').text = preview_text(save_directory(active_design()), inputs.itemById('name').value, versioned, inputs.itemById('archive').value)


def on_save_execute(args):
    design = active_design()
    inputs = args.command.commandInputs
    versioned = inputs.itemById('versioned').value
    target, highest = planned_target(save_directory(design), inputs.itemById('name').value, versioned)
    if not versioned and os.path.exists(target) and target != sources.get(token(design)):
        answer = ui.messageBox(f'{os.path.basename(target)} already exists in that folder. Replace it?', 'Save Local Copy', adsk.core.MessageBoxButtonTypes.YesNoButtonType, adsk.core.MessageBoxIconTypes.WarningIconType)
        if answer != adsk.core.DialogResults.DialogYes:
            return
    archive = bool(inputs.itemById('archive').value)
    save_settings(versioned=versioned, archive=archive)
    start_save(design, target, base_name(inputs.itemById('name').value) if versioned and archive else None)


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
        try:  # opening gives the whole hierarchy for free: write it when the file has no sidecar yet (or an older one)
            sidecar = sidecar_path(path)
            if not os.path.exists(sidecar) or os.path.getmtime(sidecar) < os.path.getmtime(path):
                write_sidecar(design.rootComponent, path, document.name)
        except Exception:
            pass
    name_document(document, path)


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
        try:
            app.unregisterCustomEvent(EXPORT_EVENT)  # left over from an earlier run of the add-in
        except Exception:
            pass
        app.registerCustomEvent(EXPORT_EVENT).add(keep(JobHandler()))
        add_command(SAVE_ID, 'Save Local Copy', 'Export the open design as a local .f3d file (no Fusion cloud)', 'save', on_save_created)
        add_command(OPEN_ID, 'Open Local File', 'Open a local .f3d file as a new, unsaved document', 'open', on_open_created)
        add_command(FOLDER_ID, 'Local Folder', 'Choose the folder for the local .f3d files', 'folder', on_folder_created)
    except Exception:
        if ui:
            ui.messageBox('Local .f3d failed to start:\n' + traceback.format_exc())


def stop(context):
    try:
        app.unregisterCustomEvent(EXPORT_EVENT)
    except Exception:
        pass
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
