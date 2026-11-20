mod args;
mod error;
mod node_dist;
mod process;
mod steps;

use std::process::ExitCode;

fn version_line() -> String {
    format!("bma-packager {}", env!("CARGO_PKG_VERSION"))
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match args::parse(&argv) {
        Ok(args::Command::Help) => {
            println!("{}", args::USAGE);
            ExitCode::SUCCESS
        }
        Ok(args::Command::Version) => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Ok(args::Command::Build(options)) => match steps::build(&options) {
            Ok(binary) => {
                println!("{}", binary.display());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("bma-packager: {error}");
                error.exit_code()
            }
        },
        Err(error) => {
            eprintln!("bma-packager: {error}\n\n{}", args::USAGE);
            error.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::version_line;

    #[test]
    fn version_line_names_the_binary() {
        assert!(version_line().starts_with("bma-packager "));
    }
}
