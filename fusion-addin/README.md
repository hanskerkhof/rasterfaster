# AddInRasterfasterLocalF3D: local .f3d files in Fusion 360

A Fusion 360 add-in for working with **local `.f3d` files instead of the Fusion cloud**. The free Personal Use plan allows only 10 active cloud documents; with this add-in you can keep as many small designs as you like as files on your Mac (for example in iCloud Drive) and open them one at a time.

It adds three commands to the **Add-Ins** panel of the **Utilities** tab:

| Command | What it does |
|---|---|
| **Save Local Copy** | Exports the open design as an `.f3d` file into your local folder. Optionally adds a version number (`RF14_v3.f3d`). |
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
   - **Add version (v&lt;N&gt;)**: on by default, and remembered. The file is called `<name>_v<N>.f3d`, where N is one more than the highest version of that name already in the folder, so every save is a new file and nothing is overwritten. `RF14_v2` and `RF14 v4` both count as versions of `RF14`. With it off, the file is `<name>.f3d`, and an existing file is replaced after you confirm.
   - **Save as**: the exact file name that will be written, updated as you type, with the latest version already on disk.
   - **Folder**: where it goes.
3. Click **Save**. A dialog shows the file name and how long the last save took while Fusion writes the file (the bar stays empty and Fusion does not respond meanwhile); when it is done a message shows the file, its folder, the size and the time.

A big design takes a while to export, and Fusion cannot be used meanwhile. The file is written to a hidden temporary file first and then moved into place, so a failed export never damages the file that is already there.

A design that you opened with **Open Local File** saves next to the file it came from, and uses its name as the default.

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
- `test_addin.py`: tests of the naming and version logic (Fusion's own modules replaced by stand-ins). Run: `cd backend && .venv1/bin/python -m pytest ../fusion-addin/test_addin.py`.
