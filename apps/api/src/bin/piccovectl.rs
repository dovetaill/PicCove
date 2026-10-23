#[path = "../ctl/mod.rs"]
mod ctl;

fn main() {
    if let Err(error) = ctl::run() {
        eprintln!("操作未完成：{error:#}");
        std::process::exit(1);
    }
}
