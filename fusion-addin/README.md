# AddInRasterfasterLocalF3D: local .f3d files in Fusion 360

A Fusion 360 add-in for working with **local `.f3d` files instead of the Fusion cloud**. The free Personal Use plan allows only 10 active cloud documents; with this add-in you can keep as many small designs as you like as files on your Mac (for example in iCloud Drive) and open them one at a time.

It adds three commands to the **Add-Ins** panel of the **Utilities** tab:

| Command | What it does |
|---|---|
| **Save Local Copy** | Exports the open design as an `.f3d` file into your local folder. Optionally adds Fusion's own version number of the document (`RF14_v3.f3d`). |
| **Open Local File** | Opens a local `.f3d` as a new, unsaved document. |
| **Local Folder** | Chooses the folder for the local files (default `~/Documents/FUSION360`). |

The add-in's version is the Rasterfaster app's version (`npm run bump:version -- X.Y.Z` in `frontend/3d-tool` updates the manifest too); Fusion shows it in the Version column of Scripts and Add-Ins, and the Save Local Copy dialog shows it on its last line. Tested with Fusion 2704.1.53 on macOS. Mac only (the manifest says `mac`).

## Install

You do this once. The add-in stays where it is in this repository, and Fusion runs it from there.

1. In Fusion, open the **Design** workspace.
2. Press **Shift+S**, or click **UTILITIES** > **ADD-INS** > **Scripts and Add-Ins**.
3. Click the **+** at the top left of the window and choose **Script or add-in from device**.
4. Select the folder `fusion-addin/AddInRasterfasterLocalF3D` from this repository. It is the folder that holds `AddInRasterfasterLocalF3D.py` and `AddInRasterfasterLocalF3D.manifest`. Choose that folder itself, not the one above it and not the `.py` file.
5. Go to the **Add-Ins** tab, select **AddInRasterfasterLocalF3D** and switch it **on** (or press **Run**).
6. Optional: tick **Run on Startup** so the commands are there every time you start Fusion.

The three commands now show in the **ADD-INS** panel of the **UTILITIES** tab, as buttons with icons next to the **Scripts and Add-Ins** button (or in its dropdown if the toolbar is narrow).

Do not also copy the folder into Fusion's own AddIns folder (`~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns`): Fusion would list the add-in twice.

### After a change to the add-in

Fusion reads the Python file when the add-in starts. After the file has changed (for example after a `git pull`), switch the add-in off and on again in **Scripts and Add-Ins**. If an add-in dialog is open you must close it first. If it still looks old, quit Fusion and start it again.

### Uninstall

In **Scripts and Add-Ins**, switch the add-in off, select it and click the unlink icon (the broken chain) in the toolbar. That removes it from the list; the files stay in the repository.

## Use

### Save Local Copy

