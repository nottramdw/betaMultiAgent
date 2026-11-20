use std::process::ExitCode;

fn version_line() -> String {
    format!("bma-packager {}", env!("CARGO_PKG_VERSION"))
}

fn main() -> ExitCode {
    println!("{}", version_line());
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::version_line;

    #[test]
    fn version_line_names_the_binary() {
        assert!(version_line().starts_with("bma-packager "));
    }
}
