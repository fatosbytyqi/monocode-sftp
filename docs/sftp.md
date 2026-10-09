# SFTP / FTP deployment

MonoCode has built-in SFTP and FTP(S) deployment, modelled on the VS Code
extension [SFTP by Natizyskunk](https://marketplace.visualstudio.com/items?itemName=Natizyskunk.sftp).
It reads the same config format, so an existing project config works unchanged.

**Where the config lives:** if the project has `.vscode/sftp.json`, MonoCode finds and
uses it automatically. Otherwise it uses `.monocode/sftp.json`, and **Create sftp.json**
creates the file there. When both exist, `.vscode/sftp.json` wins.

## Get started

1. Open a local project and choose the **Remote** tab in the sidebar.
2. Click **Create sftp.json**. A template opens in the editor. Fill in `host`,
   `username` and `remotePath`, then save.
3. Save any file to upload it (`"uploadOnSave": true`), or use the toolbar and the
   Explorer's right-click **SFTP** menu.

## Where things are

| Feature | Where |
| --- | --- |
| Upload / download a file or folder | Explorer right-click → **SFTP** → Upload / Download |
| Force upload / download (ignore rules off) | Explorer → SFTP → Force Upload / Force Download |
| Upload to all profiles | Explorer → SFTP → Upload to All Profiles |
| Diff local with remote | Explorer → SFTP → Diff with Remote, or Remote Explorer → Diff with Local |
| Sync local → remote, remote → local, both ways | Explorer (on a folder) → SFTP, or the Remote tab toolbar (whole context) |
| Delete the remote copy | Explorer → SFTP → Delete Remote, or Remote Explorer → Delete |
| Upload project / download project | Remote tab toolbar |
| Upload changed files (git) | Remote tab toolbar |
| Remote Explorer (browse the server) | Remote tab; click **Connect and browse** |
| Open a remote file (temp copy; saves upload back) | Remote Explorer: double-click, or right-click → Open |
| Edit in Local | Remote Explorer → Edit in Local (downloads into the project) |
| New file / folder, rename, delete on the server | Remote Explorer toolbar and right-click menu |
| Switch profile | Remote tab → **Profile** |
| Open SSH in Terminal | Remote tab toolbar (terminal icon) |
| Cancel all transfers / disconnect | Remote tab toolbar |
| Output log | Remote tab → **Output** |
| Upload on save | `"uploadOnSave": true` |
| Download on open | `"downloadOnOpen": true` or `"confirm"` |
| File watcher | `"watcher": { "files": "dist/**/*", "autoUpload": true, "autoDelete": false }` |

Password, key passphrase, two-factor codes and unknown host keys are asked for in a
dialog. Answers are kept in memory for the current app session only; they are never
written to disk.

## Config reference

The config (`.vscode/sftp.json` or `.monocode/sftp.json`) is one object, or an array of objects for several servers (each
then needs a `name` and a different `context`). Comments and trailing commas are
allowed.

| Option | Default | Notes |
| --- | --- | --- |
| `name` | host | Display name. Required with multiple configs. |
| `context` | project root | Local folder (relative to the project) this config maps. |
| `protocol` | `"sftp"` | `"sftp"`, `"ftp"` or `"local"` (a folder on this machine, e.g. a mounted share). |
| `host` | — | Host name or IP. Host aliases from `~/.ssh/config` are resolved (sftp). |
| `port` | 22 / 21 | |
| `username` | your login (sftp), `anonymous` (ftp) | |
| `password` | — | Omit to be asked when needed. |
| `remotePath` | `"/"` | Absolute remote folder that `context` maps to. |
| `connectTimeout` | 10000 | Milliseconds. |
| `uploadOnSave` | false | |
| `downloadOnOpen` | false | `true`, `false` or `"confirm"`. |
| `useTempFile` | false | Upload to a temp name, then rename into place. |
| `openSsh` | false | Same as `useTempFile` (atomic replace on the server). |
| `ignore` | `[]` | gitignore-style patterns, relative to `context`. The config file and the `.monocode` folder are always ignored. |
| `ignoreFile` | — | Path to a gitignore-style file whose rules are added. |
| `watcher.files` | — | Glob relative to `context`, e.g. `"**/*"` or `"dist/*.{js,css}"`, or a list of globs. In **Setup SFTP… → File watcher** you pick file types and folders as tags and the glob is written for you. |
| `watcher.autoUpload` | true | Upload files changed outside the editor. |
| `watcher.autoDelete` | false | Delete remote files when they are deleted locally. |
| `syncOption.delete` | false | Delete files on the destination that are missing on the source. |
| `syncOption.skipCreate` | false | Don't create files that are missing on the destination. |
| `syncOption.ignoreExisting` | false | Don't touch files that already exist on the destination. |
| `syncOption.update` | false | Only overwrite when the source is newer. |
| `concurrency` | 4 | Parallel transfers (FTP always uses 1). |
| `limitOpenFilesOnRemote` | — | `true` (222) or a number; caps concurrency. |
| `remoteTimeOffsetInHours` | 0 | Remote clock minus local clock, used when comparing times in sync. |
| `remoteExplorer.filesExclude` | `[]` | Globs hidden in the Remote Explorer. |
| `remoteExplorer.order` | 0 | Sort order of configs in the Remote tab. |
| `profiles` | — | `{ "dev": { …overrides }, "prod": { … } }` |
| `defaultProfile` | — | Profile active when the app starts. |
| `remote` | — | Name of an entry in `~/.monocode/sftp-remotes.json` to merge in (like the extension's `remotefs.remote` setting). |

SFTP only:

| Option | Notes |
| --- | --- |
| `privateKeyPath` | Key file. `~` and `${workspaceFolder}` are expanded. Without it, the SSH agent and unencrypted `~/.ssh/id_*` keys are tried. |
| `passphrase` | Key passphrase, or `true` to be asked. Encrypted keys always prompt if no passphrase is set. |
| `agent` | Path to an ssh-agent socket. Defaults to `$SSH_AUTH_SOCK`. |
| `interactiveAuth` | `true` to answer keyboard-interactive prompts (2FA) in a dialog, or an array of predefined answers. |
| `algorithms` | `{ kex, cipher, serverHostKey, hmac }` lists, to prefer specific algorithms. Unknown names are ignored. |
| `sshConfigPath` | OpenSSH config to resolve `host` from. Defaults to `~/.ssh/config`. |
| `sshCustomParams` | Extra arguments for **Open SSH in Terminal**. `${remotePath}` is substituted. |
| `hop` | Jump host(s): an object or an array of `{ host, port, username, password, privateKeyPath, passphrase, agent, interactiveAuth }`. As in the extension, the top-level `host` is the first machine and the last hop is the target. A hop's `privateKeyPath` is read locally if it exists, otherwise from the previous machine. |

FTP only:

| Option | Notes |
| --- | --- |
| `secure` | `true` / `"control"` for explicit FTPS (AUTH TLS), `"implicit"` for implicit FTPS (usually port 990). |
| `secureOptions.rejectUnauthorized` | `false` to accept self-signed certificates. |
| `passive` | Defaults to true; `false` uses active mode. |

### Host keys

Server keys are checked against `~/.ssh/known_hosts`. An unknown key asks whether to
trust it, and trusted keys are added to that file. A changed key is refused.

### Example

```jsonc
{
  "name": "Website",
  "host": "example.com",
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/var/www/site",
  "uploadOnSave": true,
  "ignore": [".git", ".vscode", "node_modules", ".DS_Store"],
  "watcher": { "files": "dist/**/*", "autoUpload": true, "autoDelete": false },
  "profiles": {
    "staging": { "host": "staging.example.com" },
    "prod": { "uploadOnSave": false }
  },
  "defaultProfile": "staging"
}
```

## Differences from the VS Code extension

- SFTP v3 cannot rename over an existing file, so `useTempFile`/`openSsh` uploads
  replace the old file with remove + rename. The window where the file is missing is
  only between those two calls.
- Pageant (Windows) is not supported for `agent`; use a key file instead.
- FTP transfers run one at a time on a single connection.
- The `secureOptions` TLS settings other than `rejectUnauthorized` are ignored.

## Tests

Unit tests run with `cargo test`. End-to-end tests against real servers are ignored
by default; see `src-tauri/src/sftp/e2e_tests.rs` for how to run them against a local
`sshd` and FTP server.