1. Open the design you want to save.
2. Click **Save Local Copy**. The dialog shows:
   - **File name**: filled in from the document name (Fusion's own ` v4` suffix is removed).
   - **Add version (v&lt;N&gt;)**: on by default, and remembered. The file is called `<name>_v<N>.f3d`, where N is the version number Fusion shows for the document (`document.dataFile.versionNumber`, the v5 in the tab); the add-in keeps no counter of its own. `RF14_v2` and `RF14 v4` both count as `RF14`. A local save does not create a Fusion version, so saving twice at the same Fusion version writes the same file name: the file is replaced (after you confirm, in the dialog). A document that was never saved in the cloud has no version number and is saved as `<name>.f3d`. With it off, the file is always `<name>.f3d`.
   - **Save as**: the exact file name that will be written, updated as you type, and whether it replaces a file on disk.
   - **Folder**: where it goes.
   - **Move older versions to VERSIONS** (at the bottom, only with *Add version*; remembered): after the new file is written, the earlier versions of that design (`<name>_v<N>.f3d`) move into a `VERSIONS` folder next to it, so the main folder holds only the latest version of each design. Nothing in `VERSIONS` is overwritten. The unversioned original (`<name>.f3d`, from before versions were used) moves too, so the first versioned save of `BILOfix.f3d` does not leave two `BILOfix` files; its hierarchy file goes with it. A design whose name only starts the same stays where it is.
3. Click **Save**. A dialog shows the file name and how long the last save took while Fusion writes the file (the bar stays empty and Fusion does not respond meanwhile); when it is done the same dialog shows the file, its folder, the size and the time for a moment and closes by itself (no OK to click; the line is also in Fusion's Text Commands window).

A big design takes a while to export, and Fusion cannot be used meanwhile. The file is written to a hidden temporary file first and then moved into place, so a failed export never damages the file that is already there.

A design that you opened with **Open Local File** saves next to the file it came from, and uses its name as the default. That document is also renamed to the file's name (`RF14_v3`), which shows in its tab. Fusion only allows that for a document that has never been saved in the cloud: a document that lives in the cloud keeps its cloud name.

**The hierarchy.** Each save also writes the Fusion version (`fusionVersion`, null when there is none) and the structure of the design (components, sub-components and the bodies in each) into a small JSON file in a `.meta` folder next to the `.f3d`: `RF14_v6.f3d` gets `.meta/RF14_v6.tree.json`. Every saved file has its own, so each version keeps the hierarchy it had; older versions moved to `VERSIONS` take theirs along (`VERSIONS/.meta/`). `scripts/f3dsearch.py` uses these files: `search` shows where a name sits, and `tree RF14` prints the whole hierarchy. **Open Local File** writes the file too when a design has none, so opening an old design once is enough. If the hierarchy cannot be written the save still succeeds. `.meta` starts with a dot: iCloud Drive probably does not sync it to another Mac (not checked), and Finder hides it (⇧⌘. shows hidden files).

### Reminder when you close a document

When you close a document that has changes without an up-to-date local copy, a question appears with three buttons:

- **Yes**: the close is stopped and the **Save Local Copy dialog** opens, so you can check the file name, the versioning and the VERSIONS option. Press **Save**: the copy is written (progress dialog, hierarchy file, older versions moved) and then the document is closed again. Fusion's own "Unsaved changes" question for the cloud follows as usual.
- **Cancel in the Save dialog**: the document stays open.
- **No**: the document closes without a local copy.
- **Cancel** (in the question): the document stays open.

It asks only when work would be lost: a document that you opened with Open Local File or saved with Save Local Copy and did not change since does not ask (the add-in compares a fingerprint of the design; Fusion's own *modified* flag is always on for such a document); a cloud document that you only looked at does not ask; an empty document does not ask. Turn it off with the checkbox **Remind me to save a local copy when closing** at the bottom of the Save Local Copy dialog.

Other ways a document gets closed (quitting Fusion, for example) are caught by a second, simpler question: **Yes** saves a copy right away with the remembered settings (it never replaces another file), **No** closes. Fusion allows nothing but a message box at that moment, so there is no dialog with settings and no Cancel there.

### Open Local File

1. Click **Open Local File** and choose an `.f3d` file (the dialog starts in your local folder).
2. It opens as a **new, unsaved document**. It is not in the cloud.
3. When you are done, use **Save Local Copy** to write your changes to a file.
4. When you close the document choose **Don't save**. If you choose Save, Fusion puts it in the cloud.

### Local Folder

Click **Local Folder** and pick a folder. The choice is stored in `localf3d.json` next to the add-in (not in git).

## Tips

- **Shortcuts:** assign keyboard shortcuts to the commands in Fusion: right-click a command in the toolbar, or use the Fusion preferences.
- **iCloud:** choose *Keep Downloaded* on the folder, so that a file is not offloaded and must be downloaded again (a gigabyte) before Fusion can open it. Wait until a new file has finished uploading before you open it on another Mac.
- **Disk space:** each version is a complete file. Delete the old versions you no longer need.
- **Searching:** `scripts/f3dsearch.py` (see the main README) finds component names inside all the `.f3d` files in a folder without opening Fusion: run `backend/.venv1/bin/python scripts/f3dsearch.py index ~/Documents/FUSION360`, then `search WORD`.
- **Memory:** many small designs use far less memory than one huge one. A single 300 MB design can take 13 GB or more in Fusion.

## Troubleshooting

| What you see | What to do |
|---|---|
| The commands are not in the ADD-INS panel | Check in **Scripts and Add-Ins** that the add-in is switched on, and look in the **Utilities** tab, in the **Add-Ins** dropdown. (Press **S** in the Design workspace and type "Local": the commands show up in that search too.) |
| The add-in is listed twice | One entry was added from the repository and another from Fusion's AddIns folder. Remove the copy in the AddIns folder, or remove one entry with the unlink icon. |
| A message box says the add-in failed to start | Copy the text and send it to whoever maintains the add-in; the first lines show which line failed. |
| Cannot stop the add-in | A dialog of the add-in is open: click **Cancel** first. |
| The dialog is the old one after an update | Switch the add-in off and on again; if that does not help, quit and restart Fusion. |
| Fusion says "not responding" during a save | It is exporting a big design. Wait; it comes back when the file is written. |

## Writing your own

See [DEVELOPING.md](DEVELOPING.md): how scripts and add-ins work in Fusion, the events and handler classes, dialogs, exporting and importing, and how to test.

## Files

- `AddInRasterfasterLocalF3D/AddInRasterfasterLocalF3D.py`: the add-in.
- `AddInRasterfasterLocalF3D/AddInRasterfasterLocalF3D.manifest`: what Fusion reads to list it (the three names must match).
- `DEVELOPING.md`: notes on writing Fusion scripts and add-ins in Python.
- `make_icons.py`: draws the command icons into `AddInRasterfasterLocalF3D/resources/` (Pillow).
- `.meta/` (in your local folder, not in the repo): one `<file>.tree.json` per saved file.
- `test_addin.py`: tests of the naming and version logic (Fusion's own modules replaced by stand-ins). Run: `cd backend && .venv1/bin/python -m pytest ../fusion-addin/test_addin.py`.
