use std::io;
use std::path::PathBuf;
use std::time::Duration;

use crossterm::event;
use ratatui::DefaultTerminal;
use sim_one_ratatui_tui::agent::send_agent_prompt;
use sim_one_ratatui_tui::app::{App, AppEvent};
use sim_one_ratatui_tui::gateway::{ensure_server_running, GatewayOptions};
use sim_one_ratatui_tui::input::map_terminal_event;
use sim_one_ratatui_tui::terminal::{init_terminal, install_panic_restore_hook, restore_terminal};
use sim_one_ratatui_tui::ui;

fn main() -> io::Result<()> {
    let cli = CliOptions::parse(std::env::args().skip(1))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let mut gateway = ensure_server_running(&cli.gateway).map_err(io::Error::other)?;

    if cli.smoke_startup {
        println!(
            "gateway ready at {} (started: {})",
            gateway.base_url, gateway.started
        );
        gateway.cleanup();
        return Ok(());
    }

    if std::env::var("SIM_ONE_TUI_EXIT_AFTER_STARTUP").as_deref() == Ok("1") {
        println!(
            "gateway ready at {} (started: {})",
            gateway.base_url, gateway.started
        );
        gateway.cleanup();
        return Ok(());
    }

    if let Ok(prompt) = std::env::var("SIM_ONE_TUI_TEST_PROMPT") {
        let response = send_agent_prompt(&gateway.base_url, "ratatui-product-e2e", &prompt)
            .map_err(io::Error::other)?;
        println!("assistant response: {response}");
        gateway.cleanup();
        return Ok(());
    }

    install_panic_restore_hook();
    let terminal = init_terminal();
    let result = run(
        terminal,
        format!("{} started:{}", gateway.base_url, gateway.started),
        gateway.base_url.clone(),
    );
    restore_terminal();
    gateway.cleanup();
    result
}

fn run(mut terminal: DefaultTerminal, gateway_status: String, base_url: String) -> io::Result<()> {
    let mut app = App::new(gateway_status, base_url);
    app.start_stream();

    while !app.should_quit() {
        app.tick();
        app.poll_stream();
        app.poll_agent();
        terminal.draw(|frame| ui::render(frame, &mut app))?;
        if let Some(app_event) = read_app_event()? {
            app.handle_event(app_event);
        }
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
        "SIM-ONE Alpha Ratatui TUI\n\nOptions:\n  --port <number>       Gateway port\n  --server-path <path>  Built SIM-ONE Alpha server.mjs path\n  --env-path <path>     Env file path\n  --smoke-startup       Start/connect gateway then exit\n  -h, --help            Show this help"
    );
}
