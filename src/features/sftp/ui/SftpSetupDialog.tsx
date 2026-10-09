import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "../../../shared/ui/Modal";
import { Loader, Plus, Trash2 } from "../../../shared/ui/icons";
import { reloadConfigs } from "../model/sftp";
import { SftpWatcherSection } from "./SftpWatcherSection";

type Json = Record<string, unknown>;

type RawConfig = {
  path: string;
  exists: boolean;
  hasComments: boolean;
  entries: Json[];
  error: string | null;
};

type TestResult = { ok: boolean; message: string; details: string[] };

type Props = {
  workspace: string;
  projectName: string;
  onClose: () => void;
};

type Section =
  | "connection"
  | "auth"
  | "transfer"
  | "ignore"
  | "watcher"
  | "sync"
  | "explorer"
  | "hops"
  | "profiles"
  | "advanced";

const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "connection", label: "Connection", hint: "Server, port and folders" },
  { id: "auth", label: "Authentication", hint: "Password, key, agent, 2FA" },
  { id: "transfer", label: "Uploading", hint: "Upload on save, temp files" },
  { id: "ignore", label: "Ignore", hint: "Files that never transfer" },
  { id: "watcher", label: "File watcher", hint: "React to outside changes" },
  { id: "sync", label: "Sync", hint: "How folder sync behaves" },
  { id: "explorer", label: "Remote Explorer", hint: "What the browser shows" },
  { id: "hops", label: "Jump hosts", hint: "Connect through bastions" },
  { id: "profiles", label: "Profiles", hint: "dev / staging / prod" },
  { id: "advanced", label: "Advanced", hint: "Algorithms, SSH, remotes" },
];

const DEFAULT_IGNORE = [".vscode", ".git", ".DS_Store", "node_modules"];

function newEntry(name: string): Json {
  return {
    name,
    protocol: "sftp",
    host: "",
    port: 22,
    username: "",
    remotePath: "/var/www/html",
    uploadOnSave: true,
    ignore: DEFAULT_IGNORE,
  };
}

// ------------------------------------------------------------- value helpers

/** Set a key, removing it when the value is "empty" so the file stays tidy. */
function withKey(obj: Json, key: string, value: unknown): Json {
  const next = { ...obj };
  const empty =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0);
  if (empty) delete next[key];
  else next[key] = value;
  return next;
}

const str = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const num = (v: unknown) => (typeof v === "number" ? String(v) : "");
const lines = (v: unknown) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : "";
const toLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const toNumber = (text: string) => {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

// ---------------------------------------------------------------- controls

function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label
      className={`flex min-w-0 flex-col gap-1 ${wide ? "col-span-2" : ""}`}
    >
      <span className="text-[12px] font-medium text-content/80">{label}</span>
      {children}
      {hint ? (
        <span className="text-[11px] leading-snug text-content/45">{hint}</span>
      ) : null}
    </label>
  );
}

const inputClass =
  "w-full min-w-0 rounded-md border border-content/12 bg-content/[0.03] px-2 py-1.5 text-[13px] text-content outline-none placeholder:text-content/30 focus:border-accent";

function Text({
  value,
  onChange,
  placeholder,
  type = "text",
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      className={`${inputClass} ${mono ? "font-mono" : ""}`}
    />
  );
}

