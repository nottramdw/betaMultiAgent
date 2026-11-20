use crate::error::PackagerError;
use crate::process::{run, text};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const DIST_URL: &str = "https://nodejs.org/dist";
pub const SHASUMS: &str = "SHASUMS256.txt";
pub const SIGNATURE: &str = "SHASUMS256.txt.sig";
pub const RELEASE_KEYS: &str = "scripts/keys/node-release-keys.asc";
const GNUPG_HOME: &str = "gnupg";
const KEYS_COPY: &str = "release-keys.asc";

const HASH_SCRIPT: &str = "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRelease {
    pub version: String,
    pub platform: String,
    pub arch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeBinary {
    pub path: PathBuf,
    pub license: PathBuf,
    pub version: String,
}

pub fn archive_stem(release: &NodeRelease) -> Result<String, PackagerError> {
    let platform = match release.platform.as_str() {
        "win32" => "win",
        "darwin" => "darwin",
        "linux" => "linux",
        other => {
            return Err(PackagerError::Usage(format!(
                "no official Node.js archive for platform {other}"
            )));
        }
    };
    Ok(format!(
        "node-{}-{platform}-{}",
        release.version, release.arch
    ))
}

pub fn archive_name(release: &NodeRelease) -> Result<String, PackagerError> {
    let stem = archive_stem(release)?;
    let extension = if release.platform == "win32" {
        "zip"
    } else {
        "tar.gz"
    };
    Ok(format!("{stem}.{extension}"))
}

pub fn binary_in_archive(
    release: &NodeRelease,
    extracted: &Path,
) -> Result<PathBuf, PackagerError> {
    let top = extracted.join(archive_stem(release)?);
    Ok(if release.platform == "win32" {
        top.join("node.exe")
    } else {
        top.join("bin").join("node")
    })
}

pub fn expected_sha256(shasums: &str, file: &str) -> Result<String, PackagerError> {
    for line in shasums.lines() {
        let mut fields = line.split_whitespace();
        if let (Some(hash), Some(name), None) = (fields.next(), fields.next(), fields.next())
            && name == file
        {
            if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return Ok(hash.to_ascii_lowercase());
            }
            return Err(PackagerError::Verification(format!(
                "{SHASUMS} has a malformed hash for {file}"
            )));
        }
    }
    Err(PackagerError::Verification(format!(
        "{SHASUMS} has no entry for {file}"
    )))
}

pub fn check_sha256(shasums: &str, file: &str, actual: &str) -> Result<(), PackagerError> {
    let expected = expected_sha256(shasums, file)?;
    if expected == actual.trim().to_ascii_lowercase() {
        Ok(())
    } else {
        Err(PackagerError::Verification(format!(
            "{file} has SHA-256 {actual}, but {SHASUMS} lists {expected}"
        )))
    }
}

fn download(url: &str, target: &Path) -> Result<(), PackagerError> {
    run(Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--retry",
            "3",
            "--output",
        ])
        .arg(target)
        .arg(url))?;
    Ok(())
}

fn tar_program() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("tar.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("tar"))
}

fn sha256_of(node: &Path, file: &Path) -> Result<String, PackagerError> {
    let output = run(Command::new(node).arg("-e").arg(HASH_SCRIPT).arg(file))?;
    Ok(text(&output.stdout))
}

pub fn gpg_import_args() -> [&'static str; 6] {
    [
        "--homedir",
        GNUPG_HOME,
        "--batch",
        "--quiet",
        "--import",
        KEYS_COPY,
    ]
}

pub fn gpg_verify_args() -> [&'static str; 6] {
    [
        "--homedir",
        GNUPG_HOME,
        "--batch",
        "--verify",
        SIGNATURE,
        SHASUMS,
    ]
}

fn verify_signature(gpg: &str, keys: &Path, dir: &Path) -> Result<(), PackagerError> {
    let home = dir.join(GNUPG_HOME);
    fs::create_dir_all(&home)
        .map_err(|source| PackagerError::io(format!("cannot create {}", home.display()), source))?;
    fs::copy(keys, dir.join(KEYS_COPY))
        .map_err(|source| PackagerError::io(format!("cannot read {}", keys.display()), source))?;
    run(Command::new(gpg).args(gpg_import_args()).current_dir(dir))?;
    run(Command::new(gpg).args(gpg_verify_args()).current_dir(dir)).map_err(|error| {
        PackagerError::Verification(format!("{SIGNATURE} does not verify: {error}"))
    })?;
    Ok(())
}

