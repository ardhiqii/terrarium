// Release builds run without a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    terrarium_desktop_lib::run()
}
