use crate::error::PackagerError;
use std::path::PathBuf;

pub const USAGE: &str = "usage: bma-packager build [--out <dir>] [--root <dir>] [--node <path> | --official-node] [--node-license <path>] [--gpg <program>] [--skip-smoke]

  --out <dir>             output directory (default <root>/dist/bin)
  --root <dir>            repository root (default current directory)
  --node <path>           Node.js binary to embed (default: the node on PATH)
  --official-node         download the official Node.js release matching the node on PATH
                          and verify SHASUMS256.txt with the pinned release keys
  --node-license <path>   Node.js LICENSE file (default: found next to the binary)
  --gpg <program>         gpg executable for --official-node (default gpg)
  --skip-smoke            do not run the built binary";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeSource {
    Current,
    Path(PathBuf),
    Official,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildOptions {
    pub root: PathBuf,
    pub out: PathBuf,
    pub node: NodeSource,
    pub node_license: Option<PathBuf>,
    pub gpg: String,
    pub skip_smoke: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Build(BuildOptions),
}

fn value<'a>(
    iter: &mut impl Iterator<Item = &'a String>,
    flag: &str,
) -> Result<&'a str, PackagerError> {
    iter.next()
        .map(String::as_str)
        .ok_or_else(|| PackagerError::Usage(format!("{flag} needs a value")))
}

fn set_node(current: &NodeSource, next: NodeSource) -> Result<NodeSource, PackagerError> {
    if *current == NodeSource::Current {
        Ok(next)
    } else {
        Err(PackagerError::Usage(
            "--node and --official-node can be given only once and not together".to_owned(),
        ))
    }
}

pub fn parse(argv: &[String]) -> Result<Command, PackagerError> {
    let mut iter = argv.iter();
    match iter.next().map(String::as_str) {
        None | Some("--help" | "-h" | "help") => return Ok(Command::Help),
        Some("--version" | "-V") => return Ok(Command::Version),
        Some("build") => {}
        Some(other) => return Err(PackagerError::Usage(format!("unknown command {other}"))),
    }
    let mut root = None;
    let mut out = None;
    let mut node = NodeSource::Current;
    let mut node_license = None;
    let mut gpg = None;
    let mut skip_smoke = false;
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--out" => out = Some(PathBuf::from(value(&mut iter, flag)?)),
            "--root" => root = Some(PathBuf::from(value(&mut iter, flag)?)),
            "--node" => {
                node = set_node(
                    &node,
                    NodeSource::Path(PathBuf::from(value(&mut iter, flag)?)),
                )?;
            }
            "--official-node" => node = set_node(&node, NodeSource::Official)?,
            "--node-license" => node_license = Some(PathBuf::from(value(&mut iter, flag)?)),
            "--gpg" => gpg = Some(value(&mut iter, flag)?.to_owned()),
            "--skip-smoke" => skip_smoke = true,
            "--help" | "-h" => return Ok(Command::Help),
            other => return Err(PackagerError::Usage(format!("unknown option {other}"))),
        }
    }
    let root = root.unwrap_or_else(|| PathBuf::from("."));
    let out = out.unwrap_or_else(|| root.join("dist").join("bin"));
    Ok(Command::Build(BuildOptions {
        root,
        out,
        node,
        node_license,
        gpg: gpg.unwrap_or_else(|| "gpg".to_owned()),
        skip_smoke,
    }))
}

#[cfg(test)]
mod tests {
    use super::{BuildOptions, Command, NodeSource, parse};
    use std::path::PathBuf;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn defaults_build_options() {
        let parsed = parse(&argv(&["build"])).ok();
        assert_eq!(
            parsed,
            Some(Command::Build(BuildOptions {
                root: PathBuf::from("."),
                out: PathBuf::from(".").join("dist").join("bin"),
                node: NodeSource::Current,
                node_license: None,
                gpg: "gpg".to_owned(),
                skip_smoke: false,
            }))
        );
    }

    #[test]
    fn parses_every_option() {
        let parsed = parse(&argv(&[
            "build",
            "--out",
            "o",
            "--root",
            "r",
            "--official-node",
            "--node-license",
            "L",
            "--gpg",
            "g",
            "--skip-smoke",
        ]))
        .ok();
        assert_eq!(
            parsed,
            Some(Command::Build(BuildOptions {
                root: PathBuf::from("r"),
                out: PathBuf::from("o"),
                node: NodeSource::Official,
                node_license: Some(PathBuf::from("L")),
                gpg: "g".to_owned(),
                skip_smoke: true,
            }))
        );
    }

    #[test]
    fn rejects_conflicting_and_unknown_options() {
        assert!(parse(&argv(&["build", "--node", "n", "--official-node"])).is_err());
        assert!(parse(&argv(&["build", "--out"])).is_err());
        assert!(parse(&argv(&["build", "--fast"])).is_err());
        assert!(parse(&argv(&["ship"])).is_err());
        assert_eq!(parse(&argv(&[])).ok(), Some(Command::Help));
        assert_eq!(parse(&argv(&["--version"])).ok(), Some(Command::Version));
    }
}
