use crate::error::PackagerError;
use std::io::Write;
use std::process::{Command, Output, Stdio};

const DETAIL_CHARS: usize = 4000;

pub fn describe(command: &Command) -> String {
    let mut parts = vec![command.get_program().to_string_lossy().into_owned()];
    parts.extend(
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned()),
    );
    parts.join(" ")
}

pub fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

fn tail(value: &str) -> String {
    let count = value.chars().count();
    value
        .chars()
        .skip(count.saturating_sub(DETAIL_CHARS))
        .collect()
}

fn checked(label: String, output: Output) -> Result<Output, PackagerError> {
    if output.status.success() {
        return Ok(output);
    }
    let status = output.status.code().map_or_else(
        || "terminated by a signal".to_owned(),
        |code| format!("exit code {code}"),
    );
    let mut detail = status;
    for stream in [&output.stderr, &output.stdout] {
        let message = text(stream);
        if !message.is_empty() {
            detail.push('\n');
            detail.push_str(&tail(&message));
        }
    }
    Err(PackagerError::Command {
        command: label,
        detail,
    })
}

pub fn run(command: &mut Command) -> Result<Output, PackagerError> {
    let label = describe(command);
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|source| PackagerError::io(format!("cannot start {label}"), source))?;
    checked(label, output)
}

pub fn run_with_input(command: &mut Command, input: &[u8]) -> Result<Output, PackagerError> {
    let label = describe(command);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|source| PackagerError::io(format!("cannot start {label}"), source))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|source| PackagerError::io(format!("cannot write to {label}"), source))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|source| PackagerError::io(format!("cannot wait for {label}"), source))?;
    checked(label, output)
}

#[cfg(test)]
mod tests {
    use super::{describe, tail, text};
    use std::process::Command;

    #[test]
    fn describes_program_and_arguments() {
        let mut command = Command::new("node");
        command.args(["--version", "a b"]);
        assert_eq!(describe(&command), "node --version a b");
    }

    #[test]
    fn keeps_the_end_of_long_output() {
        let long = format!("{}end", "x".repeat(5000));
        let kept = tail(&long);
        assert_eq!(kept.chars().count(), 4000);
        assert!(kept.ends_with("end"));
        assert_eq!(text(b"  v22\r\n"), "v22");
    }
}