function Lines({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputClass} resize-y font-mono text-[12px]`}
    />
  );
}

function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={inputClass}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="col-span-2 flex cursor-pointer items-start gap-2.5 rounded-md py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? "bg-accent" : "bg-content/20"
        }`}
      >
        <span
          className={`size-3 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-3" : ""}`}
        />
      </button>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] text-content/85">{label}</span>
        {hint ? (
          <span className="text-[11px] leading-snug text-content/45">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function PathInput({
  value,
  onChange,
  placeholder,
  directory,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  directory?: boolean;
}) {
  return (
    <div className="flex gap-1.5">
      <Text value={value} onChange={onChange} placeholder={placeholder} mono />
      <button
        type="button"
        onClick={async () => {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const picked = await open({
            directory: !!directory,
            multiple: false,
          });
          if (typeof picked === "string") onChange(picked);
        }}
        className="shrink-0 rounded-md border border-content/12 px-2.5 text-[12px] text-content/70 hover:bg-content/8"
      >
        Browse…
      </button>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">{children}</div>;
}

function SectionTitle({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-[14px] font-semibold text-content">{title}</h3>
      {children ? (
        <p className="mt-0.5 text-[12px] leading-snug text-content/50">
          {children}
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ auth sub-form

type AuthTarget = Json;

function AuthFields({
  value,
  onChange,
  protocol,
}: {
  value: AuthTarget;
  onChange: (next: AuthTarget) => void;
  protocol: string;
}) {
  const set = (k: string, v: unknown) => onChange(withKey(value, k, v));
  const [passphraseMode, setPassphraseMode] = useState<
    "none" | "ask" | "value"
  >(
    value.passphrase === true
      ? "ask"
      : typeof value.passphrase === "string"
        ? "value"
        : "none",
  );
  const interactive = value.interactiveAuth;
  const interactiveMode =
    interactive === true
      ? "ask"
      : Array.isArray(interactive)
        ? "answers"
        : "off";
  const passwordField = (
    <Field
      label="Password"
      hint="Empty = ask when connecting (kept in memory only). If set, it is stored in plain text in the config file."
    >
      <Text
        type="password"
        value={str(value.password)}
        onChange={(v) => set("password", v)}
        placeholder="Ask when needed"
      />
    </Field>
  );
  if (protocol !== "sftp") return <Grid>{passwordField}</Grid>;
  return (
    <Grid>
      {passwordField}
      <Field label="Key passphrase">
        <Select
          value={passphraseMode}
          options={[
            { value: "none", label: "Ask only if the key is encrypted" },
            { value: "ask", label: "Always ask" },
            { value: "value", label: "Store in config" },
          ]}
          onChange={(m) => {
            setPassphraseMode(m);
            set(
              "passphrase",
              m === "ask"
                ? true
                : m === "value"
                  ? str(value.passphrase) || undefined
                  : undefined,
            );
          }}
        />
      </Field>
      <Field
        label="Private key"
        hint="e.g. ~/.ssh/id_ed25519. Without one, the SSH agent and ~/.ssh/id_* keys are tried."
        wide
      >
        <PathInput
          value={str(value.privateKeyPath)}
          onChange={(v) => set("privateKeyPath", v)}
          placeholder="~/.ssh/id_ed25519"
        />
      </Field>
      {passphraseMode === "value" ? (
        <Field label="Passphrase" wide>
          <Text
            type="password"
            value={str(value.passphrase)}
            onChange={(v) => set("passphrase", v)}
          />
        </Field>
      ) : null}
      <Field label="SSH agent socket" hint="Defaults to $SSH_AUTH_SOCK.">
        <Text
          value={str(value.agent)}
          onChange={(v) => set("agent", v)}
          placeholder="$SSH_AUTH_SOCK"
          mono
        />
      </Field>
      <Field
        label="Keyboard-interactive (2FA)"
        hint="Verification codes, or servers that ask for the password interactively."
      >
        <Select
          value={interactiveMode}
          options={[
            { value: "off", label: "Off" },
            { value: "ask", label: "Ask me for each prompt" },
            { value: "answers", label: "Use predefined answers" },
          ]}
          onChange={(m) =>
            set(
              "interactiveAuth",
              m === "ask"
                ? true
                : m === "answers"
                  ? Array.isArray(interactive)
                    ? interactive
                    : [""]
                  : undefined,
            )
          }
        />
      </Field>
      {interactiveMode === "answers" ? (
        <Field
          label="Predefined answers"
          hint="One answer per line, in prompt order."
          wide
        >
          <Lines
            rows={3}
            value={lines(interactive)}
            onChange={(t) => set("interactiveAuth", t.split("\n"))}
          />
        </Field>
      ) : null}
    </Grid>
  );
}

// ------------------------------------------------------------------- dialog

export function SftpSetupDialog({ workspace, projectName, onClose }: Props) {
  const [raw, setRaw] = useState<RawConfig | null>(null);
  const [entries, setEntries] = useState<Json[]>([]);
  const [current, setCurrent] = useState(0);
  const [section, setSection] = useState<Section>("connection");
  const [testProfile, setTestProfile] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void invoke<RawConfig>("sftp_read_raw", { workspace }).then((res) => {
      setRaw(res);
      setEntries(res.entries.length ? res.entries : [newEntry(projectName)]);
      if (!res.exists) setDirty(true);
    });
  }, [workspace, projectName]);

  const entry = entries[current] ?? {};
  const protocol = str(entry.protocol) || "sftp";
  const profiles = obj(entry.profiles);
  const profileNames = Object.keys(profiles);

  const update = (next: Json) => {
    setEntries((prev) => prev.map((e, i) => (i === current ? next : e)));
    setDirty(true);
    setTest(null);
  };
  const set = (key: string, value: unknown) =>
    update(withKey(entry, key, value));

  const problems = useMemo(() => {
    const out: string[] = [];
    entries.forEach((e, i) => {
      const label =
        entries.length > 1 ? `${str(e.name) || `Server ${i + 1}`}: ` : "";
      const p = str(e.protocol) || "sftp";
      if (p !== "local" && !str(e.host) && !str(e.remote))
        out.push(`${label}Host is required`);
      if (p === "sftp" && !str(e.username) && !str(e.remote))
        out.push(`${label}Username is required`);
      const rp = str(e.remotePath);
      if (p !== "local" && rp && !rp.startsWith("/") && !rp.startsWith("~"))
        out.push(`${label}Remote path should be absolute (start with /)`);
      if (entries.length > 1 && !str(e.name))
        out.push(`Server ${i + 1}: a name is needed with several servers`);
    });
    if (entries.length > 1) {
      const contexts = entries.map((e) => str(e.context) || ".");
      if (new Set(contexts).size !== contexts.length)
        out.push("Each server needs a different local folder (context)");
    }
    return out;
  }, [entries]);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(
        await invoke<TestResult>("sftp_test_connection", {
          workspace,
          entry,
          profile: testProfile || null,
        }),
      );
    } catch (e) {
      setTest({ ok: false, message: String(e), details: [] });
    } finally {
      setTesting(false);
    }
  };

  const save = async (close: boolean) => {
    setSaving(true);
    setSaveError(null);
    try {
      await invoke<string>("sftp_write_raw", { workspace, entries });
      setDirty(false);
      reloadConfigs();
      if (close) onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const configFile = raw?.path
    ? raw.path.replace(workspace.replace(/\/+$/, "") + "/", "")
    : "";

  if (!raw) {
    return (
      <Modal title="Setup SFTP" size="lg" onClose={onClose}>
        <div className="flex items-center gap-2 p-6 text-[13px] text-content/60">
          <Loader className="size-4 animate-spin" /> Loading…
        </div>
      </Modal>
    );
  }

  const watcher = entry.watcher ? obj(entry.watcher) : null;
  const sync = obj(entry.syncOption);
  const explorer = obj(entry.remoteExplorer);
  const algorithms = obj(entry.algorithms);
  const secureOptions = obj(entry.secureOptions);
  const hops: Json[] = Array.isArray(entry.hop)
    ? (entry.hop as Json[])
    : entry.hop
      ? [obj(entry.hop)]
      : [];
  const setHops = (next: Json[]) =>
    set(
      "hop",
      next.length === 0 ? undefined : next.length === 1 ? next[0] : next,
    );

  const body = (() => {
    switch (section) {
      case "connection":
        return (
          <>
            <SectionTitle title="Connection">
              Where to connect and which folders to map.
            </SectionTitle>
            <Grid>
              <Field label="Name" hint="Shown in the Remote tab.">
                <Text
                  value={str(entry.name)}
                  onChange={(v) => set("name", v)}
                  placeholder={projectName}
                />
              </Field>
              <Field label="Protocol">
                <Select
                  value={protocol as "sftp" | "ftp" | "local"}
                  options={[
                    { value: "sftp", label: "SFTP (SSH)" },
                    { value: "ftp", label: "FTP / FTPS" },
                    { value: "local", label: "Local folder / mounted share" },
                  ]}
                  onChange={(v) => {
                    let next = withKey(entry, "protocol", v);
                    const port = entry.port;
                    if (port === 22 || port === 21 || port === undefined)
                      next = withKey(
                        next,
                        "port",
                        v === "ftp" ? 21 : v === "sftp" ? 22 : undefined,
                      );
                    update(next);
                  }}
                />
              </Field>
              {protocol !== "local" ? (
                <>
                  <Field
                    label="Host"
                    hint={
                      protocol === "sftp"
                        ? "Host name, IP, or an alias from ~/.ssh/config."
                        : "Host name or IP."
                    }
                  >
                    <Text
                      value={str(entry.host)}
                      onChange={(v) => set("host", v)}
                      placeholder="example.com"
                    />
                  </Field>
                  <Field label="Port">
                    <Text
                      value={num(entry.port)}
                      onChange={(v) => set("port", toNumber(v))}
                      placeholder={protocol === "ftp" ? "21" : "22"}
                    />
                  </Field>
                  <Field
                    label="Username"
                    hint={protocol === "ftp" ? "Empty = anonymous." : undefined}
                  >
                    <Text
                      value={str(entry.username)}
                      onChange={(v) => set("username", v)}
                      placeholder="deploy"
                    />
                  </Field>
                  <Field label="Connect timeout (ms)">
                    <Text
                      value={num(entry.connectTimeout)}
                      onChange={(v) => set("connectTimeout", toNumber(v))}
                      placeholder="10000"
                    />
                  </Field>
                </>
              ) : null}
              <Field
                label={protocol === "local" ? "Target folder" : "Remote path"}
                hint={
                  protocol === "local"
                    ? "Absolute folder on this computer to mirror into."
                    : "Absolute folder on the server the project maps to."
                }
                wide
              >
                {protocol === "local" ? (
                  <PathInput
                    directory
                    value={str(entry.remotePath)}
                    onChange={(v) => set("remotePath", v)}
                    placeholder="/Volumes/share/site"
                  />
                ) : (
                  <Text
                    value={str(entry.remotePath)}
                    onChange={(v) => set("remotePath", v)}
                    placeholder="/var/www/html"
                    mono
                  />
                )}
              </Field>
              <Field
                label="Local folder (context)"
                hint="Relative to the project. Leave empty to use the whole project."
                wide
              >
                <Text
                  value={str(entry.context)}
                  onChange={(v) => set("context", v)}
                  placeholder="(project root)"
                  mono
                />
              </Field>
              {protocol === "ftp" ? (
                <>
                  <Field label="Encryption">
                    <Select
                      value={
                        entry.secure === true
                          ? "true"
                          : str(entry.secure) || "false"
                      }
                      options={[
                        { value: "false", label: "None (plain FTP)" },
                        { value: "true", label: "Explicit FTPS (AUTH TLS)" },
                        {
                          value: "control",
                          label: "Explicit FTPS, control channel",
                        },
                        {
                          value: "implicit",
                          label: "Implicit FTPS (port 990)",
                        },
                      ]}
                      onChange={(v) =>
                        set(
                          "secure",
                          v === "true" ? true : v === "false" ? undefined : v,
                        )
                      }
                    />
                  </Field>
                  <div />
                  <Toggle
                    label="Passive mode"
                    hint="Recommended; turn off only if the server requires active mode."
                    checked={entry.passive !== false}
                    onChange={(v) => set("passive", v ? undefined : false)}
                  />
                  {entry.secure ? (
                    <Toggle
                      label="Verify the server's TLS certificate"
                      hint="Turn off for self-signed certificates."
                      checked={secureOptions.rejectUnauthorized !== false}
                      onChange={(v) =>
                        set(
                          "secureOptions",
                          withKey(
                            secureOptions,
                            "rejectUnauthorized",
                            v ? undefined : false,
                          ),
                        )
                      }
                    />
                  ) : null}
                </>
              ) : null}
            </Grid>
          </>
        );
      case "auth":
        return (
          <>
            <SectionTitle title="Authentication">
              {protocol === "local"
                ? "A local folder needs no authentication."
                : "Tried in order: password, private key, SSH agent, keyboard-interactive, then a password prompt."}
            </SectionTitle>
            {protocol !== "local" ? (
              <AuthFields
                key={current}
                value={entry}
                onChange={update}
                protocol={protocol}
              />
            ) : null}
            {protocol === "sftp" ? (
              <p className="mt-4 text-[11px] leading-snug text-content/45">
                Unknown servers ask you to confirm their host key, which is then
                saved to ~/.ssh/known_hosts. A changed key is refused.
              </p>
            ) : null}
          </>
        );
      case "transfer":
        return (
          <>
            <SectionTitle title="Uploading">
              When and how files go to the server.
            </SectionTitle>
            <Grid>
              <Toggle
                label="Upload on save"
                hint="Upload a file every time you save it in the editor."
                checked={entry.uploadOnSave === true}
                onChange={(v) => set("uploadOnSave", v || undefined)}
              />
              <Field
                label="Download on open"
                hint="Refresh a file from the server when you open it."
              >
                <Select
                  value={
                    entry.downloadOnOpen === true
                      ? "true"
                      : entry.downloadOnOpen === "confirm"
                        ? "confirm"
                        : "false"
                  }
                  options={[
                    { value: "false", label: "Off" },
                    { value: "true", label: "Always" },
                    { value: "confirm", label: "Ask first" },
                  ]}
                  onChange={(v) =>
                    set(
                      "downloadOnOpen",
                      v === "true"
                        ? true
                        : v === "confirm"
                          ? "confirm"
                          : undefined,
                    )
                  }
                />
              </Field>
              <div />
              <Toggle
                label="Upload through a temp file"
                hint="Write to a temporary name, then rename into place, so visitors never see a half-uploaded file."
                checked={entry.useTempFile === true}
                onChange={(v) => set("useTempFile", v || undefined)}
              />
              <Toggle
                label="OpenSSH atomic replace"
                hint="Same as above for OpenSSH servers (openSsh)."
                checked={entry.openSsh === true}
                onChange={(v) => set("openSsh", v || undefined)}
              />
              <Field label="Parallel transfers" hint="FTP always uses 1.">
                <Text
                  value={num(entry.concurrency)}
                  onChange={(v) => set("concurrency", toNumber(v))}
                  placeholder="4"
                />
              </Field>
              <Field
                label="Limit open files on server"
                hint="Caps parallel transfers. Empty = no limit."
              >
                <Text
                  value={
                    entry.limitOpenFilesOnRemote === true
                      ? "222"
                      : num(entry.limitOpenFilesOnRemote)
                  }
                  onChange={(v) => set("limitOpenFilesOnRemote", toNumber(v))}
                  placeholder="no limit"
                />
              </Field>
              <Field
                label="Remote time offset (hours)"
                hint="Server clock minus local clock; used to compare dates when syncing."
              >
                <Text
                  value={num(entry.remoteTimeOffsetInHours)}
                  onChange={(v) => set("remoteTimeOffsetInHours", toNumber(v))}
                  placeholder="0"
                />
              </Field>
            </Grid>
          </>
        );
      case "ignore":
        return (
          <>
            <SectionTitle title="Ignore">
              gitignore-style patterns, relative to the local folder. Ignored
              files are never uploaded, downloaded or synced (except with Force
              Upload / Download). The SFTP config itself is always ignored.
            </SectionTitle>
            <Grid>
              <Field
                label="Patterns"
                hint="One per line. Examples: node_modules, *.log, /build, !keep.log"
                wide
              >
                <Lines
                  rows={8}
                  value={lines(entry.ignore)}
                  onChange={(t) => set("ignore", toLines(t))}
                  placeholder={DEFAULT_IGNORE.join("\n")}
                />
              </Field>
              <Field
                label="Ignore file"
                hint="Also read patterns from this file, e.g. .gitignore."
                wide
              >
                <PathInput
                  value={str(entry.ignoreFile)}
                  onChange={(v) => set("ignoreFile", v)}
                  placeholder=".gitignore"
                />
              </Field>
            </Grid>
          </>
        );
      case "watcher":
        return (
          <SftpWatcherSection
            key={current}
            workspace={workspace}
            context={str(entry.context)}
            watcher={watcher}
            onChange={(next) => set("watcher", next)}
          />
        );
      case "sync":
        return (
          <>
            <SectionTitle title="Sync">
              Used by Sync Local → Remote, Remote → Local and Both Directions.
              With everything off, sync copies new and changed files and never
              deletes.
            </SectionTitle>
            <Grid>
              <Toggle
                label="Delete extra files on the destination"
                hint="Mirror exactly: remove files that no longer exist on the source."
                checked={sync.delete === true}
                onChange={(v) =>
                  set("syncOption", withKey(sync, "delete", v || undefined))
                }
              />
              <Toggle
                label="Skip creating new files"
                hint="Only update files that already exist on the destination."
                checked={sync.skipCreate === true}
                onChange={(v) =>
                  set("syncOption", withKey(sync, "skipCreate", v || undefined))
                }
              />
              <Toggle
                label="Skip files that already exist"
                hint="Only copy files missing on the destination."
                checked={sync.ignoreExisting === true}
                onChange={(v) =>
                  set(
                    "syncOption",
                    withKey(sync, "ignoreExisting", v || undefined),
                  )
                }
              />
              <Toggle
                label="Only overwrite older files"
                hint="Skip a file unless the source copy is newer."
                checked={sync.update === true}
                onChange={(v) =>
                  set("syncOption", withKey(sync, "update", v || undefined))
                }
              />
            </Grid>
          </>
        );
      case "explorer":
        return (
          <>
            <SectionTitle title="Remote Explorer">
              Controls the server browser in the Remote tab.
            </SectionTitle>
            <Grid>
              <Field
                label="Hide these files"
                hint="Globs, one per line, e.g. **/.git, **/cache"
                wide
              >
                <Lines
                  rows={5}
                  value={lines(explorer.filesExclude)}
                  onChange={(t) =>
                    set(
                      "remoteExplorer",
                      withKey(explorer, "filesExclude", toLines(t)),
                    )
                  }
                  placeholder="**/.git"
                />
              </Field>
              <Field
                label="Sort order"
                hint="Lower numbers are listed first when there are several servers."
              >
                <Text
                  value={num(explorer.order)}
                  onChange={(v) =>
                    set(
                      "remoteExplorer",
                      withKey(explorer, "order", toNumber(v)),
                    )
                  }
                  placeholder="0"
                />
              </Field>
            </Grid>
          </>
        );
      case "hops":
        return (
          <>
            <SectionTitle title="Jump hosts">
              {protocol === "sftp"
                ? "The Connection tab's host is the first machine; each hop below is the next one, and the last hop is the server where files go. A hop's key is read on this computer if it exists here, otherwise on the previous machine."
                : "Jump hosts are only available with SFTP."}
            </SectionTitle>
            {protocol === "sftp" ? (
              <div className="flex flex-col gap-3">
                {hops.map((hop, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-content/10 p-3"
                  >
                    <div className="mb-2 flex items-center">
                      <span className="flex-1 text-[12px] font-medium text-content/70">
                        Hop {i + 1}
                        {i === hops.length - 1 ? " — target server" : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove hop ${i + 1}`}
                        onClick={() => setHops(hops.filter((_, j) => j !== i))}
                        className="grid size-6 place-items-center rounded text-content/50 hover:bg-content/8 hover:text-red-400"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.75} />
                      </button>
                    </div>
                    <Grid>
                      <Field label="Host">
                        <Text
                          value={str(hop.host)}
                          onChange={(v) =>
                            setHops(
                              hops.map((h, j) =>
                                j === i ? withKey(h, "host", v) : h,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label="Port">
                        <Text
                          value={num(hop.port)}
                          placeholder="22"
                          onChange={(v) =>
                            setHops(
                              hops.map((h, j) =>
                                j === i ? withKey(h, "port", toNumber(v)) : h,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label="Username" wide>
                        <Text
                          value={str(hop.username)}
                          onChange={(v) =>
                            setHops(
                              hops.map((h, j) =>
                                j === i ? withKey(h, "username", v) : h,
                              ),
                            )
                          }
                        />
                      </Field>
                    </Grid>
                    <div className="mt-3">
                      <AuthFields
                        key={`${current}:${i}`}

                        protocol="sftp"
                        value={hop}
                        onChange={(next) =>
                          setHops(hops.map((h, j) => (j === i ? next : h)))
                        }
                      />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setHops([...hops, { host: "", username: "" }])}
                  className="flex items-center gap-1.5 self-start rounded-md border border-content/12 px-2.5 py-1 text-[12px] text-content/75 hover:bg-content/8"
                >
                  <Plus className="size-3.5" strokeWidth={1.75} /> Add hop
                </button>
              </div>
            ) : null}
          </>
        );
      case "profiles":
        return (
          <ProfilesSection
            entry={entry}
            profiles={profiles}
            onChange={(nextProfiles, defaultProfile) => {
              let next = withKey(entry, "profiles", nextProfiles);
              next = withKey(next, "defaultProfile", defaultProfile);
              update(next);
            }}
          />
        );
      case "advanced":
        return (
          <>
            <SectionTitle title="Advanced" />
            <Grid>
              {protocol === "sftp" ? (
                <>
                  <Field
                    label="SSH config file"
                    hint="Resolve the host from this OpenSSH config. Defaults to ~/.ssh/config."
                    wide
                  >
                    <PathInput
                      value={str(entry.sshConfigPath)}
                      onChange={(v) => set("sshConfigPath", v)}
                      placeholder="~/.ssh/config"
                    />
                  </Field>
                  <Field
                    label="Open SSH in Terminal: remote command"
                    hint={
                      'Runs after connecting. ${remotePath} is replaced. Default: "cd \\"${remotePath}\\"; exec \\$SHELL -l"'
                    }
                    wide
                  >
                    <Text
                      value={str(entry.sshCustomParams)}
                      onChange={(v) => set("sshCustomParams", v)}
                      mono
                    />
                  </Field>
                  {(
                    [
                      [
                        "kex",
                        "Key exchange",
                        "curve25519-sha256\necdh-sha2-nistp256\ndiffie-hellman-group14-sha1",
                      ],
                      [
                        "cipher",
                        "Ciphers",
                        "aes128-ctr\naes256-gcm@openssh.com\nchacha20-poly1305@openssh.com",
                      ],
                      [
                        "serverHostKey",
                        "Server host key",
                        "ssh-ed25519\nrsa-sha2-512\necdsa-sha2-nistp256",
                      ],
                      ["hmac", "MAC", "hmac-sha2-256\nhmac-sha2-512"],
                    ] as const
                  ).map(([key, label, placeholder]) => (
                    <Field
                      key={key}
                      label={`Algorithms: ${label}`}
                      hint="One per line, preferred first. Empty = defaults."
                    >
                      <Lines
                        rows={3}
                        value={lines(algorithms[key])}
                        placeholder={placeholder}
                        onChange={(t) =>
                          set(
                            "algorithms",
                            withKey(algorithms, key, toLines(t)),
                          )
                        }
                      />
                    </Field>
                  ))}
                </>
              ) : null}
              <Field
                label="Named remote"
                hint="Merge settings from an entry in ~/.monocode/sftp-remotes.json (shared across projects)."
                wide
              >
                <Text
                  value={str(entry.remote)}
                  onChange={(v) => set("remote", v)}
                  placeholder="my-server"
                />
              </Field>
            </Grid>
          </>
        );
    }
  })();

  return (
    <Modal
      title="Setup SFTP"
      description={`${projectName} · ${configFile}`}
      size="lg"
      fitViewport
      onClose={onClose}
      className="h-[min(760px,calc(100dvh-32px))]"
    >
      <div className="flex h-full min-h-0 flex-col">
        {raw.error ? (
          <p className="mx-4 mt-2 rounded-md border border-red-400/30 px-3 py-2 text-[12px] text-red-400">
            The current file could not be read ({raw.error}). Saving will
            replace it.
          </p>
        ) : raw.hasComments ? (
          <p className="mx-4 mt-2 rounded-md border border-amber-400/30 px-3 py-2 text-[12px] text-amber-400">
            This file has comments. Saving from this form rewrites it without
            comments.
          </p>
        ) : null}
        <div className="flex items-center gap-1.5 overflow-x-auto px-4 pt-3">
          {entries.map((e, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setCurrent(i);
                setTest(null);
              }}
              className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] ${
                i === current
                  ? "bg-selection text-content"
                  : "text-content/60 hover:bg-content/8"
              }`}
            >
              {str(e.name) || str(e.host) || `Server ${i + 1}`}
            </button>
          ))}
          <button
            type="button"
            title="Add another server (for a different local folder)"
            onClick={() => {
              setEntries((prev) => [
                ...prev,
                { ...newEntry(`Server ${prev.length + 1}`), context: "" },
              ]);
              setCurrent(entries.length);
              setDirty(true);
            }}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-content/55 hover:bg-content/8 hover:text-content"
          >
            <Plus className="size-3" strokeWidth={1.75} /> Add server
          </button>
          {entries.length > 1 ? (
            <button
              type="button"
              onClick={() => {
                setEntries((prev) => prev.filter((_, i) => i !== current));
                setCurrent(0);
                setDirty(true);
              }}
              className="ml-auto shrink-0 rounded-md px-2 py-1 text-[12px] text-red-400/80 hover:bg-red-400/10"
            >
              Remove this server
            </button>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 gap-4 px-4 pt-3">
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto pb-3">
            {SECTIONS.filter(
              (s) =>
                !(protocol === "local" && (s.id === "auth" || s.id === "hops")),
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`flex flex-col rounded-md px-2.5 py-1.5 text-left ${
                  section === s.id ? "bg-selection" : "hover:bg-content/5"
                }`}
              >
                <span
                  className={`text-[13px] ${section === s.id ? "text-content" : "text-content/75"}`}
                >
                  {s.label}
                </span>
                <span className="text-[11px] text-content/40">{s.hint}</span>
              </button>
            ))}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 pb-4">
            {body}
          </div>
        </div>
        <footer className="flex shrink-0 flex-col gap-2 border-t border-stroke px-4 py-3">
          {test ? (
            <div
              className={`rounded-md border px-3 py-2 text-[12px] ${
                test.ok
                  ? "border-emerald-400/30 text-emerald-400"
                  : "border-red-400/30 text-red-400"
              }`}
            >
              <div className="font-medium">
                {test.ok ? "✓ " : "✕ "}
                {test.message}
              </div>
              {test.details.length ? (
                <div
                  className="truncate text-content/55"
                  title={test.details.join("\n")}
                >
                  {test.details.join(" · ")}
                </div>
              ) : null}
            </div>
          ) : null}
          {problems.length ? (
            <div className="text-[12px] text-amber-400">
              {problems.join(" · ")}
            </div>
          ) : null}
          {saveError ? (
            <div className="text-[12px] text-red-400">{saveError}</div>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={testing || problems.length > 0}
              onClick={() => void runTest()}
              className="flex items-center gap-1.5 rounded-md border border-content/15 px-3 py-1.5 text-[12px] text-content/85 hover:bg-content/8 disabled:opacity-40"
            >
              {testing ? <Loader className="size-3.5 animate-spin" /> : null}
              {testing ? "Testing…" : "Test connection"}
            </button>
            {profileNames.length ? (
              <select
                value={testProfile}
                onChange={(e) => setTestProfile(e.target.value)}
                className="rounded-md border border-content/12 bg-transparent px-1.5 py-1 text-[12px] text-content/75 outline-none"
                title="Profile to test with"
              >
                <option value="">without profile</option>
                {profileNames.map((p) => (
                  <option key={p} value={p}>
                    with “{p}”
                  </option>
                ))}
              </select>
            ) : null}
            <span className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8"
            >
              {dirty ? "Cancel" : "Close"}
            </button>
            <button
              type="button"
              disabled={saving || problems.length > 0 || !dirty}
              onClick={() => void save(true)}
              className="rounded-md bg-accent px-3.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {saving ? "Saving…" : raw.exists ? "Save" : "Create config"}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- profiles

const PROFILE_FIELDS: {
  key: string;
  label: string;
  placeholder?: string;
  type?: string;
}[] = [
  { key: "host", label: "Host" },
  { key: "port", label: "Port" },
  { key: "username", label: "Username" },
  { key: "password", label: "Password", type: "password" },
  { key: "privateKeyPath", label: "Private key" },
  { key: "remotePath", label: "Remote path" },
];

function ProfilesSection({
  entry,
  profiles,
  onChange,
}: {
  entry: Json;
  profiles: Json;
  onChange: (profiles: Json, defaultProfile: string | undefined) => void;
}) {
  const names = Object.keys(profiles);
  const defaultProfile = str(entry.defaultProfile);
  const [newName, setNewName] = useState("");
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});

  const setProfile = (name: string, value: Json) =>
    onChange({ ...profiles, [name]: value }, defaultProfile || undefined);

  return (
    <>
      <SectionTitle title="Profiles">
        Named sets of overrides, e.g. dev / staging / prod. Switch between them
        in the Remote tab. Empty fields inherit the main settings.
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {names.length ? (
          <Field label="Default profile" hint="Active when the app starts.">
            <Select
              value={defaultProfile}
              options={[
                { value: "", label: "(none)" },
                ...names.map((n) => ({ value: n, label: n })),
              ]}
              onChange={(v) => onChange(profiles, v || undefined)}
            />
          </Field>
        ) : null}
        {names.map((name) => {
          const profile = obj(profiles[name]);
          const known = new Set([
            ...PROFILE_FIELDS.map((f) => f.key),
            "uploadOnSave",
          ]);
          const extra = Object.fromEntries(
            Object.entries(profile).filter(([k]) => !known.has(k)),
          );
          return (
            <div key={name} className="rounded-lg border border-content/10 p-3">
              <div className="mb-2 flex items-center">
                <span className="flex-1 text-[13px] font-medium text-content/85">
                  {name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove profile ${name}`}
                  onClick={() => {
                    const next = { ...profiles };
                    delete next[name];
                    onChange(
                      next,
                      defaultProfile === name
                        ? undefined
                        : defaultProfile || undefined,
                    );
                  }}
                  className="grid size-6 place-items-center rounded text-content/50 hover:bg-content/8 hover:text-red-400"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>
              <Grid>
                {PROFILE_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Text
                      type={f.type}
                      value={
                        f.key === "port"
                          ? num(profile.port)
                          : str(profile[f.key])
                      }
                      placeholder={
                        f.key === "port"
                          ? num(entry.port)
                          : f.type === "password"
                            ? "inherit"
                            : str(entry[f.key]) || "inherit"
                      }
                      onChange={(v) =>
                        setProfile(
                          name,
                          withKey(
                            profile,
                            f.key,
                            f.key === "port" ? toNumber(v) : v,
                          ),
                        )
                      }
                    />
                  </Field>
                ))}
                <Field label="Upload on save">
                  <Select
                    value={
                      profile.uploadOnSave === true
                        ? "true"
                        : profile.uploadOnSave === false
                          ? "false"
                          : ""
                    }
                    options={[
                      { value: "", label: "Inherit" },
                      { value: "true", label: "On" },
                      { value: "false", label: "Off" },
                    ]}
                    onChange={(v) =>
                      setProfile(
                        name,
                        withKey(
                          profile,
                          "uploadOnSave",
                          v === "" ? undefined : v === "true",
                        ),
                      )
                    }
                  />
                </Field>
                <Field
                  label="Other overrides (JSON)"
                  hint={
                    jsonErrors[name] ??
                    'Any other option, e.g. { "syncOption": { "delete": true } }'
                  }
                  wide
                >
                  <Lines
                    rows={2}
                    value={
                      Object.keys(extra).length ? JSON.stringify(extra) : ""
                    }
                    placeholder="{}"
                    onChange={(t) => {
                      try {
                        const parsed = t.trim() ? JSON.parse(t) : {};
                        if (
                          !parsed ||
                          typeof parsed !== "object" ||
                          Array.isArray(parsed)
                        )
                          throw new Error("Must be an object");
                        const base = Object.fromEntries(
                          Object.entries(profile).filter(([k]) => known.has(k)),
                        );
                        setProfile(name, { ...base, ...parsed });
                        setJsonErrors((e) => ({
                          ...e,
                          [name]: undefined as unknown as string,
                        }));
                      } catch (error) {
                        setJsonErrors((e) => ({
                          ...e,
                          [name]: `Invalid JSON: ${String(error)}`,
                        }));
                      }
                    }}
                  />
                </Field>
              </Grid>
            </div>
          );
        })}
        <div className="flex gap-1.5">
          <input
            value={newName}
            placeholder="New profile name, e.g. prod"
            onChange={(e) => setNewName(e.target.value.replace(/\s+/g, "-"))}
            className={`${inputClass} max-w-64`}
          />
          <button
            type="button"
            disabled={!newName || names.includes(newName)}
            onClick={() => {
              setProfile(newName, {});
              setNewName("");
            }}
            className="flex items-center gap-1.5 rounded-md border border-content/12 px-2.5 text-[12px] text-content/75 hover:bg-content/8 disabled:opacity-40"
          >
            <Plus className="size-3.5" strokeWidth={1.75} /> Add profile
          </button>
        </div>
      </div>
    </>
  );
}
