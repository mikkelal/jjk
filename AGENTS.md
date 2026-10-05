# Local installation

After completing and verifying code changes, package and install the affected
VS Code extension locally before reporting that the work is done. Do this
automatically; do not leave installation as a step for the user.

- For the main JJK extension, run `npm run install:local`.
- For the native-history companion, run `npm run package:diff-history`, then
  `code --install-extension out/jjk-native-diff-history.vsix --force`.
- When the companion's native workbench hook changes, reload the affected VS Code
  window after installation so the updated hook takes effect. Preserve unsaved
  work.

Use host execution for installation commands that write to the user's VS Code
extension directory, and verify the installed extension version.