pub fn fetch_official(
    root: &Path,
    work: &Path,
    host_node: &Path,
    release: &NodeRelease,
    gpg: &str,
) -> Result<NodeBinary, PackagerError> {
    let dir = work.join("node-dist");
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|source| {
            PackagerError::io(format!("cannot clear {}", dir.display()), source)
        })?;
    }
    fs::create_dir_all(&dir)
        .map_err(|source| PackagerError::io(format!("cannot create {}", dir.display()), source))?;
    let base = format!("{DIST_URL}/{}", release.version);
    let archive = archive_name(release)?;
    download(&format!("{base}/{SHASUMS}"), &dir.join(SHASUMS))?;
    download(&format!("{base}/{SIGNATURE}"), &dir.join(SIGNATURE))?;
    verify_signature(gpg, &root.join(RELEASE_KEYS), &dir)?;
    let shasums = fs::read_to_string(dir.join(SHASUMS))
        .map_err(|source| PackagerError::io(format!("cannot read {SHASUMS}"), source))?;
    expected_sha256(&shasums, &archive)?;
    let archive_path = dir.join(&archive);
    download(&format!("{base}/{archive}"), &archive_path)?;
    check_sha256(&shasums, &archive, &sha256_of(host_node, &archive_path)?)?;
    run(Command::new(tar_program())
        .arg("-xf")
        .arg(&archive_path)
        .arg("-C")
        .arg(&dir))?;
    let path = binary_in_archive(release, &dir)?;
    let license = dir.join(archive_stem(release)?).join("LICENSE");
    for required in [&path, &license] {
        if !required.is_file() {
            return Err(PackagerError::Verification(format!(
                "{archive} does not contain {}",
                required.display()
            )));
        }
    }
    Ok(NodeBinary {
        path,
        license,
        version: release.version.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        NodeRelease, archive_name, binary_in_archive, check_sha256, expected_sha256,
        gpg_import_args, gpg_verify_args,
    };
    use std::path::Path;

    #[test]
    fn passes_only_relative_paths_to_gpg() {
        for arg in gpg_import_args().iter().chain(gpg_verify_args().iter()) {
            assert!(!arg.contains(':') && !arg.starts_with('/') && !arg.contains('\\'));
        }
        assert_eq!(gpg_verify_args().get(4), Some(&"SHASUMS256.txt.sig"));
    }

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn release(platform: &str, arch: &str) -> NodeRelease {
        NodeRelease {
            version: "v22.23.4".to_owned(),
            platform: platform.to_owned(),
            arch: arch.to_owned(),
        }
    }

    #[test]
    fn names_official_archives_per_platform() {
        assert_eq!(
            archive_name(&release("win32", "x64")).ok().as_deref(),
            Some("node-v22.23.4-win-x64.zip")
        );
        assert_eq!(
            archive_name(&release("darwin", "arm64")).ok().as_deref(),
            Some("node-v22.23.4-darwin-arm64.tar.gz")
        );
        assert!(archive_name(&release("aix", "ppc64")).is_err());
        assert_eq!(
            binary_in_archive(&release("darwin", "arm64"), Path::new("d")).ok(),
            Some(
                Path::new("d")
                    .join("node-v22.23.4-darwin-arm64")
                    .join("bin")
                    .join("node")
            )
        );
        assert_eq!(
            binary_in_archive(&release("win32", "x64"), Path::new("d")).ok(),
            Some(
                Path::new("d")
                    .join("node-v22.23.4-win-x64")
                    .join("node.exe")
            )
        );
    }

    #[test]
    fn finds_the_exact_archive_entry() {
        let shasums = format!(
            "{HASH}  node-v22.23.4-win-x64.zip.extra\n{}  node-v22.23.4-win-x64.zip\n",
            HASH.to_ascii_uppercase()
        );
        assert_eq!(
            expected_sha256(&shasums, "node-v22.23.4-win-x64.zip")
                .ok()
                .as_deref(),
            Some(HASH)
        );
        assert!(expected_sha256(&shasums, "node-v22.23.4-linux-x64.tar.gz").is_err());
        assert!(expected_sha256("xyz  a.zip\n", "a.zip").is_err());
    }

    #[test]
    fn rejects_a_mismatched_hash() {
        let shasums = format!("{HASH}  a.zip\n");
        assert!(check_sha256(&shasums, "a.zip", HASH).is_ok());
        let wrong = HASH.replace('0', "f");
        let error = check_sha256(&shasums, "a.zip", &wrong)
            .err()
            .map(|e| e.to_string());
        assert!(error.is_some_and(|message| message.contains("verification failed")));
    }
}
