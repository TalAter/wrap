struct Process {
    pid: i32,
    group: i32,
    alive: bool,
}

/// Live members of a process group, excluding zombies.
pub fn live_members_of_group(group: i32) -> Vec<i32> {
    processes()
        .into_iter()
        .filter(|process| process.group == group && process.alive)
        .map(|process| process.pid)
        .collect()
}

#[cfg(target_os = "linux")]
pub fn is_alive(pid: i32) -> bool {
    process(pid).is_some_and(|process| process.alive)
}

#[cfg(not(target_os = "linux"))]
pub fn is_alive(pid: i32) -> bool {
    processes()
        .into_iter()
        .any(|process| process.pid == pid && process.alive)
}

#[cfg(target_os = "linux")]
fn processes() -> Vec<Process> {
    std::fs::read_dir("/proc")
        .expect("read /proc to observe test processes")
        .map(|entry| entry.expect("read /proc entry"))
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<i32>().ok())
        .filter_map(process)
        .collect()
}

#[cfg(target_os = "linux")]
fn process(pid: i32) -> Option<Process> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        // Processes can disappear between listing /proc and reading stat.
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            return None;
        }
        Err(error) => panic!("cannot observe process {pid}: {error}"),
    };
    // Command names can contain spaces and closing parentheses.
    let (_, fields) = stat.rsplit_once(')').expect("process stat command");
    let mut fields = fields.split_whitespace();
    let state = fields.next().expect("process stat state");
    let group = fields
        .nth(1)
        .expect("process stat group")
        .parse()
        .expect("numeric process group");
    Some(Process {
        pid,
        group,
        alive: state != "Z",
    })
}

#[cfg(not(target_os = "linux"))]
fn processes() -> Vec<Process> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,pgid=,state="])
        .output()
        .expect("run ps to observe test processes");
    assert!(
        output.status.success(),
        "cannot observe processes: ps exited with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("ps output is UTF-8");
    assert!(!stdout.trim().is_empty(), "ps returned no processes");
    stdout
        .lines()
        .map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next().expect("ps pid").parse().expect("numeric pid");
            let group = fields
                .next()
                .expect("ps group")
                .parse()
                .expect("numeric process group");
            let state = fields.next().expect("ps state");
            Process {
                pid,
                group,
                alive: !state.starts_with('Z'),
            }
        })
        .collect()
}
