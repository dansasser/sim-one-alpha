use std::io;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event;
use ratatui::DefaultTerminal;
use sim_one_ratatui_tui::app::{App, AppEvent};
use sim_one_ratatui_tui::gateway::{ensure_server_running, GatewayOptions};
use sim_one_ratatui_tui::input::map_terminal_event;
use sim_one_ratatui_tui::terminal::{
    copy_to_clipboard, init_terminal, install_panic_restore_hook, restore_terminal,
};
use sim_one_ratatui_tui::ui;

fn main() -> io::Result<()> {
    let cli = CliOptions::parse(std::env::args().skip(1))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;

    if let Some(base_url) = cli.base_url.clone() {
        return run_client(
            base_url,
            false,
            cli.session_id,
            cli.session_explicit,
            cli.smoke_startup,
            || {},
        );
    }

    let mut gateway = ensure_server_running(&cli.gateway).map_err(io::Error::other)?;
    let base_url = gateway.base_url.clone();
    let started = gateway.started;
    run_client(
        base_url,
        started,
        cli.session_id,
        cli.session_explicit,
        cli.smoke_startup,
        || gateway.cleanup(),
    )
}

fn run_client(
    base_url: String,
    started: bool,
    session_id: String,
    session_explicit: bool,
    smoke_startup: bool,
    mut cleanup: impl FnMut(),
) -> io::Result<()> {
    if smoke_startup {
        println!("gateway ready at {} (started: {})", base_url, started);
        cleanup();
        return Ok(());
    }

    if std::env::var("SIM_ONE_TUI_EXIT_AFTER_STARTUP").as_deref() == Ok("1") {
        println!("gateway ready at {} (started: {})", base_url, started);
        cleanup();
        return Ok(());
    }

    if std::env::var("SIM_ONE_TUI_TEST_STARTUP").as_deref() == Ok("1") {
        let result = run_scripted_startup(
            format!("{} started:{}", base_url, started),
            base_url,
            session_id,
            session_explicit,
        );
        cleanup();
        return result;
    }

    if let Ok(prompts) = std::env::var("SIM_ONE_TUI_TEST_PROMPTS") {
        let result = run_scripted_prompts(
            format!("{} started:{}", base_url, started),
            base_url,
            session_id,
            session_explicit,
            &prompts,
        );
        cleanup();
        return result;
    }

    if let Ok(prompt) = std::env::var("SIM_ONE_TUI_TEST_PROMPT") {
        let result = run_scripted_prompts(
            format!("{} started:{}", base_url, started),
            base_url,
            session_id,
            session_explicit,
            &prompt,
        );
        cleanup();
        return result;
    }

    install_panic_restore_hook();
    let terminal = init_terminal();
    let result = run(
        terminal,
        format!("{} started:{}", base_url, started),
        base_url,
        session_id,
        session_explicit,
    );
    restore_terminal();
    if let Ok(Some(session_id)) = &result {
        println!("Exited SIM-ONE Alpha TUI. Session: {session_id}");
    }
    cleanup();
    result.map(|_| ())
}

fn run(
    mut terminal: DefaultTerminal,
    gateway_status: String,
    base_url: String,
    session_id: String,
    session_explicit: bool,
) -> io::Result<Option<String>> {
    let mut app = App::with_session("", gateway_status, base_url);
    start_app_lifecycle(&mut app, session_id, session_explicit, true);

    while !app.should_quit() {
        app.tick();
        app.poll_stream();
        app.poll_agent();
        terminal.draw(|frame| ui::render(frame, &mut app))?;
        if let Some(app_event) = read_app_event()? {
            app.handle_event(app_event);
            if let Some(text) = app.take_clipboard_text() {
                let _ = copy_to_clipboard(&text);
            }
        }
    }

    Ok(app.exit_session_id().map(str::to_string))
}

fn run_scripted_startup(
    gateway_status: String,
    base_url: String,
    session_id: String,
    session_explicit: bool,
) -> io::Result<()> {
    let mut app = App::with_session("", gateway_status, base_url);
    start_app_lifecycle(&mut app, session_id, session_explicit, true);
    wait_for_scripted_startup(&mut app)?;

    for line in app.transcript_lines() {
        println!("{line}");
    }
    println!("{}", app.transcript_header_title());
    println!("{}", app.status_text());

    Ok(())
}

