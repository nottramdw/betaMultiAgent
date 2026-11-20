use std::fmt;
use std::io;
use std::process::ExitCode;

#[derive(Debug)]
pub enum PackagerError {
    Usage(String),
    Io { context: String, source: io::Error },
    Command { command: String, detail: String },
    Verification(String),
    Smoke(String),
}

impl PackagerError {
    pub fn io(context: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    pub fn exit_code(&self) -> ExitCode {
        match self {
            Self::Usage(_) => ExitCode::from(2),
            _ => ExitCode::from(1),
        }
    }
}

impl fmt::Display for PackagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(message) => write!(formatter, "{message}"),
            Self::Io { context, source } => write!(formatter, "{context}: {source}"),
            Self::Command { command, detail } => write!(formatter, "{command} failed: {detail}"),
            Self::Verification(message) => write!(formatter, "verification failed: {message}"),
            Self::Smoke(message) => write!(formatter, "smoke test failed: {message}"),
        }
    }
}

impl std::error::Error for PackagerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PackagerError;
    use std::process::ExitCode;

    #[test]
    fn usage_errors_exit_with_two() {
        assert_eq!(
            PackagerError::Usage("x".to_owned()).exit_code(),
            ExitCode::from(2)
        );
        assert_eq!(
            PackagerError::Smoke("x".to_owned()).exit_code(),
            ExitCode::from(1)
        );
    }

    #[test]
    fn io_errors_name_their_context() {
        let error = PackagerError::io("cannot read x", std::io::Error::other("denied"));
        assert_eq!(error.to_string(), "cannot read x: denied");
    }
}
