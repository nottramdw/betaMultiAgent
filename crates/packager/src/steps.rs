use crate::args::{BuildOptions, NodeSource};
use crate::error::PackagerError;
use crate::node_dist::{NodeBinary, NodeRelease, fetch_official};
use crate::process::{run, run_with_input, text};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SENTINEL_FUSE: &str = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const KEY_VARIABLES: [&str; 3] = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "XAI_API_KEY"];
const JSON_LINES_CHECK: &str = "const lines = require('node:fs').readFileSync(0, 'utf8').trim().split(/\\r?\\n/); for (const line of lines) JSON.parse(line);";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

impl Os {
    pub fn current() -> Self {
        match std::env::consts::OS {
            "macos" => Self::Mac,
            "windows" => Self::Windows,
            _ => Self::Other,
        }
    }
}

pub fn binary_name(os: Os) -> &'static str {
    if os == Os::Windows { "bma.exe" } else { "bma" }
}

pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn sea_config(main: &Path, output: &Path) -> String {
    format!(
        "{{\n  \"main\": {},\n  \"output\": {},\n  \"disableExperimentalSEAWarning\": true,\n  \"useSnapshot\": false,\n  \"useCodeCache\": false\n}}\n",
        json_string(&main.to_string_lossy()),
        json_string(&output.to_string_lossy())
    )
}

pub fn postject_args(os: Os, cli: &Path, binary: &Path, blob: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        cli.into(),
        binary.into(),
        "NODE_SEA_BLOB".into(),
        blob.into(),
        "--sentinel-fuse".into(),
        SENTINEL_FUSE.into(),
    ];
    if os == Os::Mac {
        args.push("--macho-segment-name".into());
        args.push("NODE_SEA".into());
    }
    args
}

pub fn license_candidates(binary: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = binary.parent() {
        candidates.push(dir.join("LICENSE"));
        if let Some(prefix) = dir.parent() {
            candidates.push(prefix.join("LICENSE"));
            candidates.push(
                prefix
                    .join("share")
                    .join("doc")
                    .join("node")
                    .join("LICENSE"),
            );
        }
    }
    candidates
}

fn log(step: &str) {
    eprintln!("[bma-packager] {step}");
}

fn absolute(path: &Path) -> Result<PathBuf, PackagerError> {
    std::path::absolute(path)
        .map_err(|source| PackagerError::io(format!("cannot resolve {}", path.display()), source))
}

fn create_dir(path: &Path) -> Result<(), PackagerError> {
    fs::create_dir_all(path)
        .map_err(|source| PackagerError::io(format!("cannot create {}", path.display()), source))
}

fn node_query(node: &Path, expression: &str) -> Result<String, PackagerError> {
    Ok(text(
        &run(Command::new(node).arg("-p").arg(expression))?.stdout,
    ))
}

fn local_node(options: &BuildOptions, path: PathBuf) -> Result<NodeBinary, PackagerError> {
    let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    let license = match &options.node_license {
        Some(license) => absolute(license)?,
        None => license_candidates(&real)
            .into_iter()
            .chain(license_candidates(&path))
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| {
                PackagerError::Usage(format!(
                    "no Node.js LICENSE file found next to {}; pass --node-license <path>",
                    path.display()
                ))
            })?,
    };
    let version = node_query(&path, "process.version")?;
    Ok(NodeBinary {
        path,
        license,
        version,
    })
}

fn resolve_node(
    options: &BuildOptions,
    root: &Path,
    work: &Path,
) -> Result<NodeBinary, PackagerError> {
    let host = PathBuf::from(node_query(Path::new("node"), "process.execPath")?);
    match &options.node {
        NodeSource::Current => local_node(options, host),
        NodeSource::Path(path) => local_node(options, absolute(path)?),
        NodeSource::Official => {
            let release = NodeRelease {
                version: node_query(&host, "process.version")?,
                platform: node_query(&host, "process.platform")?,
                arch: node_query(&host, "process.arch")?,
            };
            log(&format!(
                "downloading official Node.js {} ({}-{})",
                release.version, release.platform, release.arch
            ));
            let mut binary = fetch_official(root, work, &host, &release, &options.gpg)?;
            if let Some(license) = &options.node_license {
                binary.license = absolute(license)?;
            }
            Ok(binary)
        }
    }
}

fn make_writable(path: &Path) -> Result<(), PackagerError> {
    let metadata = fs::metadata(path).map_err(|source| {
        PackagerError::io(format!("cannot inspect {}", path.display()), source)
    })?;
    let mut permissions = metadata.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
    }
    #[cfg(not(unix))]
    {
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
    }
    fs::set_permissions(path, permissions).map_err(|source| {
        PackagerError::io(format!("cannot make {} writable", path.display()), source)
    })
}

fn smoke(binary: &Path, version: &str, work: &Path) -> Result<(), PackagerError> {
    let base = work.join("smoke");
    if base.exists() {
        fs::remove_dir_all(&base).map_err(|source| {
            PackagerError::io(format!("cannot clear {}", base.display()), source)
        })?;
    }
    let home = base.join("home");
    let workspace = base.join("workspace");
    create_dir(&home)?;
    create_dir(&workspace)?;
    let command = |args: &[&str]| {
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(&workspace)
            .env("BMA_HOME", &home);
        for key in KEY_VARIABLES {
            command.env_remove(key);
        }
        command
    };
    let printed = text(&run(&mut command(&["--version"]))?.stdout);
    if printed != version {
        return Err(PackagerError::Smoke(format!(
            "--version printed {printed:?}, expected {version:?}"
        )));
    }
    let doctor = run(&mut command(&["doctor", "--json"]))?.stdout;
    run_with_input(
        Command::new("node").arg("-e").arg(JSON_LINES_CHECK),
        &doctor,
    )
    .map_err(|error| {
        PackagerError::Smoke(format!("doctor --json printed invalid JSON: {error}"))
    })?;
    if !String::from_utf8_lossy(&doctor).contains("\"type\":\"doctor\"") {
        return Err(PackagerError::Smoke(
            "doctor --json did not report a doctor result".to_owned(),
        ));
    }
    run(&mut command(&["run", "--help"]))?;
    Ok(())
}

