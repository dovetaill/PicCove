use super::*;
use std::io::IsTerminal;

pub(super) enum Key {
    Up,
    Down,
    Enter,
    Character(u8),
    Ignore,
    Exit,
}

// Restore the caller's terminal on every return, including errors and interrupts.
pub(super) struct Terminal(libc::termios);

impl Terminal {
    pub(super) fn open() -> Result<Self> {
        ensure!(
            io::stdin().is_terminal() && io::stdout().is_terminal(),
            "菜单需要交互终端；脚本请指定子命令"
        );
        let mut saved = std::mem::MaybeUninit::uninit();
        ensure!(
            unsafe { libc::tcgetattr(0, saved.as_mut_ptr()) } == 0,
            "无法读取终端设置"
        );
        let saved = unsafe { saved.assume_init() };
        let mut mode = saved;
        mode.c_lflag &= !(libc::ICANON | libc::ECHO | libc::ECHONL);
        mode.c_cc[libc::VMIN] = 1;
        mode.c_cc[libc::VTIME] = 0;
        ensure!(
            unsafe { libc::tcsetattr(0, libc::TCSANOW, &mode) } == 0,
            "无法设置终端输入"
        );
        let terminal = Self(saved);
        print!("\x1b[?25l");
        io::stdout().flush()?;
        Ok(terminal)
    }

    fn byte(&self, cancelled: &AtomicBool, timeout: i32) -> Result<Option<u8>> {
        let mut fd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        if cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let ready = unsafe { libc::poll(&mut fd, 1, timeout) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                return Ok(None);
            }
            return Err(error.into());
        }
        if ready == 0 {
            return Ok(None);
        }
        ensure!(
            fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) == 0,
            "终端连接已关闭"
        );
        let mut byte = 0;
        match unsafe { libc::read(0, &mut byte as *mut u8 as *mut libc::c_void, 1) } {
            1 => Ok(Some(byte)),
            0 => bail!("终端输入已关闭"),
            _ => Err(io::Error::last_os_error().into()),
        }
    }

    pub(super) fn key(&self, cancelled: &AtomicBool) -> Result<Key> {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(Key::Exit);
            }
            let Some(byte) = self.byte(cancelled, 100)? else {
                continue;
            };
            return Ok(match byte {
                3 | 4 => Key::Exit,
                b'\r' | b'\n' => Key::Enter,
                27 => {
                    // Consume the entire escape sequence so arrows never leak into prompts.
                    match self.byte(cancelled, 100)? {
                        Some(b'[' | b'O') => {
                            let mut final_byte = None;
                            for _ in 0..32 {
                                match self.byte(cancelled, 100)? {
                                    Some(b) if (0x40..=0x7e).contains(&b) => {
                                        final_byte = Some(b);
                                        break;
                                    }
                                    Some(_) => (),
                                    None => break,
                                }
                            }
                            match final_byte {
                                Some(b'A') => Key::Up,
                                Some(b'B') => Key::Down,
                                _ => Key::Ignore,
                            }
                        }
                        _ => Key::Ignore,
                    }
                }
                b => Key::Character(b),
            });
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &self.0);
        }
        let _ = write!(io::stdout(), "\x1b[0m\x1b[?25h");
        let _ = io::stdout().flush();
    }
}

pub(super) const ITEMS: [(&str, &str); 9] = [
    ("status", "查看服务状态"),
    ("start", "启动服务"),
    ("stop", "停止服务"),
    ("restart", "重启应用"),
    ("logs", "查看最近日志"),
    ("health", "检查网站与资源"),
    ("backup", "手动备份数据"),
    ("update", "更新到最新稳定版"),
    ("", "退出"),
];

pub(super) fn select(
    rt: &Runtime,
    root: &Path,
    installed: &str,
    status: &str,
    selected: &mut usize,
) -> Result<Option<usize>> {
    let terminal = Terminal::open()?;
    loop {
        print!("\x1b[2J\x1b[H\x1b[1;36m  PicCove · 运维管理\x1b[0m\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        println!("  版本  {installed}\n  目录  {}", root.display());
        println!("{status}");
        for (index, (_, label)) in ITEMS.iter().enumerate() {
            if index == 0 {
                println!("\x1b[36m  服务管理\x1b[0m");
            }
            if index == 4 {
                println!("\x1b[36m  诊断与维护\x1b[0m");
            }
            let number = (index + 1) % 9;
            if index == *selected {
                println!("\x1b[1;7m  ❯ {number}. {label}  \x1b[0m");
            } else {
                println!("    {number}. {label}");
            }
        }
        println!("  ↑↓ 选择 · Enter 执行 · 数字快捷键\n  q / Ctrl+C 退出");
        io::stdout().flush()?;
        match terminal.key(&rt.cancelled)? {
            Key::Up => *selected = (*selected + ITEMS.len() - 1) % ITEMS.len(),
            Key::Down => *selected = (*selected + 1) % ITEMS.len(),
            Key::Enter => return Ok((*selected != 8).then_some(*selected)),
            Key::Character(number @ b'1'..=b'8') => {
                *selected = (number - b'1') as usize;
                return Ok(Some(*selected));
            }
            Key::Exit | Key::Character(b'0' | b'q' | b'Q') => return Ok(None),
            _ => continue,
        }
    }
}
