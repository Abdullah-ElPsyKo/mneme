#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod desktop;
mod preferences;

fn main() {
    desktop::run();
}