pub fn build(options: &BuildOptions) -> Result<PathBuf, PackagerError> {
    let os = Os::current();
    let root = absolute(&options.root)?;
    if !root.join("scripts").join("bundle-cli.ts").is_file() {
        return Err(PackagerError::Usage(format!(
            "{} is not the repository root (scripts/bundle-cli.ts is missing); pass --root",
            root.display()
        )));
    }
    let work = root.join("target").join("sea");
    let out = absolute(&options.out)?;
    create_dir(&work)?;
    create_dir(&out)?;

    log("bundling the CLI");
    run(Command::new("node")
        .arg(root.join("scripts").join("bundle-cli.ts"))
        .arg("--out-dir")
        .arg(&work)
        .current_dir(&root))?;
    let version = fs::read_to_string(work.join("version.txt"))
        .map_err(|source| PackagerError::io("cannot read the bundled version", source))?
        .trim()
        .to_owned();

    let node = resolve_node(options, &root, &work)?;
    log(&format!(
        "embedding Node.js {} from {}",
        node.version,
        node.path.display()
    ));

    log("collecting third-party licenses");
    run(Command::new("node")
        .arg(root.join("scripts").join("collect-licenses.ts"))
        .arg("--meta")
        .arg(work.join("meta.json"))
        .arg("--out")
        .arg(out.join("THIRD_PARTY_LICENSES.txt"))
        .arg("--node-license")
        .arg(&node.license)
        .arg("--node-version")
        .arg(&node.version)
        .current_dir(&root))?;

    log("preparing the SEA blob");
    let config = work.join("sea-config.json");
    let blob = work.join("sea-prep.blob");
    fs::write(&config, sea_config(&work.join("bma.cjs"), &blob)).map_err(|source| {
        PackagerError::io(format!("cannot write {}", config.display()), source)
    })?;
    run(Command::new(&node.path)
        .arg("--experimental-sea-config")
        .arg(&config)
        .current_dir(&root))?;

    let binary = out.join(binary_name(os));
    fs::copy(&node.path, &binary).map_err(|source| {
        PackagerError::io(
            format!(
                "cannot copy {} to {}",
                node.path.display(),
                binary.display()
            ),
            source,
        )
    })?;
    make_writable(&binary)?;
    if os == Os::Mac {
        run(Command::new("codesign")
            .arg("--remove-signature")
            .arg(&binary))?;
    }
    log("injecting the blob");
    let cli = root
        .join("node_modules")
        .join("postject")
        .join("dist")
        .join("cli.js");
    run(Command::new("node").args(postject_args(os, &cli, &binary, &blob)))?;
    if os == Os::Mac {
        run(Command::new("codesign").args(["--sign", "-"]).arg(&binary))?;
    }
    if !options.skip_smoke {
        log("running smoke tests");
        smoke(&binary, &version, &work)?;
    }
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::{Os, binary_name, json_string, license_candidates, postject_args, sea_config};
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn names_the_binary_per_platform() {
        assert_eq!(binary_name(Os::Windows), "bma.exe");
        assert_eq!(binary_name(Os::Mac), "bma");
    }

    #[test]
    fn writes_a_sea_config_with_escaped_paths() {
        let config = sea_config(
            Path::new("C:\\repo\\bma.cjs"),
            Path::new("C:\\repo\\sea-prep.blob"),
        );
        assert!(config.contains("\"main\": \"C:\\\\repo\\\\bma.cjs\""));
        assert!(config.contains("\"output\": \"C:\\\\repo\\\\sea-prep.blob\""));
        assert!(config.contains("\"disableExperimentalSEAWarning\": true"));
        assert!(config.contains("\"useSnapshot\": false"));
        assert!(config.contains("\"useCodeCache\": false"));
        assert_eq!(json_string("a\"b\u{1}"), "\"a\\\"b\\u0001\"");
    }

    #[test]
    fn adds_the_macho_segment_only_on_macos() {
        let mac = postject_args(
            Os::Mac,
            Path::new("cli.js"),
            Path::new("bma"),
            Path::new("b"),
        );
        let windows = postject_args(
            Os::Windows,
            Path::new("cli.js"),
            Path::new("bma.exe"),
            Path::new("b"),
        );
        let segment = OsString::from("--macho-segment-name");
        assert!(mac.contains(&segment));
        assert!(!windows.contains(&segment));
        assert!(windows.contains(&OsString::from(
            "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
        )));
        assert_eq!(windows.get(1), Some(&OsString::from("bma.exe")));
    }

    #[test]
    fn looks_for_the_node_license_beside_and_above_the_binary() {
        let candidates =
            license_candidates(&Path::new("tool").join("x64").join("bin").join("node"));
        assert_eq!(
            candidates.first(),
            Some(&Path::new("tool").join("x64").join("bin").join("LICENSE"))
        );
        assert_eq!(
            candidates.get(1),
            Some(&Path::new("tool").join("x64").join("LICENSE"))
        );
    }
}
