# Jujutsu Kaizen

![banner](images/banner.png)

> A Visual Studio Code extension for the [Jujutsu (jj) version control system](https://github.com/jj-vcs/jj).

[![VS Code Extension](https://img.shields.io/visual-studio-marketplace/v/jjk.jjk)](https://marketplace.visualstudio.com/items?itemName=jjk.jjk)
[![Discord](https://img.shields.io/discord/968932220549103686?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/BqBjUVerfq)

## 🚀 Features

The goal of this extension is to bring the great UX of Jujutsu into the VS Code UI. We are currently focused on achieving parity for commonly used features of VS Code's built-in Git extension, such as the various operations possible via the Source Control view.

Here's what you can do so far:

### 📁 File Management

- Track file statuses in the Working Copy
- Monitor file statuses across all parent changes
- View detailed file diffs for Working Copy and parent modifications  
  ![view file diff](images/diff.png)
- Add custom views for aggregate diffs, such as all changes from a branch's
  fork point to the working copy
- View line-by-line blame  
  <img src="images/blame.gif" width="70%" alt="view blame">

### 💫 Change Management

- Create new changes with optional descriptions
- Edit descriptions for Working Copy and parent changes  
  ![edit description](images/describe.png)
- Move changes between Working Copy and parents  
  ![squash](images/squash.png)
- Move specific lines from the Working Copy to its parent changes
  ![squash range](images/squash_range.webp)
- Discard changes  
  ![restore](images/restore.png)
- Browse and navigate revision history  
  <img src="images/edit.gif" width="50%" alt="revision history">
- Inspect the Source Control Graph with commit metadata, full commit
  messages, change stats, and quick hover actions for editing or
  creating a follow-up change
- Create merge changes  
  <img src="images/merge.gif" width="50%" alt="revision history">

### 🔄 Operation Management

- Undo jj operations or restore to a previous state  
  <img src="images/undo.gif" width="50%" alt="undo">

## 📋 Prerequisites

- Ensure `jj` is installed and available in your system's `$PATH`, or configure a custom path using the `jjk.jjPath` setting

## Custom views

Custom views appear as additional groups in the Source Control panel.
Each view compares two jj revisions and updates along with the repository:

```json
{
  "jjk.customViews": [
    {
      "name": "Branch Changes",
      "from": "fork_point(main | @)",
      "to": "@"
    }
  ]
}
```

`to` is optional and defaults to `@`. Both values must resolve to a single jj
revision so the extension can open each file at both sides of the diff. When
`to` is `@`, the right-hand side is the editable working-copy file. Views that
target another revision remain read-only.

## Build and install locally

Requires Node.js 22+, npm 11.10+, [uv](https://docs.astral.sh/uv/), and the
VS Code `code` command on your `PATH`. On macOS, run **Shell Command: Install
'code' command in PATH** from VS Code's Command Palette if needed.

```sh
npm ci
npm run install:local
```

`install:local` checks types and lint, builds the extension and native helpers,
packages `jjk-local.vsix`, and installs it into VS Code, replacing the installed
version even when the version number is unchanged. The helper build uses Zig
0.15.2 through `uvx`, which downloads and caches the compiler on its first run.
The system Zig installation is not used.

Run **Developer: Reload Window** in VS Code after installing to load the update.
For later source changes, run `npm run install:local` again. To build a VSIX
without installing it, use `npm run package`.

## 🐛 Known Issues

### Experimental Back/Forward history for diff previews

VS Code removes a diff's navigation entry when its preview tab is replaced.
This optional companion patches the native history in memory so jj diffs remain
reachable with the existing Back/Forward commands while using one preview tab.
It also makes Explorer follow historical files and diffs, selecting the matching
workspace file using your existing auto-reveal settings without moving focus.
It does not change the installed application files or your keybindings.

Build and install the automatic companion from this repository with Node.js 22+:

```sh
npm run package:diff-history
code --install-extension out/jjk-native-diff-history.vsix --force
```

In **Preferences: Configure Runtime Arguments**, add
`"remote-debugging-port": "9347"` to `argv.json`, then fully quit and reopen
VS Code. The companion automatically applies the hook when you navigate, and
reconnects after window reloads. Diagnostics are available in the **JJK Native
Diff History** output channel.

This uses a local debugger to patch private workbench internals. It is tested on
VS Code 1.139.1; other builds may need changes. The port provides control over
the editor to local processes while VS Code is running.

To remove the workaround, uninstall **JJK Native Diff History**, remove the
runtime argument, and restart VS Code. History entries already discarded before
applying the hook cannot be recovered.

For a temporary session without the companion or saved runtime setting, fully
quit VS Code and use the manual launcher:

```sh
npm run vscode:diff-history
```

With the manual launcher, run `npm run vscode:diff-history -- --attach` after
window reloads, or restart VS Code normally to remove the temporary patch.

If you encounter any problems, please [report them on GitHub](https://github.com/keanemind/jjk/issues/)!

## 📝 License

This project is licensed under the [MIT License](LICENSE).