fn run_scripted_prompts(
    gateway_status: String,
    base_url: String,
    session_id: String,
    session_explicit: bool,
    prompts: &str,
) -> io::Result<()> {
    let mut app = App::with_session("", gateway_status, base_url);
    start_app_lifecycle(&mut app, session_id, session_explicit, true);
    wait_for_scripted_startup(&mut app)?;

    for prompt in prompts
        .lines()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        app.handle_event(AppEvent::Text(prompt.to_string()));
        app.handle_event(AppEvent::Submit);
        wait_for_scripted_prompt(&mut app)?;
        if app.should_quit() {
            break;
        }
    }

    for line in app.transcript_lines() {
        println!("{line}");
    }
    println!("{}", app.transcript_header_title());
    println!("{}", app.status_text());
    if let Some(session_id) = app.exit_session_id() {
        println!("Exited SIM-ONE Alpha TUI. Session: {session_id}");
    }

    Ok(())
}

fn start_app_lifecycle(
    app: &mut App,
    session_id: String,
    session_explicit: bool,
    attach_stream: bool,
) {
    if session_explicit {
        app.start_explicit_resume(session_id, attach_stream);
    } else {
        app.start_startup_preflight(attach_stream);
    }
}

fn wait_for_scripted_prompt(app: &mut App) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(300);
    while app.is_agent_pending() && Instant::now() < deadline {
        app.tick();
        app.poll_agent();
        thread::sleep(Duration::from_millis(20));
    }
    app.poll_agent();

    if app.is_agent_pending() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Timed out waiting for scripted TUI prompt to finish.",
        ));
    }

    Ok(())
}

fn wait_for_scripted_startup(app: &mut App) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(300);
    while (!app.startup_complete() || app.is_agent_pending()) && Instant::now() < deadline {
        app.tick();
        app.poll_stream();
        app.poll_agent();
        thread::sleep(Duration::from_millis(20));
    }
    app.poll_stream();
    app.poll_agent();

    if !app.startup_complete() || app.is_agent_pending() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Timed out waiting for scripted TUI startup preflight to finish.",
        ));
    }

    if !app.startup_succeeded() {
        return Err(io::Error::other(
            "Scripted TUI startup preflight failed. See the transcript error above.",
        ));
    }

    Ok(())
}

fn read_app_event() -> io::Result<Option<AppEvent>> {
    if !event::poll(Duration::from_millis(100))? {
        return Ok(None);
    }

    Ok(map_terminal_event(event::read()?))
}

#[derive(Debug, Default)]
struct CliOptions {
    gateway: GatewayOptions,
    base_url: Option<String>,
    session_id: String,
    session_explicit: bool,
    smoke_startup: bool,
}

impl CliOptions {
    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut options = Self::default();
        let mut args = args.into_iter();

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--smoke-startup" => options.smoke_startup = true,
                "--port" => {
                    let value = args.next().ok_or("--port requires a value")?;
                    let port = value
                        .parse::<u16>()
                        .map_err(|_| format!("Invalid port: {value}"))?;
                    if port == 0 {
                        return Err("--port must be between 1 and 65535".to_string());
                    }
                    options.gateway.port = Some(port);
                }
                "--base-url" => {
                    let value = args.next().ok_or("--base-url requires a value")?;
                    if value.trim().is_empty() {
                        return Err("--base-url requires a non-empty value".to_string());
                    }
                    options.base_url = Some(value);
                }
                "--session" => {
                    let value = args.next().ok_or("--session requires a value")?;
                    if value.trim().is_empty() {
                        return Err("--session requires a non-empty value".to_string());
                    }
                    options.session_id = value;
                    options.session_explicit = true;
                }
                "--server-path" => {
                    let value = args.next().ok_or("--server-path requires a value")?;
                    options.gateway.server_path = Some(PathBuf::from(value));
                }
                "--env-path" => {
                    let value = args.next().ok_or("--env-path requires a value")?;
                    options.gateway.env_path = Some(PathBuf::from(value));
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => return Err(format!("Unknown argument: {other}")),
            }
        }

        Ok(options)
    }
}

fn print_help() {
    println!(
        "SIM-ONE Alpha Ratatui TUI\n\nOptions:\n  --port <number>       Gateway port\n  --base-url <url>      Existing gateway base URL; skips server launch\n  --session <id>        Explicit existing agent session id to attach\n  --server-path <path>  Built SIM-ONE Alpha server.mjs path\n  --env-path <path>     Env file path\n  --smoke-startup       Start/connect gateway then exit\n  -h, --help            Show this help"
    );
}

#[cfg(test)]
mod tests {
    use super::CliOptions;

    #[test]
    fn default_cli_launch_has_no_session_and_uses_fresh_lifecycle() {
        let options = CliOptions::parse(Vec::<String>::new()).expect("default CLI should parse");

        assert!(options.session_id.is_empty());
        assert!(!options.session_explicit);
    }

    #[test]
    fn explicit_session_cli_launch_preserves_requested_id() {
        let options = CliOptions::parse(["--session".to_string(), "tui-existing-1".to_string()])
            .expect("explicit session CLI should parse");

        assert_eq!(options.session_id, "tui-existing-1");
        assert!(options.session_explicit);
    }
}
